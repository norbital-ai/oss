import { Clock, Context, Effect, Layer, Option, Schema } from 'effect';
import { Prompt } from 'effect/unstable/ai';
import { EffectId, ENVOY_REGISTRATION_PATH } from '@norbital-ai/bolt-protocol';
import {
	AgentId,
	DirectiveMode,
	DirectivePriority,
	ImageAsset,
	MessageId,
	type ConversationId
} from '@norbital-ai/bolt-protocol/facilities';
import { getErrorMessage } from '@norbital-ai/std';
import { and, asc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import type { ChannelDeclaration } from '#lib/authoring/channels-schema.js';
import type { EnvoyDefinition } from '#lib/authoring/contracts-schema.js';
import { SYSTEM_MODEL_TABLES } from '#lib/authoring/system-models.js';
import * as Agents from '#lib/runtime/agents/agents.js';
import { conversationAssetStorageKey } from '#lib/runtime/agents/image-descriptors.js';
import * as AccessControl from '#lib/runtime/access/access-control.js';
import * as Channels from '#lib/runtime/channels/channels.js';
import * as Database from '#lib/runtime/facilities/database.js';
import * as Identity from '#lib/runtime/identity/identity.js';
import * as RateLimits from '#lib/runtime/rate-limits.js';
import * as TaskQueue from '#lib/runtime/tasks/tasks.js';
import * as TenantScope from '#lib/runtime/tenant.js';
import { canonicalTransportIdentity } from '#lib/runtime/envoys/transport-identity.js';
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
	channel_messages: channelMessages,
	bolt_channel_links: boltChannelLinks,
	conversation_message: conversationMessage,
	user: usersTable,
	team: teamsTable
} = SYSTEM_MODEL_TABLES;

class EnvoyError extends Schema.TaggedError<EnvoyError>()('Bolt.Envoys.Error', {
	envoy: Schema.NonEmptyString,
	message: Schema.NonEmptyString
}) {
	readonly category = 'envoy' as const;
	readonly retryable = false;
}

const isString = Schema.is(Schema.String);

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

type DrainReport = Readonly<{
	envoy: string;
	conversationId: string;
	drained: number;
	status: 'queued' | 'answered' | 'failed' | 'skipped';
}>;

/** An envoy with the channel it speaks on and that channel's transport. */
type Envoy = EnvoyDefinition & { readonly name: string; readonly transport: ChannelDeclaration['transport'] };

const MAX_DRAIN_MESSAGES = 32;
/** A turn per admitted message, plus the quiet check that ends the drain. */
const MAX_DRAIN_TURNS = MAX_DRAIN_MESSAGES + 1;
const REGISTRATION_NOTICE_LIMITS = {
	'envoys.registration': [{ window: '15 minutes', limit: 1, key: 'sender' as const }]
};
const ENVOY_REGISTRATION_EXPIRES_SECONDS = 15 * 60;

/**
 * One agent conversation per channel conversation: a chat, a mail thread. It is the same
 * conversation for every message that arrives in it, which is what makes `steer` mean something.
 * `internal` is `<envoy>:<dm|group>:<provider conversation>`.
 */
const conversationFor = (internal: string): ConversationId => Agents.conversationIdFor(`envoy:${internal}`);
const internalConversation = (envoy: string, kind: string, conversation: string): string =>
	`${envoy}:${kind}:${conversation}`;

/** Where the channel stores one message's attachment for this envoy: its conversation's own prefix. */
export const envoyAttachmentKey =
	(envoy: string) =>
	(conversation: string, kind: string, messageId: string, index: number, fileName: string): string =>
		conversationAssetStorageKey(
			conversationFor(internalConversation(envoy, kind, conversation)),
			`${messageId}:${index}`,
			fileName
		);

/** The conversation message one history row becomes, stable across every retry of it. */
const inboundMessageId = (conversationId: string, externalMessageId: string): MessageId =>
	Agents.messageIdFor(`envoy-inbound:${conversationId}:${externalMessageId}`);

