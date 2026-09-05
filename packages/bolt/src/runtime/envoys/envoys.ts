import { Clock, Context, Effect, Layer, Option, Schema } from 'effect';
import { Prompt } from 'effect/unstable/ai';
import { EffectId } from '@norbital-ai/bolt-protocol';
import {
	AgentId,
	DirectiveMode,
	DirectivePriority,
	ImageAsset,
	type TaskId
} from '@norbital-ai/bolt-protocol/facilities';
import { getErrorMessage } from '@norbital-ai/std';
import { decodeNumber } from '@norbital-ai/std/json';
import { and, asc, count, eq, gt, inArray } from 'drizzle-orm';
import type { EnvoyDefinition } from '#lib/authoring/contracts-schema.js';
import { SYSTEM_MODEL_TABLES } from '#lib/authoring/system-models.js';
import * as Agents from '#lib/runtime/agents/agents.js';
import * as AccessControl from '#lib/runtime/access/access-control.js';
import {
	Communication,
	Files,
	type CommunicationInterface,
	type FilesInterface
} from '#lib/runtime/facilities/services.js';
import * as Database from '#lib/runtime/facilities/database.js';
import * as Identity from '#lib/runtime/identity/identity.js';
import * as RateLimits from '#lib/runtime/rate-limits.js';
import * as TaskQueue from '#lib/runtime/tasks/tasks.js';
import * as TenantScope from '#lib/runtime/tenant.js';
import { canonicalTransportIdentity } from '#lib/runtime/envoys/transport-identity.js';
import { envoyPrincipalId, envoySubject } from '#lib/runtime/identity/static-identity.js';
import * as Workspace from '#lib/runtime/workspace.js';
import {
	composer,
	dbNow,
	dbNowPlusSeconds,
	executeBuilt,
	transactionBuilt,
	transactionSql
} from '#lib/runtime/persistence.js';

const {
	bolt_task: boltTaskTable,
	bolt_envoy_inbound: boltEnvoyInbound,
	bolt_envoy_receipts: boltEnvoyReceipts,
	bolt_channel_links: boltChannelLinks
} = SYSTEM_MODEL_TABLES;

class EnvoyError extends Schema.TaggedError<EnvoyError>()('Bolt.Envoys.Error', {
	envoy: Schema.NonEmptyString,
	message: Schema.NonEmptyString
}) {
	readonly category = 'envoy' as const;
	readonly retryable = false;
}

const EnvoyStatus = Schema.Struct({
	envoy: Schema.NonEmptyString,
	received: Schema.Number,
	replied: Schema.Number
});
interface EnvoyStatus extends Schema.Schema.Type<typeof EnvoyStatus> {}

const MAX_INBOUND_ATTACHMENTS = 8;
const MAX_INBOUND_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_INBOUND_ATTACHMENT_BASE64_LENGTH = Math.ceil(MAX_INBOUND_ATTACHMENT_BYTES / 3) * 4;
const isObjectLike = Schema.is(
	Schema.Union([Schema.Record(Schema.String, Schema.Unknown), Schema.Array(Schema.Unknown)])
);
const isString = Schema.is(Schema.String);
const InboundAttachment = Schema.Struct({
	provider: Schema.NonEmptyString,
	attachmentId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
	mimeType: Schema.Literals(['image/jpeg', 'image/png']),
	fileName: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
	byteLength: Schema.Number.check(
		Schema.isInt(),
		Schema.isBetween({ minimum: 1, maximum: MAX_INBOUND_ATTACHMENT_BYTES })
	),
	bytesBase64: Schema.String.check(
		Schema.isMinLength(1),
		Schema.isMaxLength(MAX_INBOUND_ATTACHMENT_BASE64_LENGTH),
		Schema.isPattern(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
	)
});

/** One message a host took off a transport, containing wire facts and no claimed authority. */
export const EnvoyDelivery = Schema.Struct({
	conversationId: Schema.NonEmptyString,
	conversationKind: Schema.Literals(['dm', 'group']),
	messageId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
	sentAt: Schema.String.check(
		Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/)
	),
	invocation: Schema.Literals(['direct', 'mention', 'reply', 'ambient']),
	text: Schema.String,
	attachments: Schema.Array(InboundAttachment).check(
		Schema.makeFilter(
			(attachments) =>
				attachments.length <= MAX_INBOUND_ATTACHMENTS ||
				`at most ${MAX_INBOUND_ATTACHMENTS} inbound attachments are accepted`
		)
	),
	sender: Schema.optionalKey(
		Schema.Struct({
			id: Schema.NonEmptyString,
			displayName: Schema.optionalKey(Schema.NonEmptyString)
		})
	)
});
export interface EnvoyDelivery extends Schema.Schema.Type<typeof EnvoyDelivery> {}

const EnvoyOutcome = Schema.Struct({
	status: Schema.Literals(['buffered', 'duplicate', 'silent', 'registration_required']),
	envoy: Schema.NonEmptyString,
	conversationId: Schema.NonEmptyString,
	text: Schema.optionalKey(Schema.String)
});
interface EnvoyOutcome extends Schema.Schema.Type<typeof EnvoyOutcome> {}

type EnvoyRegistrationClaim =
	| Readonly<{
			readonly state: 'ready';
			readonly envoy: string;
			readonly transport: string;
	  }>
	| Readonly<{ readonly state: 'expired' | 'registered' | 'invalid' }>;

type EnvoyRegistrationRedemption =
	| Readonly<{
			readonly state: 'registered' | 'already_registered';
			readonly envoy: string;
			readonly transport: string;
	  }>
	| Readonly<{
			readonly state: 'expired' | 'used' | 'conflict' | 'invalid';
	  }>;

