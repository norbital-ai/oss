import { Clock, Context, Effect, Layer, Option, Schema } from 'effect';
import { Prompt } from 'effect/unstable/ai';
import { EffectId } from '@norbital-ai/bolt-protocol';
import {
	AgentId,
	DirectiveMode,
	DirectivePriority,
	ImageAsset,
	MessageId,
	type ConversationId
} from '@norbital-ai/bolt-protocol/facilities';
import { getErrorMessage } from '@norbital-ai/std';
import { decodeNumber } from '@norbital-ai/std/json';
import { and, asc, count, eq, gt, inArray, ne } from 'drizzle-orm';
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
	bolt_envoy_inbound: boltEnvoyInbound,
	bolt_envoy_receipts: boltEnvoyReceipts,
	bolt_channel_links: boltChannelLinks,
	conversation_message: conversationMessage
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

/**
 * The two receipt directions the status answers with, read from one grouped query's rows.
 *
 * `count(*)` is an eight-byte integer, and the driver hands it over as a JSON-safe *string* — the
 * facility normalises a `bigint`, not the text Postgres sends — so decoding it as a number rejected
 * every row and reported every envoy as idle. `decodeNumber` reads either shape.
 */
export const envoyReceiptCounts = (
	rows: ReadonlyArray<Schema.Json>
): Readonly<{ received: number; replied: number }> => {
	const countOf = (direction: string): number => {
		const row = rows.find(
			(candidate) => isObjectLike(candidate) && Reflect.get(candidate, 'direction') === direction
		);
		const count = decodeNumber(Reflect.get((row as object | undefined) ?? {}, 'count') ?? 0);
		return Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
	};
	return { received: countOf('inbound'), replied: countOf('outbound') };
};

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

const MAX_DRAIN_MESSAGES = 32;
/** A turn per admitted message, plus the quiet check that ends the drain. */
const MAX_DRAIN_TURNS = MAX_DRAIN_MESSAGES + 1;
const REGISTRATION_NOTICE_LIMITS = {
	'envoys.registration': [{ window: '15 minutes', limit: 1, key: 'sender' as const }]
};
const ENVOY_REGISTRATION_EXPIRES_SECONDS = 15 * 60;

/**
 * One agent conversation per transport chat.
 *
 * A direct message and a group channel are each exactly one conversation, and it is the same
 * conversation for every message that arrives in it. That is what makes `steer` mean something:
 * a follow-up written while the assistant is working joins the turn already running instead of
 * opening a second one, and a follow-up written after it starts the next turn on the same
 * transcript.
 */
const conversationFor = (conversationId: string): ConversationId =>
	Agents.conversationIdFor(`envoy:${conversationId}`);

/**
 * The conversation message one inbound row becomes, stable across every retry of it.
 *
 * The row is submitted with this as its `submissionId`, so a drain that runs again after a
 * partial failure re-submits the same message rather than appending a duplicate — and settlement
 * can ask whether the row's message was consumed without storing a second pointer to it.
 */
const inboundMessageId = (conversationId: string, externalMessageId: string): MessageId =>
	Agents.messageIdFor(`envoy-inbound:${conversationId}:${externalMessageId}`);

/**
 * The text this turn owes the chat: the last text part it wrote.
 *
 * Everything before that part was handed over as it was written, so delivering the whole message
 * here would repeat it. A turn that wrote no text at all owes nothing.
 */
