import { Clock, Context, Effect, Layer, Option, Schema } from 'effect';
import { Prompt } from 'effect/unstable/ai';
import { EffectId, ENVOY_REGISTRATION_PATH, EnvoyDelivery } from '@norbital-ai/bolt-protocol';
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
import { ReplicaAttachment } from '#lib/runtime/envoys/inbox.js';
import { workspaceLink } from '#lib/runtime/host-links.js';
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
	bolt_envoy_messages: envoyMessages,
	bolt_envoy_receipts: boltEnvoyReceipts,
	bolt_channel_links: boltChannelLinks,
	conversation_message: conversationMessage,
	user: usersTable
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

const EnvoyOutcome = Schema.Struct({
	status: Schema.Literals([
		'buffered',
		'recorded',
		'duplicate',
		'edited',
		'silent',
		'registration_required'
	]),
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
	attachments: Schema.Array(ReplicaAttachment),
	subject: Identity.Subject,
	addressed: Schema.Boolean
});
type InboundRow = Schema.Schema.Type<typeof InboundRow>;
const decodeInboundRow = Schema.decodeUnknownOption(InboundRow);
/** The workspace name behind a registered sender's account, for the envelope the model reads. */
const NamedAccount = Schema.Struct({ id: Schema.NonEmptyString, name: Schema.NonEmptyString });
const decodeNamedAccount = Schema.decodeUnknownOption(NamedAccount);
const IdRow = Schema.Struct({ id: Schema.NonEmptyString });
const decodeIdRow = Schema.decodeUnknownOption(IdRow);
const SendReceipt = Schema.Struct({
	messageId: Schema.optionalKey(Schema.NonEmptyString),
	body: Schema.optionalKey(Schema.String)
});
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

			/** The whole notice, link included: see `workspaceLink` for where the link comes from. */
			const registrationNotice = Effect.fn('Envoys.registrationNotice')(function* (
				text: string,
				claimId: string
			) {
				const link = yield* workspaceLink(tenant.tenantId, ENVOY_REGISTRATION_PATH, {
					claim: claimId
				});
				return [
					text,
					'',
					'Complete registration:',
					link,
					'',
					`This link expires in ${ENVOY_REGISTRATION_EXPIRES_SECONDS / 60} minutes.`
				].join('\n');
			});

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
					// Opening one's own redeemed link again is not a failure: the number is registered,
					// which is what the person came to make true. Only somebody else's consumed link is.
					if (inspected.state === 'registered' && claim.claimed_by === subject.userId)
						return {
							state: 'already_registered' as const,
							envoy: claim.envoy,
							transport: claim.transport
						};
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
			 * turns text into a channel message, and a receipt counts one delivered message, so a
			 * refused send is retried by the caller's own claim rather than recorded as a reply.
			 *
			 * The receipt carries the provider's message id and the exact rendered body; the
			 * outbound half of the replica is written from it, so the chat the agent reads back is
			 * what the transport actually sent.
			 */
			const deliver = Effect.fn('Envoys.deliver')(function* (
				effectId: EffectId,
				envoy: EnvoyDefinition & { readonly name: string },
				conversationId: string,
				recipient: string,
				payload: Schema.Json
			) {
				const response = yield* communication
					.execute(EffectId.make(`${effectId}:send`), {
						_tag: 'Send',
						channel: envoy.transport,
						recipient,
						payload
					})
					.pipe(Effect.option);
				if (Option.isNone(response)) return false;
				const receipt = Schema.decodeUnknownOption(SendReceipt)(response.value.receipt);
				const asked = isObjectLike(payload) ? Reflect.get(payload, 'text') : undefined;
				const body =
					receipt._tag === 'Some' && receipt.value.body !== undefined
						? receipt.value.body
						: isString(asked)
							? asked
							: '';
				const messageId =
					receipt._tag === 'Some' && receipt.value.messageId !== undefined
						? receipt.value.messageId
						: effectId;
				const agentConversationId = conversationFor(conversationId);
				yield* executeBuilt(
					EffectId.make(`${effectId}:replica`),
					database,
					composer
						.insert(envoyMessages)
						.values({
							envoy_name: envoy.name,
							conversation_id: agentConversationId,
							transport_conversation_id: recipient,
							direction: 'outbound',
							origin: 'send',
							external_message_id: messageId,
							receipt_key: `${envoy.name}:${conversationId}:${messageId}:outbound`,
							sent_at: dbNow(),
							invocation: 'direct',
							text: body,
							attachments: JSON.stringify([]),
							subject: JSON.stringify(envoySubject(envoy, tenant.tenantId, undefined)),
							addressed: false,
							read_by: 'send',
							status: 'recorded'
						})
						.onConflictDoNothing({ target: envoyMessages.receipt_key })
				);
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
			 * Marks the addressed rows whose messages a turn has consumed, and reports what is left.
			 *
			 * A row is answered when its conversation message is consumed — the turn that consumed it
			 * wrote the answer that covers it. Ambient rows are never answered here: they were never
			 * work, and they stay readable until `read_messages` marks them read. Everything still
			 * queued is left for the next turn, and the count is what tells the drain whether to
			 * defer its claim.
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
							id: envoyMessages.id,
							external_message_id: envoyMessages.external_message_id
						})
						.from(envoyMessages)
						.where(
							and(
								eq(envoyMessages.conversation_id, conversationId),
								eq(envoyMessages.addressed, true),
								ne(envoyMessages.status, 'answered')
							)
						)
				);
				const rows = waiting.rows.flatMap((row) => {
					const decoded = Schema.decodeUnknownOption(
						Schema.Struct({
							id: Schema.NonEmptyString,
							external_message_id: Schema.NonEmptyString
						})
					)(row);
					return decoded._tag === 'Some' ? [decoded.value] : [];
				});
				if (rows.length === 0) return { answered: 0, remaining: 0 };
				const candidates = rows.map((row) => ({
					rowId: row.id,
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
					.filter(({ messageId }) => consumedIds.has(messageId))
					.map(({ rowId }) => rowId);
				if (answeredIds.length > 0) {
					yield* executeBuilt(
						EffectId.make(`${effectId}:answer`),
						database,
						composer
							.update(envoyMessages)
							.set({ status: 'answered', answered_at: dbNow() })
							.where(inArray(envoyMessages.id, answeredIds))
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
					const historical = delivery.historical === true;
					const edited = delivery.edited === true;
					const senderId = delivery.sender?.id;
					const internal = `${envoyName}:${delivery.conversationKind}:${delivery.conversationId}`;
					if (!historical && !edited)
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
						// History never mints a registration notice: the reply is owed to a live
						// sender, and a backfilled row has nobody waiting on it.
						if (!addressed || senderId === undefined || historical) {
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
							(yield* deliver(effectId, envoy, internal, senderId, {
								text: yield* registrationNotice(text, claimId)
							}));
						return {
							status: 'registration_required' as const,
							envoy: envoyName,
							conversationId: delivery.conversationId,
							...(delivered ? { text } : {})
						};
					}

					const subject = envoySubject(envoy, tenant.tenantId, linked);
					if (!historical)
						yield* rateLimits.admit(
							'envoys.receive',
							{
								tenantId: subject.tenantId,
								userId: envoyPrincipalId(envoyName),
								sender: senderId
							},
							access.limits(subject)
						);

					const agentConversationId = conversationFor(internal);
					const stored: Array<Schema.Schema.Type<typeof ReplicaAttachment>> = [];
					for (const [index, attachment] of delivery.attachments.entries()) {
						if (attachment.bytesBase64 === undefined) {
							stored.push({
								provider: attachment.provider,
								attachmentId: attachment.attachmentId,
								kind: attachment.kind,
								mimeType: attachment.mimeType,
								fileName: attachment.fileName,
								size: attachment.byteLength
							});
							continue;
						}
						const bytes = bytesOf(attachment.bytesBase64);
						if (bytes.byteLength !== attachment.byteLength) {
							return yield* new EnvoyError({
								envoy: envoyName,
								message: `attachment ${attachment.attachmentId} did not match its declared byte length`
							});
						}
						// Materialized once, at ingest: the replica is the durable home of the media,
						// so a read never has to copy bytes and a sync never has to re-fetch them.
						const key = Agents.conversationAssetStorageKey(
							agentConversationId,
							`${delivery.messageId}:${index}`,
							attachment.fileName
						);
						yield* files.execute(EffectId.make(`${effectId}:attachment:${index}`), {
							_tag: 'Write',
							key,
							bytes
						});
						stored.push({
							provider: attachment.provider,
							attachmentId: attachment.attachmentId,
							kind: attachment.kind,
							mimeType: attachment.mimeType,
							fileName: attachment.fileName,
							size: bytes.byteLength,
							key
						});
					}

					const recorded = yield* executeBuilt(
						EffectId.make(`${effectId}:claim`),
						database,
						composer
							.insert(envoyMessages)
							.values({
								envoy_name: envoyName,
								conversation_id: agentConversationId,
								transport_conversation_id: delivery.conversationId,
								direction: 'inbound',
								origin: historical ? 'sync' : 'live',
								external_message_id: delivery.messageId,
								receipt_key: `${envoyName}:${internal}:${delivery.messageId}`,
								sender_external_id: senderId ?? null,
								sender_display_name: delivery.sender?.displayName ?? null,
								sent_at: delivery.sentAt,
								invocation: delivery.invocation,
								text: delivery.text,
								attachments: JSON.stringify(stored),
								subject: JSON.stringify(subject),
								addressed,
								read_by: historical ? 'sync' : null,
								status: historical || edited ? 'recorded' : 'pending'
							})
							.onConflictDoNothing({ target: envoyMessages.receipt_key })
							.returning({ id: envoyMessages.id })
					);
					const claimed = decodeIdRow(recorded.rows[0]);
					if (claimed._tag === 'None') {
						if (edited) {
							// The replica converges; the transcript never does. A message a turn
							// already answered keeps the wording that turn was answered against.
							yield* executeBuilt(
								EffectId.make(`${effectId}:edit`),
								database,
								composer
									.update(envoyMessages)
									.set({ text: delivery.text, edited_at: dbNow() })
									.where(
										and(
											eq(envoyMessages.conversation_id, agentConversationId),
											eq(envoyMessages.direction, 'inbound'),
											eq(envoyMessages.external_message_id, delivery.messageId)
										)
									)
							);
							return {
								status: 'edited' as const,
								envoy: envoyName,
								conversationId: delivery.conversationId
							};
						}
						return {
							status: 'duplicate' as const,
							envoy: envoyName,
							conversationId: delivery.conversationId
						};
					}
					if (addressed && !historical && !edited) {
						const now = yield* Clock.currentTimeMillis;
						yield* enqueueDrain(
							EffectId.make(`${effectId}:enqueue`),
							envoyName,
							internal,
							delivery.messageId,
							now
						);
					}
					return {
						status: historical
							? ('recorded' as const)
							: edited
								? ('edited' as const)
								: addressed
									? ('buffered' as const)
									: ('silent' as const),
						envoy: envoyName,
						conversationId: delivery.conversationId
					};
				}),

				drain: Effect.fn('Envoys.drain')(function* (effectId, envoyName, conversationId, claim) {
					const envoy = yield* requireEnvoy(envoyName);
					const internal = conversationFor(conversationId);
					const pending = yield* executeBuilt(
						EffectId.make(`${effectId}:pending`),
						database,
						composer
							.select({
								id: envoyMessages.id,
								conversation_id: envoyMessages.conversation_id,
								transport_conversation_id: envoyMessages.transport_conversation_id,
								external_message_id: envoyMessages.external_message_id,
								sender_external_id: envoyMessages.sender_external_id,
								sender_display_name: envoyMessages.sender_display_name,
								sent_at: envoyMessages.sent_at,
								invocation: envoyMessages.invocation,
								text: envoyMessages.text,
								attachments: envoyMessages.attachments,
								subject: envoyMessages.subject,
								addressed: envoyMessages.addressed
							})
							.from(envoyMessages)
							.where(
								and(
									eq(envoyMessages.conversation_id, internal),
									eq(envoyMessages.status, 'pending'),
									eq(envoyMessages.addressed, true)
								)
							)
							.orderBy(asc(envoyMessages.sent_at), asc(envoyMessages.created_at))
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
						const settled = yield* settleAnswered(effectId, internal);
						return {
							envoy: envoyName,
							conversationId,
							drained: 0,
							status: settled.remaining > 0 ? ('queued' as const) : ('skipped' as const)
						};
					}
					const recipient = rows.at(-1)?.transport_conversation_id;

					/**
					 * The workspace names behind the registered senders in this batch.
					 *
					 * The envelope the model reads names the sender as the transport knows them — a
					 * WhatsApp display name is whatever they typed — so the account their address is
					 * linked to is what says who the turn serves. One bounded read by primary key for
					 * the whole batch; `receive` already resolved the link itself.
					 */
					const accountIds = [
						...new Set(
							rows
								.filter((row) => row.subject.userId !== envoyPrincipalId(envoyName))
								.map((row) => row.subject.userId)
						)
					];
					const accounts =
						accountIds.length === 0
							? new Map<string, string>()
							: new Map(
									(yield* executeBuilt(
										EffectId.make(`${effectId}:accounts`),
										database,
										composer
											.select({ id: usersTable.id, name: usersTable.name })
											.from(usersTable)
											.where(inArray(usersTable.id, accountIds))
									)).rows.flatMap((row) => {
										const decoded = decodeNamedAccount(row);
										return decoded._tag === 'Some'
											? [[decoded.value.id, decoded.value.name] as const]
											: [];
									})
								);

					const admit = Effect.gen(function* () {
						for (const [index, row] of rows.entries()) {
							const attachments: Array<Agents.InboundAttachment> = [];
							for (const attachment of row.attachments) {
								if (attachment.key === undefined) continue;
								attachments.push({
									provider: attachment.provider,
									attachmentId: attachment.attachmentId,
									asset: ImageAsset.make({
										key: attachment.key,
										name: attachment.fileName,
										mimeType: attachment.mimeType,
										size: attachment.size
									})
								});
							}
							const account = accounts.get(row.subject.userId);
							const message: Agents.InboundAgentMessage = {
								sender: {
									...(row.sender_external_id === null ? {} : { id: row.sender_external_id }),
									...(row.sender_display_name === null
										? {}
										: { displayName: row.sender_display_name }),
									...(account === undefined ? {} : { account })
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
									submissionId: inboundMessageId(internal, row.external_message_id),
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
									conversationId,
									recipient,
									{ text: part.text }
								).pipe(Effect.ignore, Effect.asVoid);

					let answered = 0;
					let remaining = rows.length;
					let answerOwed = false;
					let delivered = false;
					/**
					 * A turn that dies owes the sender a sentence. The failure is recorded on the
					 * conversation for whoever reads the transcript; the person on the transport sees
					 * none of that, and a chat that answers "Let me look that up" and then nothing is
					 * indistinguishable from one that was never delivered.
					 */
					const notifyFailure = (turn: number, reason: string) =>
						recipient === undefined
							? Effect.void
							: deliver(
									EffectId.make(`${effectId}:failure:${turn}`),
									envoy,
									conversationId,
									recipient,
									{ text: `Sorry, I could not finish that: ${reason.slice(0, 500)}` }
								).pipe(Effect.ignore, Effect.asVoid);
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
								.pipe(
									Effect.tapError((failure) => notifyFailure(turn, getErrorMessage(failure))),
									taskFailure(envoyName, 'Task execution')
								);
							if (executed.status === 'failed')
								yield* notifyFailure(turn, 'the request could not be completed.');
							if (executed.output !== undefined) {
								const answer = finalAnswerText(executed.output).trim();
								if (answer !== '' && recipient !== undefined) {
									answerOwed = true;
									delivered =
										(yield* deliver(
											EffectId.make(`${effectId}:answer:${turn}`),
											envoy,
											conversationId,
											recipient,
											{ text: answer }
										)) || delivered;
								}
							}
							const settled = yield* settleAnswered(
								EffectId.make(`${effectId}:settle:${turn}`),
								internal
							);
							answered = settled.answered;
							remaining = settled.remaining;
							if (remaining === 0) break;
							// A turn that answered while another message stayed queued reports `idle` with
							// an output; only an idle with no output means another driver holds the chat.
							if (executed.output === undefined && executed.status !== 'done') break;
						}
					});
					yield* runTurns;
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