const DrainReport = Schema.Struct({
	envoy: Schema.NonEmptyString,
	conversationId: Schema.NonEmptyString,
	drained: Schema.Number,
	status: Schema.Literals(['queued', 'answered', 'failed', 'skipped'])
});
interface DrainReport extends Schema.Schema.Type<typeof DrainReport> {}

const DRAIN_DEBOUNCE_MS = 3_000;
const MAX_DRAIN_MESSAGES = 32;
const REGISTRATION_NOTICE_LIMITS = {
	'envoys.registration': [{ window: '15 minutes', limit: 1, key: 'sender' as const }]
};
const ENVOY_REGISTRATION_EXPIRES_SECONDS = 15 * 60;

const InboundRow = Schema.Struct({
	id: Schema.NonEmptyString,
	conversation_id: Schema.NonEmptyString,
	transport_conversation_id: Schema.NonEmptyString,
	external_message_id: Schema.NonEmptyString,
	sender_external_id: Schema.NullOr(Schema.String),
	sender_display_name: Schema.NullOr(Schema.String),
	sent_at: Schema.NonEmptyString,
	invocation: Schema.Literals(['direct', 'mention', 'reply', 'ambient']),
	text: Schema.String,
	attachments: Schema.Array(
		Schema.Struct({
			provider: Schema.NonEmptyString,
			attachmentId: Schema.NonEmptyString,
			asset: ImageAsset
		})
	),
	subject: Identity.Subject,
	addressed: Schema.Boolean
});
type InboundRow = Schema.Schema.Type<typeof InboundRow>;
const decodeInboundRow = Schema.decodeUnknownOption(InboundRow);
const IdRow = Schema.Struct({ id: Schema.NonEmptyString });
const decodeIdRow = Schema.decodeUnknownOption(IdRow);
const ChannelLinkRow = Schema.Struct({
	link_id: Schema.NonEmptyString,
	envoy: Schema.NonEmptyString,
	transport: Schema.NonEmptyString,
	sender_id: Schema.NonEmptyString,
	status: Schema.NonEmptyString,
	claimed_by: Schema.NullOr(Schema.String),
	expires_at: Schema.NonEmptyString
});
/** The transport address a turn in flight answers on, and the envoy that declared it. */
const ProcessingRecipient = Schema.Struct({
	id: Schema.NonEmptyString,
	envoy_name: Schema.NonEmptyString,
	transport_conversation_id: Schema.NonEmptyString
});
type EnvoyFailure =
	| EnvoyError
	| Workspace.WorkspaceLookupError
	| AccessControl.AccessDenied
	| Database.FacilityError
	| RateLimits.RateLimited;

export type Interface = Readonly<{
	readonly receive: (
		effectId: EffectId,
		envoyName: string,
		delivery: EnvoyDelivery
	) => Effect.Effect<EnvoyOutcome, EnvoyFailure>;
	/** Read-only claim probe; safe for mail scanners, link previews, and ordinary GET requests. */
	readonly inspectRegistration: (
		effectId: EffectId,
		claimId: string
	) => Effect.Effect<EnvoyRegistrationClaim, Database.FacilityError>;
	readonly redeemRegistration: (
		effectId: EffectId,
		claimId: string,
		subject: Identity.Subject
	) => Effect.Effect<EnvoyRegistrationRedemption, Database.FacilityError>;
	readonly drain: (
		effectId: EffectId,
		envoyName: string,
		conversationId: string
	) => Effect.Effect<DrainReport, EnvoyFailure>;
	readonly complete: (
		effectId: EffectId,
		envoyName: string,
		conversationId: string,
		output: Schema.Json,
		/**
		 * The provider key of this turn's progress bubble, when one is on the wire. The answer edits
		 * that bubble in place, so one conversation turn stays one message; when the edit cannot
		 * land, the answer is sent fresh — compactness never outranks the answer arriving.
		 */
		progressKey: string | null
	) => Effect.Effect<DrainReport, EnvoyError | Database.FacilityError>;
	readonly reply: (
		effectId: EffectId,
		envoyName: string,
		recipient: string,
		payload: Schema.Json
	) => Effect.Effect<void, EnvoyError | Database.FacilityError>;
	/**
	 * Posts or rewrites one compact progress note on this conversation's transport.
	 *
	 * Best effort by contract: a conversation that is not a transport one — the web agent's — has
	 * nothing in flight to post on and answers `null`, and so does a transport that refused. The
	 * returned key is the bubble to edit next; an edit that landed keeps the key it was given,
	 * because rewriting a message does not change which message it is.
	 */
	readonly progress: (
		effectId: EffectId,
		conversationId: string,
		body: string,
		updateOf: string | null
	) => Effect.Effect<string | null, EnvoyError | Database.FacilityError>;
	readonly status: (
		effectId: EffectId,
		envoyName: string
	) => Effect.Effect<EnvoyStatus, EnvoyError | Database.FacilityError>;
}>;

export const Service = Context.Service<Interface>('@norbital-ai/bolt/Envoys');

type LayerServices =
	| Workspace.Interface
	| Agents.Interface
	| Identity.Interface
	| CommunicationInterface
	| FilesInterface
	| Database.Interface
	| TaskQueue.Interface
	| RateLimits.Interface
	| AccessControl.Interface
	| TenantScope.Interface;