const finalAnswerText = (message: Prompt.MessageEncoded): string => {
	if (isString(message.content)) return message.content;
	return message.content.findLast((part) => part.type === 'text')?.text ?? '';
};

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
		conversationId: string,
		/**
		 * The host task claim that woke this drain, when one did. A drain that finds the chat's
		 * turn still running defers its own claim instead of polling, so nothing spins and the
		 * message is answered the moment the turn frees.
		 */
		claim?: Readonly<{ readonly id: string; readonly attempt: number }>
	) => Effect.Effect<DrainReport, EnvoyFailure>;
	readonly reply: (
		effectId: EffectId,
		envoyName: string,
		recipient: string,
		payload: Schema.Json
	) => Effect.Effect<void, EnvoyError | Database.FacilityError>;
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
			 * Starts the conversation's drain now, as a claimed occurrence the host runs in one hop.
			 *
			 * The row is keyed by the message that caused it, so a redelivery of one provider message
			 * cannot start a second drain, and a new message starts one immediately rather than waiting
			 * out a batch window. Generation begins from the wake, not from a timer.
			 */
			const enqueueDrain = Effect.fn('Envoys.enqueueDrain')(function* (
				effectId: EffectId,
				envoyName: string,
				conversationId: string,
				messageId: string,
				now: number
			) {
				yield* queue.enqueueClaimed(EffectId.make(`${effectId}:enqueue`), {
					command: 'envoys.drain',
					input: { envoy: envoyName, conversationId },
					effectId: `envoys.drain:${conversationId}:${messageId}`,
					nowEpochMs: now
				});
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
			 * Delivers one outbound message, answering whether the transport took it.
			 *
			 * Never fails: a transport that refused answers `false`. Delivery is the only thing that
			 * turns text into a WhatsApp message, and a receipt counts one delivered message, so a
			 * refused send is retried by the caller's own claim rather than recorded as a reply.
			 */
			const deliver = Effect.fn('Envoys.deliver')(function* (
				effectId: EffectId,
				envoy: EnvoyDefinition & { readonly name: string },
				recipient: string,
				payload: Schema.Json
			) {
				const response = yield* communication
					.execute(EffectId.make(`${effectId}:reply`), {
						_tag: 'Send',
						channel: envoy.transport,
						recipient,
						payload
					})
					.pipe(Effect.option);
				if (Option.isNone(response)) return false;
				yield* recordReceipt(
					EffectId.make(`${effectId}:receipt`),
					envoy.name,
					recipient,
					'outbound',
					undefined,
					`${envoy.name}:${recipient}:${effectId}:outbound`
				);
				return true;
			});

			/**
			 * Marks the inbound rows whose messages a turn has consumed, and reports what is left.
			 *
			 * A row is answered when its conversation message is consumed — the turn that consumed it
			 * wrote the answer that covers it — and an unaddressed group message is answered simply by
			 * being recorded: it never became work. Everything still queued is left for the next turn,
			 * and the count is what tells the drain whether to defer its claim.
			 */
			const settleAnswered = Effect.fn('Envoys.settleAnswered')(function* (
				effectId: EffectId,
				conversationId: string
			) {
				const waiting = yield* executeBuilt(
					EffectId.make(`${effectId}:waiting`),
					database,
					composer
						.select({
							id: boltEnvoyInbound.id,
							external_message_id: boltEnvoyInbound.external_message_id,
							addressed: boltEnvoyInbound.addressed
						})
						.from(boltEnvoyInbound)
						.where(
							and(
								eq(boltEnvoyInbound.conversation_id, conversationId),
								ne(boltEnvoyInbound.status, 'answered')
							)
						)
				);
				const rows = waiting.rows.flatMap((row) => {
					const decoded = Schema.decodeUnknownOption(
						Schema.Struct({
							id: Schema.NonEmptyString,
							external_message_id: Schema.NonEmptyString,
							addressed: Schema.Boolean
						})
					)(row);
					return decoded._tag === 'Some' ? [decoded.value] : [];
				});
				if (rows.length === 0) return { answered: 0, remaining: 0 };
				const candidates = rows.map((row) => ({
					rowId: row.id,
					addressed: row.addressed,
					messageId: inboundMessageId(conversationId, row.external_message_id)
				}));
				const consumed = yield* executeBuilt(
					EffectId.make(`${effectId}:consumed`),
					database,
					composer
						.select({ id: conversationMessage.id })
						.from(conversationMessage)
						.where(
							and(
								inArray(
									conversationMessage.id,
									candidates.map(({ messageId }) => messageId)
								),
								eq(conversationMessage.state, 'consumed')
							)
						)
				);
				const consumedIds = new Set(
					consumed.rows.flatMap((row) => {
						const decoded = Schema.decodeUnknownOption(Schema.Struct({ id: MessageId }))(row);
						return decoded._tag === 'Some' ? [decoded.value.id] : [];
					})
				);
				const answeredIds = candidates
					.filter(({ addressed, messageId }) => !addressed || consumedIds.has(messageId))
					.map(({ rowId }) => rowId);
				if (answeredIds.length > 0) {
					yield* executeBuilt(
						EffectId.make(`${effectId}:answer`),
						database,
						composer
							.update(boltEnvoyInbound)
							.set({ status: 'answered', answered_at: dbNow() })
							.where(inArray(boltEnvoyInbound.id, answeredIds))
					);
				}
				return {
					answered: answeredIds.length,
					remaining: rows.length - answeredIds.length
				};
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
						const delivered =
							claimId !== undefined &&
							(yield* deliver(effectId, envoy, senderId, {
								text,
								registration: {
									claimId,
									expiresInMinutes: ENVOY_REGISTRATION_EXPIRES_SECONDS / 60
								}
							}));
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
							delivery.messageId,
							now
						);
					}
					return {
						status: addressed ? ('buffered' as const) : ('silent' as const),
						envoy: envoyName,
						conversationId: delivery.conversationId
					};
				}),

				drain: Effect.fn('Envoys.drain')(function* (
					effectId,
					envoyName,
					conversationId,
					claim
				) {
					const envoy = yield* requireEnvoy(envoyName);
					const internal = conversationFor(conversationId);
					const pending = yield* executeBuilt(
						EffectId.make(`${effectId}:pending`),
						database,
						composer
							.select({
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
							.from(boltEnvoyInbound)
							.where(
								and(
									eq(boltEnvoyInbound.conversation_id, conversationId),
									eq(boltEnvoyInbound.status, 'pending'),
									eq(boltEnvoyInbound.addressed, true)
								)
							)
							.orderBy(asc(boltEnvoyInbound.sent_at), asc(boltEnvoyInbound.created_at))
							.limit(MAX_DRAIN_MESSAGES)
					);
					const rows = pending.rows
						.flatMap((row) => {
							const decoded = decodeInboundRow(row);
							return decoded._tag === 'Some' ? [decoded.value] : [];
						})
						.toSorted(
							(left, right) =>
								left.sent_at.localeCompare(right.sent_at) || left.id.localeCompare(right.id)
						);
					if (rows.length === 0) {
						// Nothing addressed is waiting: settle whatever this conversation already answered
						// and leave the rest to the message that will wake it.
						const settled = yield* settleAnswered(
							EffectId.make(`${effectId}:settle`),
							conversationId
						);
						return {
							envoy: envoyName,
							conversationId,
							drained: 0,
							status: settled.remaining > 0 ? ('queued' as const) : ('skipped' as const)
						};
					}
					const recipient = rows.at(-1)?.transport_conversation_id;

					const stagingKeys: Array<string> = [];
					const admit = Effect.gen(function* () {
						for (const [index, row] of rows.entries()) {
							const attachments: Array<Agents.InboundAttachment> = [];
							for (const [attachmentIndex, attachment] of row.attachments.entries()) {
								const response = yield* files.execute(
									EffectId.make(`${effectId}:read-attachment:${row.id}:${attachmentIndex}`),
									{ _tag: 'Read', key: attachment.asset.key }
								);
								if (
									response.bytes === undefined ||
									response.bytes.byteLength !== attachment.asset.size
								) {
									return yield* new EnvoyError({
										envoy: envoyName,
										message: `attachment ${attachment.attachmentId} is missing or changed before admission`
									});
								}
								const asset = ImageAsset.make({
									...attachment.asset,
									key: Agents.conversationAssetStorageKey(
										internal,
										`${row.external_message_id}:${attachmentIndex}`,
										attachment.asset.name
									)
								});
								yield* files.execute(
									EffectId.make(
										`${effectId}:materialize-attachment:${row.id}:${attachmentIndex}`
									),
									{ _tag: 'Write', key: asset.key, bytes: response.bytes }
								);
								stagingKeys.push(attachment.asset.key);
								attachments.push({
									provider: attachment.provider,
									attachmentId: attachment.attachmentId,
									asset
								});
							}
							const message: Agents.InboundAgentMessage = {
								sender: {
									...(row.sender_external_id === null ? {} : { id: row.sender_external_id }),
									...(row.sender_display_name === null
										? {}
										: { displayName: row.sender_display_name })
								},
								sentAt: row.sent_at,
								messageId: row.external_message_id,
								text: row.text,
								attachments,
								invocation: row.invocation
							};
							// Every message is a steer: it joins the turn already running at its next step,
							// and when nothing is running it is the message the next turn answers.
							yield* agents
								.submit(EffectId.make(`${effectId}:submit:${index}`), row.subject, {
									conversationId: internal,
									submissionId: inboundMessageId(conversationId, row.external_message_id),
									agentId: AgentId.make(envoyName),
									message: Agents.inboundAgentInput(message),
									mode: DirectiveMode.make('agent'),
									priority: DirectivePriority.make('steer')
								})
								.pipe(taskFailure(envoyName, 'message admission'));
						}
					});
					yield* admit;

					const onAssistantText = (part: Agents.AssistantTextPart) =>
						recipient === undefined
							? Effect.void
							: deliver(
									EffectId.make(`${effectId}:update:${part.callId}:${part.index}`),
									envoy,
									recipient,
									{ text: part.text }
								).pipe(Effect.ignore, Effect.asVoid);

					let answered = 0;
					let remaining = rows.length;
					let answerOwed = false;
					let delivered = false;
					const runTurns = Effect.gen(function* () {
						for (let turn = 0; turn < MAX_DRAIN_TURNS; turn += 1) {
							const subject = rows[turn]?.subject ?? rows.at(-1)!.subject;
							const executed = yield* agents
								.execute(
									EffectId.make(`${effectId}:execute:${turn}`),
									subject,
									internal,
									onAssistantText
								)
								.pipe(taskFailure(envoyName, 'Task execution'));
							if (executed.output !== undefined) {
								const answer = finalAnswerText(executed.output).trim();
								if (answer !== '' && recipient !== undefined) {
									answerOwed = true;
									delivered =
										(yield* deliver(
											EffectId.make(`${effectId}:answer:${turn}`),
											envoy,
											recipient,
											{ text: answer }
										)) || delivered;
								}
							}
							const settled = yield* settleAnswered(
								EffectId.make(`${effectId}:settle:${turn}`),
								conversationId
							);
							answered = settled.answered;
							remaining = settled.remaining;
							if (remaining === 0) break;
							// A turn that answered while another message stayed queued reports `idle` with
							// an output; only an idle with no output means another driver holds the chat.
							if (executed.output === undefined && executed.status !== 'done') break;
						}
					});
					yield* runTurns.pipe(
						Effect.ensuring(
							Effect.forEach(stagingKeys, (key, index) =>
								files
									.execute(EffectId.make(`${effectId}:clear-staging:${index}`), {
										_tag: 'Delete',
										key
									})
									.pipe(Effect.ignore)
							)
						)
					);
					// A queued message another turn is still working through keeps this claim alive: the
					// host re-runs the drain when the turn frees, and the message is answered then.
					if (remaining > 0 && claim !== undefined) {
						yield* queue.defer(EffectId.make(`${effectId}:defer`), claim.id, claim.attempt);
					}
					return {
						envoy: envoyName,
						conversationId,
						drained: answered,
						status:
							remaining > 0
								? ('queued' as const)
								: answerOwed && !delivered
									? ('failed' as const)
									: ('answered' as const)
					};
				}),

				reply: Effect.fn('Envoys.reply')(function* (effectId, envoyName, recipient, payload) {
					const envoy = yield* requireEnvoy(envoyName);
					yield* deliver(effectId, envoy, recipient, payload);
				}),

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
					return { envoy: envoyName, ...envoyReceiptCounts(counts.rows) };
				})
			});
		})
	);

export const layer = layerWith();