/** The text this turn owes the chat: the last text part it wrote. */
const finalAnswerText = (message: Prompt.MessageEncoded): string => {
	if (isString(message.content)) return message.content;
	return message.content.findLast((part) => part.type === 'text')?.text ?? '';
};

const Attachment = Channels.StoredAttachment;
const PendingRow = Schema.Struct({
	id: Schema.NonEmptyString,
	provider_message_id: Schema.NonEmptyString,
	sender_id: Schema.NullOr(Schema.String),
	sender_name: Schema.NullOr(Schema.String),
	sent_at: Schema.NonEmptyString,
	invocation: Schema.NullOr(Schema.String),
	subject: Schema.NullOr(Schema.String),
	text: Schema.String,
	attachments: Schema.Array(Attachment)
});
type PendingRow = Schema.Schema.Type<typeof PendingRow>;
const decodePendingRow = Schema.decodeUnknownOption(PendingRow);
const NamedAccount = Schema.Struct({
	id: Schema.NonEmptyString,
	name: Schema.NonEmptyString,
	status: Schema.String,
	team_name: Schema.NullOr(Schema.String)
});
const decodeNamedAccount = Schema.decodeUnknownOption(NamedAccount);
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
	| RateLimits.RateLimited
	| Channels.ChannelError;

export type Interface = Readonly<{
	/**
	 * The envoy's half of ingest: new live inbound history rows on its channel. Admission is a query
	 * on history (addressed, inbound, live, unanswered); an unknown sender on a non-public envoy gets
	 * the host-authored registration notice over the same channel instead.
	 */
	readonly admit: (
		effectId: EffectId,
		channel: string,
		rows: ReadonlyArray<Channels.IngestedRow>
	) => Effect.Effect<ReadonlyArray<string>, EnvoyFailure>;
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
		 * turn still running defers its own claim instead of polling.
		 */
		claim?: Readonly<{ readonly id: string; readonly attempt: number }>
	) => Effect.Effect<DrainReport, EnvoyFailure>;
}>;

export const Service = Context.Service<Interface>('@norbital-ai/bolt/Envoys');

type LayerServices =
	| Workspace.Interface
	| Agents.Interface
	| Identity.Interface
	| Channels.Interface
	| Database.Interface
	| TaskQueue.Interface
	| RateLimits.Interface
	| AccessControl.Interface
	| TenantScope.Interface;