export const layerWith = (
	randomId: () => string = () => globalThis.crypto.randomUUID()
): Layer.Layer<Interface, never, LayerServices> =>
	Layer.effect(
		Service,
		Effect.gen(function* () {
			const workspace = yield* Workspace.Service;
			const agents = yield* Agents.Service;
			const identity = yield* Identity.Service;
			const communication = yield* Communication.Service;
			const files = yield* Files.Service;
			const database = yield* Database.Service;
			const queue = yield* TaskQueue.Service;
			const rateLimits = yield* RateLimits.Service;
			const access = yield* AccessControl.Service;
			const tenant = yield* TenantScope.Service;

			const requireEnvoy = Effect.fn('Envoys.requireEnvoy')(function* (envoyName: string) {
				const envoy = workspace.definition.envoys.find(({ name }) => name === envoyName);
				if (envoy === undefined)
					return yield* new EnvoyError({ envoy: envoyName, message: 'Unknown envoy' });
				return envoy;
			});

			const bytesOf = (base64: string): Uint8Array => {
				const binary = atob(base64);
				return Uint8Array.from(binary, (character) => character.charCodeAt(0));
			};

			const extensionOf = (fileName: string): string => {
				const candidate = fileName.includes('.')
					? fileName.slice(fileName.lastIndexOf('.') + 1)
					: '';
				return /^[a-z0-9]{1,12}$/i.test(candidate) ? `.${candidate.toLowerCase()}` : '';
			};

			const stagingAttachmentKey = (
				envoyName: string,
				conversationId: string,
				messageId: string,
				index: number,
				fileName: string
			): string =>
				[
					'envoy-inbound',
					encodeURIComponent(envoyName),
					encodeURIComponent(conversationId),
					`${encodeURIComponent(`${messageId}:${index}`)}${extensionOf(fileName)}`
				].join('/');

			const taskFailure = (envoyName: string, operation: string) =>
				Effect.mapError(
					(failure: unknown) =>
						new EnvoyError({
							envoy: envoyName,
							message: `${operation} failed: ${getErrorMessage(failure)}`
						})
				);

			/**
			 * Schedules the conversation's next drain as a durable task row, written by the runtime
			 * itself, and arms the host timer for its `run_at`.
			 */
			const enqueueDrain = Effect.fn('Envoys.enqueueDrain')(function* (
				effectId: EffectId,
				envoyName: string,
				conversationId: string,
				now: number
			) {
				const bucket = Math.floor(now / DRAIN_DEBOUNCE_MS);
				const taskId = `envoys.drain:${conversationId}:${bucket}`;
				const runAtEpochMs = now + DRAIN_DEBOUNCE_MS;
				// The host timer is armed before the row commits: a crash in between costs a false alarm,
				// never a dropped drain.
				yield* queue.wake(EffectId.make(`${effectId}:wake`), runAtEpochMs);
				yield* executeBuilt(
					effectId,
					database,
					composer
						.insert(boltTaskTable)
						.values({
							command: 'envoys.drain',
							input: JSON.stringify({ envoy: envoyName, conversationId }),
							effect_id: taskId,
							run_at: new Date(runAtEpochMs).toISOString(),
							status: 'pending'
						})
						.onConflictDoNothing({ target: boltTaskTable.effect_id })
				);
			});

			const recordReceipt = (
				effectId: EffectId,
				envoyName: string,
				conversationId: string,
				direction: 'inbound' | 'outbound',
				senderId?: string,
				receiptKey?: string
			) =>
				executeBuilt(
					effectId,
					database,
					composer
						.insert(boltEnvoyReceipts)
						.values({
							envoy_name: envoyName,
							conversation_id: conversationId,
							direction,
							sender_id: senderId ?? null,
							receipt_key: receiptKey ?? null
						})
						.onConflictDoNothing({ target: boltEnvoyReceipts.receipt_key })
				);

			const readChannelLink = Effect.fn('Envoys.readChannelLink')(function* (
				effectId: EffectId,
				claimId: string
			) {
				const result = yield* executeBuilt(
					effectId,
					database,
					composer
						.select({
							link_id: boltChannelLinks.link_id,
							envoy: boltChannelLinks.envoy,
							transport: boltChannelLinks.transport,
							sender_id: boltChannelLinks.sender_id,
							status: boltChannelLinks.status,
							claimed_by: boltChannelLinks.claimed_by,
							expires_at: boltChannelLinks.expires_at
						})
						.from(boltChannelLinks)
						.where(
							and(
								eq(boltChannelLinks.link_id, claimId),
								eq(boltChannelLinks.tenant_id, tenant.tenantId)
							)
						)
						.limit(1)
				);
				const row = result.rows[0];
				return row === undefined
					? undefined
					: yield* Schema.decodeUnknownEffect(ChannelLinkRow)(row).pipe(
							Effect.mapError(
								() =>
									new Database.FacilityError({
										operation: 'envoys.registration.inspect',
										code: 'malformed_response',
										message: 'Registration claim row was malformed',
										retryable: false,
										outcome: 'known'
									})
							)
						);
			});

			const inspectRegistration = Effect.fn('Envoys.inspectRegistration')(function* (
				effectId: EffectId,
				claimId: string
			) {
				const claim = yield* readChannelLink(effectId, claimId);
				if (claim === undefined) return { state: 'invalid' as const };
				if (claim.status === 'claimed') return { state: 'registered' as const };
				if (claim.status !== 'pending') return { state: 'invalid' as const };
				const now = yield* Clock.currentTimeMillis;
				if (Date.parse(claim.expires_at) <= now) return { state: 'expired' as const };
				return { state: 'ready' as const, envoy: claim.envoy, transport: claim.transport };
			});

			const issueRegistration = Effect.fn('Envoys.issueRegistration')(function* (
				effectId: EffectId,
				envoy: EnvoyDefinition & { readonly name: string },
				senderId: string
			) {
				const canonical = canonicalTransportIdentity(envoy.transport, senderId);
				if (canonical.length === 0) return undefined;
				const active = yield* executeBuilt(
					EffectId.make(`${effectId}:active`),
					database,
					composer
						.select({ id: boltChannelLinks.link_id })
						.from(boltChannelLinks)
						.where(
							and(
								eq(boltChannelLinks.tenant_id, tenant.tenantId),
								eq(boltChannelLinks.envoy, envoy.name),
								eq(boltChannelLinks.transport, envoy.transport),
								eq(boltChannelLinks.sender_id, canonical),
								eq(boltChannelLinks.status, 'pending'),
								gt(boltChannelLinks.expires_at, dbNow())
							)
						)
						.limit(1)
				);
				const held = decodeIdRow(active.rows[0]);
				if (held._tag === 'Some') return held.value.id;
				const claimId = randomId();
				yield* executeBuilt(
					effectId,
					database,
					composer.insert(boltChannelLinks).values({
						link_id: claimId,
						tenant_id: tenant.tenantId,
						envoy: envoy.name,
						transport: envoy.transport,
						sender_id: canonical,
						status: 'pending',
						expires_at: dbNowPlusSeconds(ENVOY_REGISTRATION_EXPIRES_SECONDS)
					})
				);
				return claimId;
			});

			const RegistrationResultRow = Schema.Struct({
				envoy: Schema.NonEmptyString,
				transport: Schema.NonEmptyString
			});
			const unavailableRegistration = Effect.fn('Envoys.unavailableRegistration')(function* (
				effectId: EffectId,
				claimId: string,
				subject: Identity.Subject
			) {
				const inspected = yield* inspectRegistration(effectId, claimId);
				if (inspected.state === 'expired') return { state: 'expired' as const };
				if (inspected.state === 'registered') return { state: 'used' as const };
				if (inspected.state === 'invalid') return { state: 'invalid' as const };
				const claim = yield* readChannelLink(EffectId.make(`${effectId}:claim`), claimId);
				if (claim === undefined) return { state: 'invalid' as const };
				const linked = yield* identity.accountByTransportIdentity(
					EffectId.make(`${effectId}:identity`),
					claim.transport,
					claim.sender_id
				);
				return linked !== undefined && linked.userId !== subject.userId
					? { state: 'conflict' as const }
					: { state: 'invalid' as const };
			});

			const redeemRegistration = Effect.fn('Envoys.redeemRegistration')(function* (
				effectId: EffectId,
				claimId: string,
				subject: Identity.Subject
			) {
				if (subject.tenantId !== tenant.tenantId) return { state: 'invalid' as const };
				const claim = yield* readChannelLink(EffectId.make(`${effectId}:claim`), claimId);
				if (claim === undefined) return { state: 'invalid' as const };
				const inspected = yield* inspectRegistration(EffectId.make(`${effectId}:inspect`), claimId);
				if (inspected.state !== 'ready') {
					return inspected.state === 'registered'
						? { state: 'used' as const }
						: { state: inspected.state };
				}
				const linked = yield* identity.accountByTransportIdentity(
					EffectId.make(`${effectId}:identity`),
					claim.transport,
					claim.sender_id
				);
				if (linked !== undefined && linked.userId !== subject.userId) {
					return { state: 'conflict' as const };
				}
				if (linked?.userId === subject.userId) {
					const claimed = yield* executeBuilt(
						effectId,
						database,
						composer
							.update(boltChannelLinks)
							.set({ status: 'claimed', claimed_by: subject.userId })
							.where(
								and(
									eq(boltChannelLinks.link_id, claimId),
									eq(boltChannelLinks.tenant_id, tenant.tenantId),
									eq(boltChannelLinks.status, 'pending'),
									gt(boltChannelLinks.expires_at, dbNow())
								)
							)
							.returning({ envoy: boltChannelLinks.envoy, transport: boltChannelLinks.transport })
					);
					const row = Schema.decodeUnknownOption(RegistrationResultRow)(claimed.rows[0]);
					return row._tag === 'Some'
						? {
								state: 'already_registered' as const,
								envoy: row.value.envoy,
								transport: row.value.transport
							}
						: yield* unavailableRegistration(
								EffectId.make(`${effectId}:unavailable`),
								claimId,
								subject
							);
				}

				const committed = yield* transactionBuilt(effectId, database, [
					transactionSql(
						`with claim as (
						select "sender_id", "transport" from "bolt_channel_links"
						where "link_id" = $1 and "tenant_id" = $2 and "status" = 'pending'
							and "expires_at" > now()
						for update
					), updated_user as (
						update "user" as target
						set "channels" = coalesce((
							select jsonb_agg(identity)
							from jsonb_array_elements(coalesce(target."channels", '[]'::jsonb)) identity
							where not (
								identity->>'type' = claim."transport"
								and identity->>'address' = claim."sender_id"
							)
						), '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
							'type', claim."transport",
							'address', claim."sender_id",
							'verified', true
						)), "updated_at" = now()
						from claim
						where target."id" = $3::uuid and target."tenantId" = $2
							and not exists (
								select 1 from "user" other,
									jsonb_array_elements(coalesce(other."channels", '[]'::jsonb)) identity
								where other."id" <> target."id" and other."tenantId" = $2
									and identity->>'type' = claim."transport"
									and identity->>'address' = claim."sender_id"
									and identity->>'verified' = 'true'
							)
						returning target."id"
					), claimed as (
						update "bolt_channel_links" link
						set "status" = 'claimed', "claimed_by" = $3
						from updated_user
						where link."link_id" = $1 and link."tenant_id" = $2 and link."status" = 'pending'
						returning link."envoy", link."transport"
					)
					select "envoy", "transport" from claimed`,
						[claimId, tenant.tenantId, subject.userId]
					)
				]);
				const registered = Schema.decodeUnknownOption(RegistrationResultRow)(committed.rows[0]);
				return registered._tag === 'Some'
					? {
							state: 'registered' as const,
							envoy: registered.value.envoy,
							transport: registered.value.transport
						}
					: yield* unavailableRegistration(
							EffectId.make(`${effectId}:unavailable`),
							claimId,
							subject
						);
			});

			/**
			 * The text half of a channel payload: a structured `{ text }` answer keeps its text, anything
			 * else is stringified — the host reads the same field either way, because the payload is now
			 * a declared shape, not a shape somebody guesses at.
			 */
			const textOf = (value: Schema.Json): string => {
				if (!isObjectLike(value)) return String(value ?? '');
				const text = Reflect.get(value, 'text');
				return isString(text) ? text : String(value ?? '');
			};

			/**
			 * Delivers one outbound message and reports what it became on the wire.
			 *
			 * The provider key the receipt carries back is what turns a reply into a conversation that
			 * can update itself: progress is one bubble edited in place, and the final answer edits that
			 * same bubble. Never fails — a transport that refused names that in `delivered`, and a
			 * provider that answers no key still delivered, with `key: null` as the honest answer.
			 */
			const deliver = Effect.fn('Envoys.deliver')(function* (
				effectId: EffectId,
				envoy: EnvoyDefinition & { readonly name: string },
				recipient: string,
				payload: Schema.Json,
				updateOf?: string | null
			) {
				const response = yield* communication
					.execute(EffectId.make(`${effectId}:reply`), {
						_tag: 'Send',
						channel: envoy.transport,
						recipient,
						payload:
							updateOf === undefined || updateOf === null
								? payload
								: { text: textOf(payload), updateOf }
					})
					.pipe(Effect.option);
				if (Option.isNone(response)) return { delivered: false as const, key: null };
				// A receipt counts a delivered message, not an attempt: an edit rewrites the same message.
				if (updateOf === undefined || updateOf === null) {
					yield* recordReceipt(
						EffectId.make(`${effectId}:receipt`),
						envoy.name,
						recipient,
						'outbound',
						undefined,
						`${envoy.name}:${recipient}:${effectId}:outbound`
					);
				}
				const receipt: unknown = response.value.receipt;
				const id = isObjectLike(receipt) ? Reflect.get(receipt, 'id') : undefined;
				return {
					delivered: true as const,
					key:
						updateOf !== undefined && updateOf !== null
							? updateOf
							: isString(id) && id !== ''
								? id
								: null
				};
			});

			const assistantText = (message: Prompt.MessageEncoded): string =>
				isString(message.content)
					? message.content
					: message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n');

			const settleDelivery = Effect.fn('Envoys.settleDelivery')(function* (
				effectId: EffectId,
				envoy: EnvoyDefinition & { readonly name: string },
				conversationId: string,
				output: Schema.Json,
				progressKey: string | null,
				rowIds?: ReadonlyArray<string>
			) {
				const processing = yield* executeBuilt(
					EffectId.make(`${effectId}:processing`),
					database,
					composer
						.select({
							id: boltEnvoyInbound.id,
							envoy_name: boltEnvoyInbound.envoy_name,
							transport_conversation_id: boltEnvoyInbound.transport_conversation_id
						})
						.from(boltEnvoyInbound)
						.where(
							and(
								eq(boltEnvoyInbound.conversation_id, conversationId),
								eq(boltEnvoyInbound.status, 'processing'),
								...(rowIds === undefined ? [] : [inArray(boltEnvoyInbound.id, rowIds)])
							)
						)
						.orderBy(asc(boltEnvoyInbound.sent_at))
				);
				const rows = processing.rows.flatMap((row) => {
					const decoded = Schema.decodeUnknownOption(ProcessingRecipient)(row);
					return decoded._tag === 'Some' ? [decoded.value] : [];
				});
				if (rows.length === 0) {
					return { envoy: envoy.name, conversationId, drained: 0, status: 'skipped' as const };
				}
				const recipient = rows.at(-1)?.transport_conversation_id;
				let answered = false;
				if (recipient !== undefined) {
					if (progressKey !== null) {
						answered = (yield* deliver(effectId, envoy, recipient, output, progressKey)).delivered;
					}
					if (!answered) answered = (yield* deliver(effectId, envoy, recipient, output)).delivered;
				}
				const status = answered ? ('answered' as const) : ('failed' as const);
				yield* executeBuilt(
					EffectId.make(`${effectId}:settle`),
					database,
					composer
						.update(boltEnvoyInbound)
						.set({ status, answered_at: dbNow() })
						.where(
							inArray(
								boltEnvoyInbound.id,
								rows.map(({ id }) => id)
							)
						)
				);
				return { envoy: envoy.name, conversationId, drained: rows.length, status };
			});

			return Service.of({
				inspectRegistration,
				redeemRegistration,

				receive: Effect.fn('Envoys.receive')(function* (effectId, envoyName, delivery) {
					const envoy = yield* requireEnvoy(envoyName);
					const senderId = delivery.sender?.id;
					yield* recordReceipt(
						EffectId.make(`${effectId}:receipt`),
						envoyName,
						delivery.conversationId,
						'inbound',
						senderId,
						`${envoyName}:${delivery.conversationId}:${delivery.messageId}:inbound`
					);
					const groupEnabled =
						delivery.conversationKind !== 'group' || envoy.groupMessages !== 'disabled';
					if (!groupEnabled) {
						return {
							status: 'silent' as const,
							envoy: envoyName,
							conversationId: delivery.conversationId
						};
					}
					const addressed =
						delivery.conversationKind !== 'group' ||
						envoy.groupMessages === 'all' ||
						delivery.invocation === 'mention' ||
						delivery.invocation === 'reply';
					const steerRequested = addressed && /^\s*\/steer(?:\s|$)/i.test(delivery.text);
					const inboundText = steerRequested
						? delivery.text.replace(/^\s*\/steer(?:\s+|$)/i, '').trimStart()
						: delivery.text;

					const linked =
						envoy.audience === 'authenticated' && senderId !== undefined
							? yield* identity.accountByTransportIdentity(effectId, envoy.transport, senderId)
							: undefined;
					if (envoy.audience === 'authenticated' && linked === undefined) {
						if (!addressed || senderId === undefined) {
							return {
								status: 'silent' as const,
								envoy: envoyName,
								conversationId: delivery.conversationId
							};
						}
						const principal = envoySubject(envoy, tenant.tenantId, undefined);
						const declared = access.limits(principal);
						const noticeLimits = {
							...declared,
							'envoys.registration':
								declared['envoys.registration'] ?? REGISTRATION_NOTICE_LIMITS['envoys.registration']
						};
						const admitted = yield* rateLimits
							.admit(
								'envoys.registration',
								{
									tenantId: tenant.tenantId,
									userId: envoyPrincipalId(envoyName),
									sender: senderId
								},
								noticeLimits
							)
							.pipe(
								Effect.as(true),
								Effect.catch(() => Effect.succeed(false))
							);
						const claimId = admitted
							? yield* issueRegistration(EffectId.make(`${effectId}:registration`), envoy, senderId)
							: undefined;
						const text = `Register this ${envoy.transport} account with ${tenant.tenantId} to continue.`;
						let delivered = false;
						if (claimId !== undefined) {
							const outcome = yield* deliver(effectId, envoy, senderId, {
								text,
								registration: {
									claimId,
									expiresInMinutes: ENVOY_REGISTRATION_EXPIRES_SECONDS / 60
								}
							});
							delivered = outcome.delivered;
						}
						return {
							status: 'registration_required' as const,
							envoy: envoyName,
							conversationId: delivery.conversationId,
							...(delivered ? { text } : {})
						};
					}

					const subject = envoySubject(envoy, tenant.tenantId, linked);
					yield* rateLimits.admit(
						'envoys.receive',
						{
							tenantId: subject.tenantId,
							userId: envoyPrincipalId(envoyName),
							sender: senderId
						},
						access.limits(subject)
					);
					if (steerRequested && inboundText.trim().length === 0) {
						yield* deliver(effectId, envoy, delivery.conversationId, {
							text: 'Use /steer <message> to redirect the current work at its next safe boundary.'
						});
						return {
							status: 'buffered' as const,
							envoy: envoyName,
							conversationId: delivery.conversationId
						};
					}

					const conversationId = `${envoyName}:${delivery.conversationKind}:${delivery.conversationId}`;
					const claim = yield* executeBuilt(
						EffectId.make(`${effectId}:claim`),
						database,
						composer
							.insert(boltEnvoyInbound)
							.values({
								envoy_name: envoyName,
								conversation_id: conversationId,
								transport_conversation_id: delivery.conversationId,
								external_message_id: delivery.messageId,
								receipt_key: `${envoyName}:${delivery.conversationId}:${delivery.messageId}`,
								sender_external_id: senderId ?? null,
								sender_display_name: delivery.sender?.displayName ?? null,
								sent_at: delivery.sentAt,
								invocation: delivery.invocation,
								text: delivery.text,
								attachments: JSON.stringify([]),
								subject: JSON.stringify(subject),
								addressed,
								status: 'receiving'
							})
							.onConflictDoNothing({ target: boltEnvoyInbound.receipt_key })
							.returning({ id: boltEnvoyInbound.id })
					);
					const claimed = decodeIdRow(claim.rows[0]);
					if (claimed._tag === 'None') {
						return {
							status: 'duplicate' as const,
							envoy: envoyName,
							conversationId: delivery.conversationId
						};
					}

					const stored: Array<Agents.InboundAttachment> = [];
					const finishBuffer = Effect.gen(function* () {
						for (const [index, attachment] of delivery.attachments.entries()) {
							const bytes = bytesOf(attachment.bytesBase64);
							if (bytes.byteLength !== attachment.byteLength) {
								return yield* new EnvoyError({
									envoy: envoyName,
									message: `attachment ${attachment.attachmentId} did not match its declared byte length`
								});
							}
							const storageKey = stagingAttachmentKey(
								envoyName,
								conversationId,
								delivery.messageId,
								index,
								attachment.fileName
							);
							const asset = ImageAsset.make({
								key: storageKey,
								name: attachment.fileName,
								mimeType: attachment.mimeType,
								size: bytes.byteLength
							});
							yield* files.execute(EffectId.make(`${effectId}:attachment:${index}`), {
								_tag: 'Write',
								key: storageKey,
								bytes
							});
							stored.push({
								provider: attachment.provider,
								attachmentId: attachment.attachmentId,
								asset
							});
						}
						yield* executeBuilt(
							EffectId.make(`${effectId}:buffer`),
							database,
							composer
								.update(boltEnvoyInbound)
								.set({ attachments: JSON.stringify(stored), status: 'pending' })
								.where(eq(boltEnvoyInbound.id, claimed.value.id))
						);
					});
					yield* finishBuffer.pipe(
						Effect.onError(() =>
							Effect.all([
								...stored.map(({ asset }, index) =>
									files.execute(EffectId.make(`${effectId}:abandon-document:${index}`), {
										_tag: 'Delete',
										key: asset.key
									})
								),
								executeBuilt(
									EffectId.make(`${effectId}:abandon`),
									database,
									composer.delete(boltEnvoyInbound).where(eq(boltEnvoyInbound.id, claimed.value.id))
								)
							]).pipe(Effect.ignore)
						)
					);
					if (addressed) {
						const now = yield* Clock.currentTimeMillis;
						yield* enqueueDrain(
							EffectId.make(`${effectId}:enqueue`),
							envoyName,
							conversationId,
							now
						);
					}
					return {
						status: addressed ? ('buffered' as const) : ('silent' as const),
						envoy: envoyName,
						conversationId: delivery.conversationId
					};
				}),

				drain: Effect.fn('Envoys.drain')(function* (effectId, envoyName, conversationId) {
					const envoy = yield* requireEnvoy(envoyName);
					const pendingIds = composer
						.select({ id: boltEnvoyInbound.id })
						.from(boltEnvoyInbound)
						.where(
							and(
								eq(boltEnvoyInbound.conversation_id, conversationId),
								eq(boltEnvoyInbound.status, 'pending')
							)
						)
						.orderBy(asc(boltEnvoyInbound.sent_at), asc(boltEnvoyInbound.created_at))
						.limit(MAX_DRAIN_MESSAGES);
					const claimed = yield* executeBuilt(
						EffectId.make(`${effectId}:take`),
						database,
						composer
							.update(boltEnvoyInbound)
							.set({ status: 'processing' })
							.where(inArray(boltEnvoyInbound.id, pendingIds))
							.returning({
								id: boltEnvoyInbound.id,
								conversation_id: boltEnvoyInbound.conversation_id,
								transport_conversation_id: boltEnvoyInbound.transport_conversation_id,
								external_message_id: boltEnvoyInbound.external_message_id,
								sender_external_id: boltEnvoyInbound.sender_external_id,
								sender_display_name: boltEnvoyInbound.sender_display_name,
								sent_at: boltEnvoyInbound.sent_at,
								invocation: boltEnvoyInbound.invocation,
								text: boltEnvoyInbound.text,
								attachments: boltEnvoyInbound.attachments,
								subject: boltEnvoyInbound.subject,
								addressed: boltEnvoyInbound.addressed
							})
					);
					const rows = claimed.rows
						.flatMap((row) => {
							const decoded = decodeInboundRow(row);
							return decoded._tag === 'Some' ? [decoded.value] : [];
						})
						.toSorted(
							(left, right) =>
								left.sent_at.localeCompare(right.sent_at) || left.id.localeCompare(right.id)
						);
					if (rows.length === 0) {
						return { envoy: envoyName, conversationId, drained: 0, status: 'skipped' as const };
					}
					const rowIds = rows.map(({ id }) => id);
					const restore = executeBuilt(
						EffectId.make(`${effectId}:restore`),
						database,
						composer
							.update(boltEnvoyInbound)
							.set({ status: 'pending' })
							.where(inArray(boltEnvoyInbound.id, rowIds))
					).pipe(Effect.ignore);
					const trigger = [...rows].reverse().find(({ addressed }) => addressed);
					if (trigger === undefined) {
						yield* restore;
						return { envoy: envoyName, conversationId, drained: 0, status: 'skipped' as const };
					}

					const taskId: TaskId = Agents.taskIdFor(`envoy:${conversationId}:${rowIds.join(':')}`);
					const steerPattern = /^\s*\/steer(?:\s|$)/i;
					const priority = rows.some(({ addressed, text }) => addressed && steerPattern.test(text))
						? DirectivePriority.make('steer')
						: DirectivePriority.make('normal');
					const stagingKeys: Array<string> = [];
					const executeTask = Effect.gen(function* () {
						const messages: Array<Agents.InboundBatchMessage> = [];
						for (const row of rows) {
							const attachments: Array<Agents.InboundAttachment> = [];
							for (const [index, attachment] of row.attachments.entries()) {
								const response = yield* files.execute(
									EffectId.make(`${effectId}:read-attachment:${row.id}:${index}`),
									{ _tag: 'Read', key: attachment.asset.key }
								);
								if (
									response.bytes === undefined ||
									response.bytes.byteLength !== attachment.asset.size
								) {
									return yield* new EnvoyError({
										envoy: envoyName,
										message: `attachment ${attachment.attachmentId} is missing or changed before Task admission`
									});
								}
								const asset = ImageAsset.make({
									...attachment.asset,
									key: Agents.taskAssetStorageKey(
										taskId,
										`${row.external_message_id}:${index}`,
										attachment.asset.name
									)
								});
								yield* files.execute(
									EffectId.make(`${effectId}:materialize-attachment:${row.id}:${index}`),
									{ _tag: 'Write', key: asset.key, bytes: response.bytes }
								);
								stagingKeys.push(attachment.asset.key);
								attachments.push({
									provider: attachment.provider,
									attachmentId: attachment.attachmentId,
									asset
								});
							}
							messages.push({
								sender: {
									...(row.sender_external_id === null ? {} : { id: row.sender_external_id }),
									...(row.sender_display_name === null
										? {}
										: { displayName: row.sender_display_name })
								},
								sentAt: row.sent_at,
								messageId: row.external_message_id,
								text: row.text.replace(steerPattern, '').trimStart(),
								attachments,
								invocation: row.invocation
							});
						}

						const batch = Agents.inboundAgentInput(messages);
						yield* agents
							.submit(effectId, trigger.subject, {
								taskId,
								agentId: AgentId.make(envoyName),
								message: batch,
								mode: DirectiveMode.make('agent'),
								priority
							})
							.pipe(taskFailure(envoyName, 'Task submission'));
						const executed = yield* agents
							.execute(EffectId.make(`${effectId}:execute`), trigger.subject, taskId)
							.pipe(taskFailure(envoyName, 'Task execution'));
						if (executed.status !== 'done' && executed.status !== 'failed') {
							return yield* new EnvoyError({
								envoy: envoyName,
								message: `Task ${taskId} paused as ${executed.status}; durable Envoy continuation routing is not available`
							});
						}
						if (executed.output === undefined) {
							return yield* new EnvoyError({
								envoy: envoyName,
								message: `Task ${taskId} settled without a transport answer`
							});
						}
						const text = assistantText(executed.output).trim();
						if (text === '') {
							return yield* new EnvoyError({
								envoy: envoyName,
								message: `Task ${taskId} settled without textual transport content`
							});
						}
						const settled = yield* settleDelivery(
							EffectId.make(`${effectId}:deliver`),
							envoy,
							conversationId,
							{ text },
							null,
							rowIds
						);
						yield* Effect.forEach(stagingKeys, (key, index) =>
							files
								.execute(EffectId.make(`${effectId}:clear-staging:${index}`), {
									_tag: 'Delete',
									key
								})
								.pipe(Effect.ignore)
						);
						return settled;
					});
					const settled = yield* executeTask.pipe(Effect.onError(() => restore));

					const remaining = yield* executeBuilt(
						EffectId.make(`${effectId}:remaining`),
						database,
						composer
							.select({ count: count() })
							.from(boltEnvoyInbound)
							.where(
								and(
									eq(boltEnvoyInbound.conversation_id, conversationId),
									eq(boltEnvoyInbound.status, 'pending')
								)
							)
					);
					const left = decodeNumber(
						Reflect.get((remaining.rows[0] as object | undefined) ?? {}, 'count') ?? 0
					);
					if (left > 0) {
						const now = yield* Clock.currentTimeMillis;
						yield* enqueueDrain(
							EffectId.make(`${effectId}:requeue`),
							envoyName,
							conversationId,
							now
						);
					}
					return settled;
				}),

				complete: Effect.fn('Envoys.complete')(
					function* (effectId, envoyName, conversationId, output, progressKey) {
						const envoy = yield* requireEnvoy(envoyName);
						return yield* settleDelivery(effectId, envoy, conversationId, output, progressKey);
					}
				),

				reply: Effect.fn('Envoys.reply')(function* (effectId, envoyName, recipient, payload) {
					const envoy = yield* requireEnvoy(envoyName);
					yield* deliver(effectId, envoy, recipient, payload);
				}),

				progress: Effect.fn('Envoys.progress')(
					function* (effectId, conversationId, body, updateOf) {
						const processing = yield* executeBuilt(
							effectId,
							database,
							composer
								.select({
									envoy_name: boltEnvoyInbound.envoy_name,
									transport_conversation_id: boltEnvoyInbound.transport_conversation_id
								})
								.from(boltEnvoyInbound)
								.where(
									and(
										eq(boltEnvoyInbound.conversation_id, conversationId),
										eq(boltEnvoyInbound.status, 'processing')
									)
								)
								.orderBy(asc(boltEnvoyInbound.sent_at))
								.limit(1)
						);
						const decoded = Schema.decodeUnknownOption(ProcessingRecipient)(processing.rows[0]);
						// A conversation with nothing in flight is not a transport one: the web agent's turns
						// land here, and progress has nowhere to be posted. Silence is the correct answer.
						if (decoded._tag === 'None') return null;
						const envoy = yield* requireEnvoy(decoded.value.envoy_name);
						const outcome = yield* deliver(
							effectId,
							envoy,
							decoded.value.transport_conversation_id,
							{ text: body },
							updateOf
						);
						if (!outcome.delivered) return null;
						// An edit that landed rewrites the very message `updateOf` names, so the key to edit
						// next is the key that was handed in; only a fresh send mints a new one.
						return outcome.key ?? updateOf;
					}
				),

				status: Effect.fn('Envoys.status')(function* (effectId, envoyName) {
					yield* requireEnvoy(envoyName);
					// One pass per call, not two: the counters the status answers with are the
					// directions of the same row set, so one grouped query reads both.
					const counts = yield* executeBuilt(
						effectId,
						database,
						composer
							.select({
								direction: boltEnvoyReceipts.direction,
								count: count()
							})
							.from(boltEnvoyReceipts)
							.where(eq(boltEnvoyReceipts.envoy_name, envoyName))
							.groupBy(boltEnvoyReceipts.direction)
					);
					const DirectionCount = Schema.Struct({
						direction: Schema.NonEmptyString,
						count: Schema.Number
					});
					const countOf = (direction: string): number => {
						const row = Schema.decodeUnknownOption(DirectionCount)(
							counts.rows.find(
								(candidate) => (candidate as { direction?: string }).direction === direction
							)
						);
						return row._tag === 'Some' ? Math.max(0, Math.floor(row.value.count)) : 0;
					};
					return {
						envoy: envoyName,
						received: countOf('inbound'),
						replied: countOf('outbound')
					};
				})
			});
		})
	);

export const layer = layerWith();