export const layer: Layer.Layer<Interface, never, LayerServices> = Layer.effect(
	Service,
	Effect.gen(function* () {
		const workspace = yield* Workspace.Service;
		const agents = yield* Agents.Service;
		const identity = yield* Identity.Service;
		const channels = yield* Channels.Service;
		const database = yield* Database.Service;
		const queue = yield* TaskQueue.Service;
		const rateLimits = yield* RateLimits.Service;
		const access = yield* AccessControl.Service;
		const tenant = yield* TenantScope.Service;

		const envoyOf = (declared: EnvoyDefinition & { readonly name: string }): Envoy | undefined => {
			const channel = workspace.definition.channels.find(({ name }) => name === declared.channel);
			return channel === undefined ? undefined : { ...declared, transport: channel.transport };
		};
		const requireEnvoy = Effect.fn('Envoys.requireEnvoy')(function* (envoyName: string) {
			const declared = workspace.definition.envoys.find(({ name }) => name === envoyName);
			const envoy = declared === undefined ? undefined : envoyOf(declared);
			if (envoy === undefined)
				return yield* new EnvoyError({ envoy: envoyName, message: 'Unknown envoy' });
			return envoy;
		});

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
			envoy: Envoy,
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
			const claimId = globalThis.crypto.randomUUID();
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
		 * Sends one reply over the envoy's channel: an outbox row, committed, then drained at once.
		 * A send that fails now is retried by the outbox; the reply is never lost. Answers whether the
		 * reply was committed.
		 */
		const deliver = (
			effectId: EffectId,
			envoy: Envoy,
			conversationId: string,
			text: string,
			mail?: Readonly<{ readonly to: ReadonlyArray<string>; readonly subject: string }>
		) =>
			channels
				.send(
					effectId,
					envoy.channel,
					envoy.transport === 'email'
						? { to: mail?.to ?? [], subject: mail?.subject ?? 'Re:', text }
						: { to: conversationId, text },
					{ conversationId }
				)
				.pipe(
					Effect.tap(() => channels.drain(EffectId.make(`${effectId}:drain`), envoy.channel).pipe(Effect.ignore)),
					Effect.as(true),
					Effect.catch(() => Effect.succeed(false))
				);

		/**
		 * Whose authority a row's turn carries. A linked member's turn runs as that member — their team's
		 * policies, or the administrator bypass — exactly as in the web app; an unmatched sender on a
		 * public envoy carries the envoy's declared policies alone.
		 */
		const subjectFor = Effect.fn('Envoys.subjectFor')(function* (
			effectId: EffectId,
			envoy: Envoy,
			senderId: string | null
		) {
			const linked =
				envoy.audience !== 'public' && senderId !== null
					? yield* identity.accountByTransportIdentity(effectId, envoy.transport, senderId)
					: undefined;
			if (linked === undefined) return envoy.audience === 'public' ? envoySubject(envoy, tenant.tenantId, undefined) : undefined;
			// An account that no longer resolves is no member: the turn is refused like an unknown sender.
			return yield* identity.resolveUser(effectId, linked.userId).pipe(
				Effect.map((resolved): Identity.Subject | undefined => resolved),
				Effect.catchTag('Bolt.Identity.AuthenticationError', () => Effect.succeed(undefined))
			);
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
						id: channelMessages.id,
						provider_message_id: channelMessages.provider_message_id
					})
					.from(channelMessages)
					.where(
						and(
							eq(channelMessages.agent_conversation_id, conversationId),
							eq(channelMessages.addressed, true),
							isNull(channelMessages.answered_at)
						)
					)
			);
			const rows = waiting.rows.flatMap((row) => {
				const decoded = Schema.decodeUnknownOption(
					Schema.Struct({
						id: Schema.NonEmptyString,
						provider_message_id: Schema.NonEmptyString
					})
				)(row);
				return decoded._tag === 'Some' ? [decoded.value] : [];
			});
			if (rows.length === 0) return { answered: 0, remaining: 0 };
			const candidates = rows.map((row) => ({
				rowId: row.id,
				messageId: inboundMessageId(conversationId, row.provider_message_id)
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
						.update(channelMessages)
						.set({ answered_at: dbNow() })
						.where(inArray(channelMessages.id, answeredIds))
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
			admit: Effect.fn('Envoys.admit')(function* (effectId, channelName, rows) {
				const declared = workspace.definition.envoys.find(({ channel }) => channel === channelName);
				const envoy = declared === undefined ? undefined : envoyOf(declared);
				if (envoy === undefined) return [];
				const admitted: Array<string> = [];
				for (const row of rows) {
					if (row.direction !== 'inbound' || !row.inserted || row.deleted) continue;
					const envelope = row.envelope;
					if (envelope._tag === 'http') continue;
					const kind = row.conversationKind;
					if (row.origin === 'sync') {
						// Backfilled history joins the conversation already read: nobody is waiting on it.
						yield* executeBuilt(
							EffectId.make(`${effectId}:${row.providerMessageId}:history`),
							database,
							composer
								.update(channelMessages)
								.set({
									agent_conversation_id: conversationFor(internalConversation(envoy.name, kind, row.conversationId)),
									read_by: 'sync'
								})
								.where(eq(channelMessages.id, row.id))
						);
						continue;
					}
					const senderId = envelope._tag === 'chat' ? envelope.sender?.id ?? null : envelope.from.address.toLowerCase();
					const internal = internalConversation(envoy.name, kind, row.conversationId);
					const step = EffectId.make(`${effectId}:${row.providerMessageId}`);
					if (kind === 'group' && envoy.groupMessages === 'disabled') continue;
					const invocation = envelope._tag === 'chat' ? envelope.invocation : 'direct';
					const addressed =
						kind !== 'group' ||
						envelope._tag === 'email' ||
						envoy.groupMessages === 'all' ||
						invocation === 'mention' ||
						invocation === 'reply';
					if (!addressed) {
						// Ambient: history the envoy may read with read_messages, never a turn.
						yield* executeBuilt(
							EffectId.make(`${step}:ambient`),
							database,
							composer
								.update(channelMessages)
								.set({ agent_conversation_id: conversationFor(internal) })
								.where(eq(channelMessages.id, row.id))
						);
						continue;
					}
					if (envoy.audience !== 'public') {
						const linked =
							senderId === null
								? undefined
								: yield* identity.accountByTransportIdentity(step, envoy.transport, senderId);
						if (linked === undefined) {
							if (senderId === null) continue;
							const principal = envoySubject(envoy, tenant.tenantId, undefined);
							const declaredLimits = access.limits(principal);
							const noticeLimits = {
								...declaredLimits,
								'envoys.registration':
									declaredLimits['envoys.registration'] ?? REGISTRATION_NOTICE_LIMITS['envoys.registration']
							};
							const allowed = yield* rateLimits
								.admit('envoys.registration', { tenantId: tenant.tenantId, userId: envoyPrincipalId(envoy.name), sender: senderId }, noticeLimits)
								.pipe(
									Effect.as(true),
									Effect.catch(() => Effect.succeed(false))
								);
							const claimId = allowed ? yield* issueRegistration(EffectId.make(`${step}:registration`), envoy, senderId) : undefined;
							if (claimId !== undefined)
								yield* deliver(
									EffectId.make(`${step}:notice`),
									envoy,
									row.conversationId,
									yield* registrationNotice(`Register this ${envoy.transport} account with ${tenant.tenantId} to continue.`, claimId),
									envelope._tag === 'email' ? { to: [senderId], subject: `Re: ${envelope.subject}` } : undefined
								);
							continue;
						}
					}
					// The envoy's own limits bound every turn, whoever's authority it carries.
					const bounded = yield* rateLimits
						.admit('envoys.receive', { tenantId: tenant.tenantId, userId: envoyPrincipalId(envoy.name), ...(senderId === null ? {} : { sender: senderId }) }, access.limits(envoySubject(envoy, tenant.tenantId, undefined)))
						.pipe(Effect.as(true), Effect.catch(() => Effect.succeed(false)));
					if (!bounded) continue;
					yield* executeBuilt(
						EffectId.make(`${step}:admit`),
						database,
						composer
							.update(channelMessages)
							.set({ addressed: true, agent_conversation_id: conversationFor(internal) })
							.where(eq(channelMessages.id, row.id))
					);
					// The drain is keyed by the message that caused it, so a redelivery cannot start a
					// second one, and a new message starts one now.
					yield* queue.enqueueClaimed(EffectId.make(`${step}:enqueue`), {
						command: 'envoys.drain',
						input: { envoy: envoy.name, conversationId: internal },
						effectId: `envoys.drain:${internal}:${row.providerMessageId}`,
						nowEpochMs: yield* Clock.currentTimeMillis
					});
					admitted.push(row.providerMessageId);
				}
				return admitted;
			}),

			drain: Effect.fn('Envoys.drain')(function* (effectId, envoyName, conversationId, claim) {
				const envoy = yield* requireEnvoy(envoyName);
				const internal = conversationFor(conversationId);
				const scoped = conversationId.slice(envoyName.length + 1);
				const kind = scoped.slice(0, scoped.indexOf(':'));
				const providerConversation = scoped.slice(scoped.indexOf(':') + 1);
				const pending = yield* executeBuilt(
					EffectId.make(`${effectId}:pending`),
					database,
					composer
						.select({
							id: channelMessages.id,
							provider_message_id: channelMessages.provider_message_id,
							sender_id: channelMessages.sender_id,
							sender_name: channelMessages.sender_name,
							sent_at: channelMessages.sent_at,
							invocation: channelMessages.invocation,
							subject: channelMessages.subject,
							text: channelMessages.text,
							attachments: channelMessages.attachments
						})
						.from(channelMessages)
						.where(
							and(
								eq(channelMessages.agent_conversation_id, internal),
								eq(channelMessages.direction, 'inbound'),
								eq(channelMessages.origin, 'live'),
								eq(channelMessages.addressed, true),
								isNull(channelMessages.answered_at),
								isNull(channelMessages.deleted_at)
							)
						)
						.orderBy(asc(channelMessages.sent_at), asc(channelMessages.created_at))
						.limit(MAX_DRAIN_MESSAGES)
				);
				const rows = pending.rows
					.flatMap((row) => {
						const decoded = decodePendingRow(row);
						return decoded._tag === 'Some' ? [decoded.value] : [];
					})
					.toSorted((left, right) => left.sent_at.localeCompare(right.sent_at) || left.id.localeCompare(right.id));
				if (rows.length === 0) {
					const settled = yield* settleAnswered(effectId, internal);
					return { envoy: envoyName, conversationId, drained: 0, status: settled.remaining > 0 ? ('queued' as const) : ('skipped' as const) };
				}
				/**
				 * The turn this drain starts is owned by its own task claim. Every message enqueues a drain,
				 * so two overlap whenever a sender writes twice; without an owner each read the running
				 * turn as its own and both executed it — the same streamed ids, twice — and one failed the
				 * turn under the other.
				 */
				const owned = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
					(claim === undefined ? effect : Effect.provideService(effect, Agents.ExecutionOwner, claim.id)).pipe(
						Effect.provideService(Agents.EnvoyTurn, envoy.name)
					);
				const subjects: Array<Identity.Subject> = [];
				for (const [index, row] of rows.entries()) {
					const subject = yield* subjectFor(EffectId.make(`${effectId}:subject:${index}`), envoy, row.sender_id);
					subjects.push(subject ?? envoySubject(envoy, tenant.tenantId, undefined));
				}
				const last = rows.at(-1)!;
				const mail =
					envoy.transport === 'email' && last.sender_id !== null
						? { to: [last.sender_id], subject: /^re:/i.test(last.subject ?? '') ? (last.subject ?? '') : `Re: ${last.subject ?? ''}` }
						: undefined;

				/**
				 * The workspace account behind each registered sender, with its team and administrator
				 * status from the member row.
				 */
				const accountIds = [...new Set(subjects.filter(({ userId }) => userId !== envoyPrincipalId(envoyName)).map(({ userId }) => userId))];
				const accounts =
					accountIds.length === 0
						? new Map<string, Omit<Agents.InboundAccount, 'policies'>>()
						: new Map(
								(yield* executeBuilt(
									EffectId.make(`${effectId}:accounts`),
									database,
									composer
										.select({ id: usersTable.id, name: usersTable.name, status: usersTable.status, team: sql<string | null>`${teamsTable.name}`.as('team_name') })
										.from(usersTable)
										.leftJoin(teamsTable, eq(teamsTable.id, usersTable.team_id))
										.where(inArray(usersTable.id, accountIds))
								)).rows.flatMap((row) => {
									const decoded = decodeNamedAccount(row);
									return decoded._tag === 'Some'
										? [[decoded.value.id, { name: decoded.value.name, team: decoded.value.team_name, admin: decoded.value.status === Identity.ADMIN_STATUS }] as const]
										: [];
								})
							);

				for (const [index, row] of rows.entries()) {
					const attachments = row.attachments.flatMap((attachment) =>
						attachment.key === undefined
							? []
							: [ImageAsset.make({ key: attachment.key, name: attachment.fileName, mimeType: attachment.mimeType, size: attachment.size })]
					);
					const turnSubject = subjects[index]!;
					const known = accounts.get(turnSubject.userId);
					const account =
						known === undefined
							? undefined
							: { ...known, policies: access.policies(turnSubject) };
					const message: Agents.InboundAgentMessage = {
						sender: {
							...(row.sender_id === null ? {} : { id: row.sender_id }),
							...(row.sender_name === null ? {} : { displayName: row.sender_name }),
							...(account === undefined ? {} : { account })
						},
						sentAt: row.sent_at,
						conversationId: providerConversation,
						messageId: row.provider_message_id,
						// Media the channel could not hand over is named, not dropped, so the model can ask.
						text: [
							...(envoy.transport === 'email' && row.subject !== null ? [`Subject: ${row.subject}`] : []),
							row.text,
							...row.attachments.flatMap((attachment) =>
								attachment.key === undefined
									? [`[attachment ${attachment.fileName} · ${attachment.mimeType} · not received; ask the sender to send it again]`]
									: []
							)
						]
							.filter((line) => line !== '')
							.join('\n'),
						attachments,
						invocation: (row.invocation ?? 'direct') as Agents.InboundAgentMessage['invocation']
					};
					// Every message is a steer: it joins the turn already running at its next step.
					yield* owned(agents
						.submit(EffectId.make(`${effectId}:submit:${index}`), subjects[index]!, {
							conversationId: internal,
							submissionId: inboundMessageId(internal, row.provider_message_id),
							agentId: AgentId.make(envoyName),
							message: Agents.inboundAgentInput(message),
							mode: DirectiveMode.make('agent'),
							priority: DirectivePriority.make('steer')
						}))
						.pipe(taskFailure(envoyName, 'message admission'));
				}

				const onAssistantText = (part: Agents.AssistantTextPart) =>
					envoy.transport === 'email'
						? Effect.void
						: deliver(EffectId.make(`${effectId}:update:${part.callId}:${part.index}`), envoy, providerConversation, part.text).pipe(Effect.asVoid);

				let answered = 0;
				let remaining = rows.length;
				let answerOwed = false;
				let delivered = false;
				/** A turn that dies owes the sender a sentence. */
				const notifyFailure = (turn: number, reason: string) =>
					deliver(EffectId.make(`${effectId}:failure:${turn}`), envoy, providerConversation, `Sorry, I could not finish that: ${reason.slice(0, 500)}`, mail).pipe(Effect.asVoid);
				for (let turn = 0; turn < MAX_DRAIN_TURNS; turn += 1) {
					const subject = subjects[turn] ?? subjects.at(-1)!;
					const executed = yield* owned(agents.execute(EffectId.make(`${effectId}:execute:${turn}`), subject, internal, onAssistantText))
						.pipe(
							Effect.tapError((failure) => notifyFailure(turn, getErrorMessage(failure))),
							taskFailure(envoyName, 'Task execution')
						);
					if (executed.status === 'failed') yield* notifyFailure(turn, 'the request could not be completed.');
					if (executed.output !== undefined) {
						const answer = finalAnswerText(executed.output).trim();
						if (answer !== '') {
							answerOwed = true;
							delivered = (yield* deliver(EffectId.make(`${effectId}:answer:${turn}`), envoy, providerConversation, answer, mail)) || delivered;
						}
					}
					const settled = yield* settleAnswered(EffectId.make(`${effectId}:settle:${turn}`), internal);
					answered = settled.answered;
					remaining = settled.remaining;
					if (remaining === 0) break;
					if (executed.output === undefined && executed.status !== 'done') break;
				}
				// A queued message another turn is still working through keeps this claim alive.
				if (remaining > 0 && claim !== undefined) yield* queue.defer(EffectId.make(`${effectId}:defer`), claim.id, claim.attempt);
				return {
					envoy: envoyName,
					conversationId,
					drained: answered,
					status: remaining > 0 ? ('queued' as const) : answerOwed && !delivered ? ('failed' as const) : ('answered' as const)
				};
			})
		});
	})
);
