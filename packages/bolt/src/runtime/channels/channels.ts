import { Clock, Context, Effect, Layer, Option, Redacted, Result, Schema } from 'effect';
import {
	ChannelEvent,
	EffectId,
	MessageSchemas,
	PushSubscription,
	WEB_PUSH_PUBLIC_KEY_CONFIG_KEY,
	WEB_PUSH_SUBSCRIPTION_GONE,
	type ChannelEnvelope,
	type ChannelStatus,
	type HistoryChange,
	type HistoryState,
	type NotificationRecipient,
	type Transport
} from '@norbital-ai/bolt-protocol';
import type { ChannelDeclaration } from '#lib/authoring/channels-schema.js';
import type { IntegrationDeclaration } from '#lib/authoring/integrations-schema.js';
import { AuthoredRuntimeService } from '#lib/runtime/collections/authored.js';
import * as Collections from '#lib/runtime/collections/collections.js';
import { HostConfig } from '#lib/runtime/access/system-principal.js';
import { Communication, Connector, Files } from '#lib/runtime/facilities/services.js';
import * as Database from '#lib/runtime/facilities/database.js';
import { channelSubject } from '#lib/runtime/identity/static-identity.js';
import { performRequest, resolveConnection, retryDelayMs, connectionUrl } from '#lib/runtime/integrations/http.js';
import { verifyDelivery } from '#lib/runtime/integrations/signature.js';
import { Secrets } from '#lib/runtime/secrets/secrets.js';
import * as TaskQueue from '#lib/runtime/tasks/tasks.js';
import * as TenantScope from '#lib/runtime/tenant.js';
import { deriveRecordId } from '#lib/runtime/derive-record-id.js';
import * as Workspace from '#lib/runtime/workspace.js';
import { describeCause } from '#lib/runtime/workspace.js';

/** Carries a channel failure through its typed channel. */
export class ChannelError extends Schema.TaggedError<ChannelError>()('Bolt.Channels.Error', {
	channel: Schema.NonEmptyString,
	message: Schema.NonEmptyString
}) {
	readonly category = 'channel' as const;
	readonly retryable = false;
}

type Statement = Readonly<{ readonly sql: string; readonly parameters: ReadonlyArray<Schema.Json> }>;
type Values = Readonly<Record<string, unknown>>;

const DRAIN_BATCH = 50;
const MAX_ATTEMPTS = 8;
const Row = Schema.Record(Schema.String, Schema.Unknown);
const decodeRows = (rows: ReadonlyArray<unknown>): ReadonlyArray<Values> =>
	rows.flatMap((row) => {
		const decoded = Schema.decodeUnknownResult(Row)(row);
		return Result.isSuccess(decoded) ? [decoded.success] : [];
	});
const text = (value: unknown): string | null =>
	typeof value === 'string' ? value : typeof value === 'number' ? String(value) : null;
const numeric = (value: unknown): number => {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : 0;
};
const decodePushSubscriptions = Schema.decodeUnknownOption(Schema.Array(PushSubscription));

/** A stored attachment: provider facts plus the durable key when bytes were materialised at ingest. */
export const StoredAttachment = Schema.Struct({
	provider: Schema.NonEmptyString,
	attachmentId: Schema.NonEmptyString,
	kind: Schema.Literals(['image', 'video', 'audio', 'document', 'sticker', 'other']),
	mimeType: Schema.NonEmptyString,
	fileName: Schema.NonEmptyString,
	size: Schema.Number,
	key: Schema.optionalKey(Schema.NonEmptyString)
});
export interface StoredAttachment extends Schema.Schema.Type<typeof StoredAttachment> {}

/** One history row the ingest newly wrote: what the channel's consumers read next. */
export type IngestedRow = Readonly<{
	readonly id: string;
	readonly providerMessageId: string;
	readonly conversationId: string;
	readonly conversationKind: 'dm' | 'group';
	readonly direction: 'inbound' | 'outbound';
	readonly origin: 'live' | 'sync';
	readonly envelope: ChannelEnvelope;
	readonly version: string;
	readonly deleted: boolean;
	readonly inserted: boolean;
}>;

/** The provider conversation an envelope belongs to: a chat, a mail thread, an http delivery. */
export const conversationOf = (envelope: ChannelEnvelope): string =>
	envelope._tag === 'chat' ? envelope.conversationId : envelope._tag === 'email' ? envelope.threadId : envelope.messageId;

const senderOf = (envelope: ChannelEnvelope): Readonly<{ id: string | null; name: string | null }> =>
	envelope._tag === 'chat'
		? { id: envelope.sender?.id ?? null, name: envelope.sender?.displayName ?? null }
		: envelope._tag === 'email'
			? { id: envelope.from.address.toLowerCase(), name: envelope.from.name ?? null }
			: { id: null, name: null };

const bodyOf = (envelope: ChannelEnvelope): string =>
	envelope._tag === 'http' ? JSON.stringify(envelope.body) : envelope.text;

/** The statements `api.notify` and a collection notification rule commit: one outbox row per recipient per channel. */
export const notifyStatements = (
	channels: ReadonlyArray<ChannelDeclaration>,
	input: Readonly<{
		readonly key: string;
		readonly recipients: ReadonlyArray<NotificationRecipient>;
		readonly via: ReadonlyArray<string>;
		readonly message: Readonly<Record<string, Schema.Json>>;
	}>,
	effectId: string
): ReadonlyArray<Statement> =>
	input.via.flatMap((name) => {
		const channel = channels.find((candidate) => candidate.name === name);
		if (channel === undefined || channel.transport === 'http')
			throw new TypeError(`api.notify via ${name}: no person channel of that name is declared.`);
		const message = JSON.stringify(input.message);
		const rows = input.recipients.map((recipient) =>
			typeof recipient === 'string'
				? {
						sql: `insert into bolt_channel_outbox (id, channel, transport, message, recipient_user) values (md5($1 || ':' || $2 || ':' || $3)::uuid, $2, $4, $5::jsonb, $3) on conflict (id) do nothing`,
						parameters: [input.key, name, recipient, channel.transport, message] as ReadonlyArray<Schema.Json>
					}
				: // A team is its members at commit time, resolved in the write's own statement.
					{
						sql: `insert into bolt_channel_outbox (id, channel, transport, message, recipient_user) select md5($1 || ':' || $2 || ':' || u.id::text)::uuid, $2, $4, $5::jsonb, u.id::text from "user" as u join "team" as t on t.id = u.team_id where lower(t.name) = lower($3) on conflict (id) do nothing`,
						parameters: [input.key, name, recipient.team, channel.transport, message] as ReadonlyArray<Schema.Json>
					}
		);
		return [...rows, drainTaskStatement(name, `${effectId}:notify:${name}`)];
	});

/** The drain task a committed outbox row needs, in the same transaction. */
export const drainTaskStatement = (channel: string, effectId: string): Statement => ({
	sql: `insert into bolt_task (command, input, effect_id, status) values ('channels.drain', $1::jsonb, $2, 'pending') on conflict (effect_id) do nothing`,
	parameters: [JSON.stringify({ channel }), `channels.drain:${channel}:${effectId}`]
});

/** One outbound message a collection write fires (§9), or the reason its rule could not build one. */
export type OutboundRow = Readonly<{
	readonly channel: string;
	readonly transport: Transport;
	readonly rule: string;
	readonly message: unknown;
	readonly error: string | null;
	readonly thread: string | null;
}>;

/**
 * The outbound rules one written record fires. Pure and synchronous, on the write path; a builder
 * that throws, or builds a message its transport refuses, becomes a failed row — visible on the
 * delivery record — never a refused write and never a silent drop.
 */
export const outboundRows = (
	channels: ReadonlyArray<ChannelDeclaration>,
	authored: Readonly<Record<string, import('#lib/authoring/channels-schema.js').AuthoredChannel>>,
	collection: string,
	operation: 'create' | 'update' | 'delete',
	record: Values,
	previous: Values | undefined
): ReadonlyArray<OutboundRow> =>
	channels.flatMap((channel) =>
		channel.outbound.flatMap((rule) => {
			if (rule.from !== collection || !rule.events.includes(operation)) return [];
			const live = authored[channel.name]?.outbound[rule.name];
			if (live === undefined) return [];
			try {
				if (!live.matches(operation, record, previous)) return [];
				const message = live.message(previous === undefined ? { record } : { record, previous });
				const decoded = Schema.decodeUnknownResult(MessageSchemas[channel.transport] as Schema.Codec<unknown, unknown>)(message);
				const thread = Reflect.get(Object(message), 'thread');
				return [
					{
						channel: channel.name,
						transport: channel.transport,
						rule: rule.name,
						message: Result.isSuccess(decoded) ? decoded.success : null,
						error: Result.isSuccess(decoded) ? null : `the message does not fit ${channel.transport}: ${String(decoded.failure)}`,
						thread: typeof thread === 'string' ? thread : null
					}
				];
			} catch (cause) {
				return [{ channel: channel.name, transport: channel.transport, rule: rule.name, message: null, error: `the rule threw: ${describeCause(cause)}`, thread: null }];
			}
		})
	);

/**
 * `api.notify` and `api.channels.<n>.send` for an automation run: statements committed in their own
 * transaction, the host woken first. Built on the database and the queue alone, so the collections
 * runtime that hands an automation its api needs nothing from this service.
 */
export const automationChannels = (
	database: Database.Interface,
	queue: TaskQueue.Interface,
	channels: ReadonlyArray<ChannelDeclaration>,
	integrations: ReadonlyArray<IntegrationDeclaration>,
	effectId: EffectId
) => {
	let sequence = 0;
	const commit = (label: string, statements: ReadonlyArray<Statement>) =>
		Effect.gen(function* () {
			yield* queue.wake(EffectId.make(`${effectId}:${label}:wake`), yield* Clock.currentTimeMillis);
			yield* database.execute(EffectId.make(`${effectId}:${label}`), { _tag: 'Transaction', statements });
		});
	return {
		notify: (input: import('#lib/authoring/channels-schema.js').NotifyInput) =>
			Effect.gen(function* () {
				if (input.via.length === 0)
					return yield* new ChannelError({ channel: 'notify', message: 'api.notify needs a non-empty via: no delivery is implied.' });
				const label = `notify:${sequence++}`;
				const statements = yield* Effect.try({
					try: () =>
						notifyStatements(
							channels,
							{ key: input.key, recipients: input.recipients, via: input.via, message: { title: input.title, body: input.body, key: input.key } },
							`${effectId}:${label}`
						),
					catch: (cause) => new ChannelError({ channel: input.via.join(','), message: describeCause(cause) })
				});
				yield* commit(label, statements);
			}),
		channels: Object.fromEntries(
			channels
				.filter(({ transport }) => transport !== 'inbox')
				.map((channel) => [
					channel.name,
					{
						send: (message: unknown) =>
							Effect.gen(function* () {
								const decoded = Schema.decodeUnknownResult(MessageSchemas[channel.transport] as Schema.Codec<unknown, unknown>)(message);
								if (Result.isFailure(decoded))
									return yield* new ChannelError({ channel: channel.name, message: `the message does not fit ${channel.transport}: ${String(decoded.failure)}` });
								const label = `send:${channel.name}:${sequence++}`;
								const outboxId = deriveRecordId(`${effectId}:${label}`);
								yield* commit(label, sendStatements(channel, outboxId, decoded.success, {}, `${effectId}:${label}`));
								return { outboxId };
							})
					}
				])
		),
		/** `api.integrations.<name>.reconcile()`: every sync of the integration, queued as a full reconcile. */
		integrations: Object.fromEntries(
			integrations.map((integration) => [
				integration.name,
				{
					reconcile: () => {
						const label = `reconcile:${integration.name}:${sequence++}`;
						return commit(
							label,
							integration.syncs.map((sync) => ({
								sql: `insert into bolt_task (command, input, effect_id, status) values ('integrations.run', $1::jsonb, $2, 'pending') on conflict (effect_id) do nothing`,
								parameters: [
									JSON.stringify({ integration: integration.name, sync: sync.name, mode: 'reconcile' }),
									`${effectId}:${label}:${sync.name}`
								]
							}))
						);
					}
				}
			])
		)
	};
};

/** One outbound message, and the drain that sends it, as statements. */
export const sendStatements = (
	channel: ChannelDeclaration,
	outboxId: string,
	message: unknown,
	options: Readonly<{ readonly conversationId?: string; readonly thread?: string }>,
	effectId: string
): ReadonlyArray<Statement> => {
	const thread = options.thread ?? (typeof Reflect.get(Object(message), 'thread') === 'string' ? String(Reflect.get(Object(message), 'thread')) : null);
	return [
		{
			sql: `insert into bolt_channel_outbox (id, channel, transport, message, conversation_id, thread_key) values ($1::uuid, $2, $3, $4::jsonb, $5, $6) on conflict (id) do nothing`,
			parameters: [outboxId, channel.name, channel.transport, JSON.stringify(message), options.conversationId ?? null, thread]
		},
		drainTaskStatement(channel.name, effectId)
	];
};

export type Interface = Readonly<{
	/** Applies provider changes to a channel's history (§7): idempotent, version-guarded, tombstoning. */
	readonly ingest: (
		effectId: EffectId,
		channel: string,
		changes: ReadonlyArray<HistoryChange>,
		options: Readonly<{
			readonly state?: HistoryState;
			readonly horizon?: string;
			/** Where one message's attachment bytes are stored; the envoy scopes them to its conversation. */
			readonly attachmentKey?: (conversationId: string, conversationKind: string, messageId: string, index: number, fileName: string) => string;
		}>
	) => Effect.Effect<ReadonlyArray<IngestedRow>, ChannelError | Database.FacilityError>;
	readonly event: (
		effectId: EffectId,
		channel: string,
		events: ReadonlyArray<ChannelEvent>
	) => Effect.Effect<Schema.Json, ChannelError | Database.FacilityError>;
	/** Sends every due outbox row of one channel; retries and dead-letters on the row. */
	readonly drain: (effectId: EffectId, channel: string) => Effect.Effect<Schema.Json, ChannelError | Database.FacilityError>;
	/** `api.channels.<n>.send` and an envoy reply: one outbox row, committed, then drained. */
	readonly send: (
		effectId: EffectId,
		channel: string,
		message: unknown,
		options?: Readonly<{ readonly conversationId?: string; readonly thread?: string }>
	) => Effect.Effect<{ readonly outboxId: string }, ChannelError | Database.FacilityError>;
	readonly notify: (
		effectId: EffectId,
		input: Readonly<{
			readonly key: string;
			readonly recipients: ReadonlyArray<NotificationRecipient>;
			readonly title: string;
			readonly body: string;
			readonly via: ReadonlyArray<string>;
		}>
	) => Effect.Effect<void, ChannelError | Database.FacilityError>;
	/** One raw webhook delivery to an `http` channel, verified before it is read. */
	readonly receiveWebhook: (
		effectId: EffectId,
		channel: string,
		delivery: Readonly<{ readonly headers: Readonly<Record<string, string>>; readonly body: string }>
	) => Effect.Effect<ReadonlyArray<IngestedRow>, ChannelError | Database.FacilityError>;
	readonly status: (effectId: EffectId, channel: string) => Effect.Effect<ChannelStatus, ChannelError | Database.FacilityError>;
}>;

export const Service = Context.Service<Interface>('@norbital-ai/bolt/Channels');

type LayerServices =
	| Workspace.Interface
	| Database.Interface
	| TaskQueue.Interface
	| Collections.Interface
	| TenantScope.Interface
	| import('#lib/runtime/facilities/services.js').CommunicationInterface
	| import('#lib/runtime/facilities/services.js').ConnectorInterface
	| import('#lib/runtime/facilities/services.js').FilesInterface
	| import('#lib/runtime/secrets/secrets.js').Interface
	| import('#lib/runtime/collections/authored.js').AuthoredRuntime;

export const layer: Layer.Layer<Interface, never, LayerServices> = Layer.effect(
	Service,
	Effect.gen(function* () {
		const workspace = yield* Workspace.Service;
		const database = yield* Database.Service;
		const queue = yield* TaskQueue.Service;
		const collections = yield* Collections.Service;
		const tenant = yield* TenantScope.Service;
		const communication = yield* Communication.Service;
		const connector = yield* Connector.Service;
		const files = yield* Files.Service;
		const secrets = yield* Secrets.Service;
		const authored = yield* AuthoredRuntimeService;
		const hostConfig = yield* Effect.serviceOption(HostConfig);

		const query = (effectId: EffectId, sql: string, parameters: ReadonlyArray<Schema.Json>) =>
			database.execute(effectId, { _tag: 'Query', sql, parameters });
		const transaction = (effectId: EffectId, statements: ReadonlyArray<Statement>) =>
			database.execute(effectId, { _tag: 'Transaction', statements });

		const requireChannel = Effect.fn('Channels.require')(function* (name: string) {
			const channel = workspace.definition.channels.find((candidate) => candidate.name === name);
			if (channel === undefined) return yield* new ChannelError({ channel: name, message: 'Unknown channel' });
			return channel;
		});

		const bytesOf = (base64: string): Uint8Array => Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));

		const ingest: Interface['ingest'] = Effect.fn('Channels.ingest')(function* (effectId, name, changes, options) {
			const channel = yield* requireChannel(name);
			if (options.state !== undefined || options.horizon !== undefined)
				yield* query(
					EffectId.make(`${effectId}:state`),
					`insert into bolt_channel_state (channel, state, horizon) values ($1, coalesce($2, 'live'), $3) on conflict (channel) do update set state = coalesce($2, bolt_channel_state.state), horizon = coalesce($3, bolt_channel_state.horizon), updated_at = now()`,
					[name, options.state ?? null, options.horizon ?? null]
				);
			const upserts: Array<Values> = [];
			for (const [changeIndex, change] of changes.entries()) {
				if (change._tag !== 'Upsert') continue;
				const envelope = change.envelope;
				const conversation = conversationOf(envelope);
				const kind = envelope._tag === 'chat' ? envelope.conversationKind : envelope._tag === 'email' ? (new Set([envelope.from.address, ...envelope.cc.map(({ address }) => address)]).size > 1 ? 'group' : 'dm') : 'dm';
				const stored: Array<StoredAttachment> = [];
				const attachments = envelope._tag === 'http' ? [] : envelope.attachments;
				for (const [index, attachment] of attachments.entries()) {
					const descriptor = {
						provider: attachment.provider,
						attachmentId: attachment.attachmentId,
						kind: attachment.kind,
						mimeType: attachment.mimeType,
						fileName: attachment.fileName,
						size: attachment.byteLength
					};
					if (attachment.bytesBase64 === undefined) {
						stored.push(descriptor);
						continue;
					}
					const bytes = bytesOf(attachment.bytesBase64);
					if (bytes.byteLength !== attachment.byteLength)
						return yield* new ChannelError({ channel: name, message: `attachment ${attachment.attachmentId} did not match its declared byte length` });
					// Materialised once, at ingest: history is the durable home of the media.
					const key =
						options.attachmentKey?.(conversation, kind, envelope.messageId, index, attachment.fileName) ??
						`channels/${name}/${encodeURIComponent(envelope.messageId)}/${index}`;
					yield* files.execute(EffectId.make(`${effectId}:attachment:${changeIndex}:${index}`), { _tag: 'Write', key, bytes });
					stored.push({ ...descriptor, key });
				}
				const sender = senderOf(envelope);
				const withoutBytes =
					envelope._tag === 'http'
						? envelope
						: { ...envelope, attachments: envelope.attachments.map(({ bytesBase64: _bytes, ...rest }) => rest) };
				upserts.push({
					provider_message_id: envelope.messageId,
					conversation_id: conversation,
					conversation_kind: kind,
					direction: change.direction,
					origin: change.origin,
					version: change.version,
					sender_id: sender.id,
					sender_name: sender.name,
					sent_at: envelope.sentAt,
					invocation: envelope._tag === 'chat' ? envelope.invocation : envelope._tag === 'email' ? 'direct' : null,
					subject: envelope._tag === 'email' ? envelope.subject : null,
					text: bodyOf(envelope),
					envelope: withoutBytes,
					attachments: stored
				});
			}
			const tombstones = changes.flatMap((change) => (change._tag === 'Tombstone' ? [change.messageId] : []));
			const statements: Array<Statement> = [];
			if (upserts.length > 0)
				// One statement: a new message inserts; a newer version converges the row; an older or
				// equal one, or any change to a tombstoned row, changes nothing. `origin` never moves once
				// written, so history read back never becomes answerable.
				statements.push({
					sql: `insert into channel_messages (id, channel, transport, conversation_id, conversation_kind, direction, origin, provider_message_id, version, sender_id, sender_name, sent_at, invocation, subject, text, envelope, attachments) select md5($1 || ':' || x.provider_message_id)::uuid, $1, $2, x.conversation_id, x.conversation_kind, x.direction, x.origin, x.provider_message_id, x.version, x.sender_id, x.sender_name, x.sent_at::timestamptz, x.invocation, x.subject, x.text, x.envelope, x.attachments from jsonb_to_recordset($3::jsonb) as x(provider_message_id text, conversation_id text, conversation_kind text, direction text, origin text, version text, sender_id text, sender_name text, sent_at text, invocation text, subject text, text text, envelope jsonb, attachments jsonb) on conflict (channel, provider_message_id) do update set text = excluded.text, envelope = excluded.envelope, attachments = excluded.attachments, version = excluded.version, sender_name = coalesce(excluded.sender_name, channel_messages.sender_name), edited_at = now(), updated_at = now() where channel_messages.deleted_at is null and excluded.version > channel_messages.version returning id::text, provider_message_id, conversation_id, conversation_kind, direction, origin, envelope, version, (xmax = 0) as inserted`,
					parameters: [name, channel.transport, JSON.stringify(upserts)]
				});
			if (tombstones.length > 0)
				// A sender's delete is honoured: the row keeps its metadata and drops its text and media
				// from every read. An unseen message is tombstoned in advance, so a late upsert of it lands
				// on a deleted row and changes nothing (reordered provider events).
				statements.push({
					sql: `insert into channel_messages (id, channel, transport, conversation_id, conversation_kind, direction, origin, provider_message_id, version, sent_at, text, envelope, deleted_at) select md5($1 || ':' || m)::uuid, $1, $2, '', 'dm', 'inbound', 'sync', m, '', now(), '', '{}'::jsonb, now() from unnest($3::text[]) as m on conflict (channel, provider_message_id) do update set deleted_at = now(), text = '', attachments = '[]'::jsonb, envelope = jsonb_build_object('_tag', channel_messages.envelope->>'_tag', 'messageId', channel_messages.provider_message_id), updated_at = now() where channel_messages.deleted_at is null returning id::text, provider_message_id, conversation_id, conversation_kind, direction, origin, envelope, version, false as inserted`,
					parameters: [name, channel.transport, tombstones]
				});
			if (statements.length === 0) return [];
			const result = yield* transaction(EffectId.make(`${effectId}:history`), statements);
			const rows = decodeRows(result.rows);
			const tombstoned = new Set(tombstones);
			const ingested = rows.map(
				(row): IngestedRow => ({
					id: String(row['id']),
					providerMessageId: String(row['provider_message_id']),
					conversationId: String(row['conversation_id']),
					conversationKind: row['conversation_kind'] === 'group' ? 'group' : 'dm',
					direction: row['direction'] === 'outbound' ? 'outbound' : 'inbound',
					origin: row['origin'] === 'live' ? 'live' : 'sync',
					envelope: row['envelope'] as ChannelEnvelope,
					version: String(row['version']),
					deleted: tombstoned.has(String(row['provider_message_id'])),
					inserted: row['inserted'] === true
				})
			);
			const live = ingested.filter(({ direction, origin, inserted }) => direction === 'inbound' && origin === 'live' && inserted);
			if (live.length > 0)
				yield* query(EffectId.make(`${effectId}:last-inbound`), `insert into bolt_channel_state (channel, state, last_inbound_at) values ($1, 'live', now()) on conflict (channel) do update set last_inbound_at = now(), updated_at = now()`, [name]);
			// A reply to mail this channel sent is a provider report about that message (§9 `replied`).
			for (const row of live) {
				if (row.envelope._tag !== 'email') continue;
				const envelope = row.envelope;
				const references = [envelope.inReplyTo, ...(envelope.headers['references'] ?? '').split(/\s+/)].filter((value): value is string => value !== undefined && value !== '');
				if (references.length > 0)
					yield* event(EffectId.make(`${effectId}:replied:${row.id}`), name, [], { replied: { references, mail: envelope } });
			}
			return ingested;
		});

		/** Patches the record an outbound rule sent from, as the channel's own subject (§9). */
		const patchSource = Effect.fn('Channels.patchSource')(function* (
			effectId: EffectId,
			channel: ChannelDeclaration,
			outbox: Values,
			kind: 'sent' | 'delivered' | 'bounced' | 'opened' | 'failed' | 'replied',
			payload: Values
		) {
			const collection = text(outbox['source_collection']);
			const recordId = text(outbox['source_record_id']);
			const handler = authored.channels[channel.name]?.events[kind] as ((event: Values) => unknown) | undefined;
			if (collection === null || recordId === null || handler === undefined) return;
			const patch = yield* Effect.try({ try: () => handler(payload), catch: (cause) => cause }).pipe(
				Effect.catch((cause) => Effect.logWarning(`[bolt] channel ${channel.name} ${kind} handler threw: ${describeCause(cause)}`).pipe(Effect.as(undefined)))
			);
			if (patch === undefined || patch === null || typeof patch !== 'object' || Object.keys(patch).length === 0) return;
			yield* collections
				.write(effectId, channelSubject(channel, tenant.tenantId), [{ collection, action: 'update', inputs: [{ ...(patch as Values), id: recordId }] }])
				.pipe(Effect.catch((error) => Effect.logWarning(`[bolt] channel ${channel.name} ${kind} patch on ${collection} refused: ${describeCause(error)}`)));
		});

		const event = Effect.fn('Channels.event')(function* (
			effectId: EffectId,
			name: string,
			events: ReadonlyArray<ChannelEvent>,
			derived?: Readonly<{ readonly replied: Readonly<{ readonly references: ReadonlyArray<string>; readonly mail: ChannelEnvelope }> }>
		) {
			const channel = yield* requireChannel(name);
			let applied = 0;
			const correlate = (ids: ReadonlyArray<string>) =>
				query(EffectId.make(`${effectId}:outbox:${applied}`), `select id::text, source_collection, source_record_id, provider_message_id from bolt_channel_outbox where channel = $1 and provider_message_id = any($2::text[]) order by sequence desc limit 1`, [name, [...ids]]).pipe(
					Effect.map((result) => decodeRows(result.rows)[0])
				);
			if (derived !== undefined) {
				const outbox = yield* correlate(derived.replied.references);
				if (outbox !== undefined) {
					yield* patchSource(EffectId.make(`${effectId}:replied`), channel, outbox, 'replied', { at: derived.replied.mail.sentAt, mail: derived.replied.mail });
					applied += 1;
				}
				return { applied };
			}
			for (const [index, reported] of events.entries()) {
				const outbox = yield* correlate([reported.providerMessageId]);
				if (outbox === undefined) continue;
				const reason = typeof reported.detail['reason'] === 'string' ? reported.detail['reason'] : reported.kind;
				if (reported.kind === 'bounced' || reported.kind === 'failed')
					yield* query(EffectId.make(`${effectId}:settle:${index}`), `update bolt_channel_outbox set status = 'failed', last_error = $2, updated_at = now() where id = $1::uuid`, [String(outbox['id']), reason]);
				yield* patchSource(EffectId.make(`${effectId}:patch:${index}`), channel, outbox, reported.kind, {
					at: reported.observedAt,
					...(reported.kind === 'bounced' || reported.kind === 'failed' ? { reason } : {}),
					...(reported.kind === 'replied' ? { mail: reported.detail['mail'] ?? null } : {})
				});
				applied += 1;
			}
			return { applied };
		});

		const pushPublicKey = () =>
			Option.isNone(hostConfig)
				? Effect.succeedNone
				: hostConfig.value.read(WEB_PUSH_PUBLIC_KEY_CONFIG_KEY).pipe(
						Effect.map(Option.map(Redacted.value)),
						Effect.orElseSucceed(() => Option.none<string>())
					);

		/** The inbox transport: the ledger row, then a best-effort push to every subscribed browser. */
		const deliverInbox = Effect.fn('Channels.deliverInbox')(function* (effectId: EffectId, row: Values) {
			const recipient = text(row['recipient_user']);
			const message = (row['message'] as Values | null) ?? {};
			if (recipient === null) return { status: 'skipped' as const, error: 'an inbox message names no recipient' };
			yield* query(
				EffectId.make(`${effectId}:ledger`),
				`insert into bolt_notifications (id, recipient, payload, read, delivered_at) values ($1::uuid, $2, $3::jsonb, false, now()) on conflict (id) do nothing`,
				[String(row['id']), recipient, JSON.stringify({ channel: row['channel'], ...message })]
			);
			if (Option.isNone(yield* pushPublicKey())) return { status: 'sent' as const };
			const subscriptions = decodePushSubscriptions(
				(yield* query(EffectId.make(`${effectId}:subscriptions`), `select endpoint, keys from bolt_push_subscriptions where recipient = $1`, [recipient])).rows
			);
			for (const subscription of Option.getOrElse(subscriptions, () => [])) {
				const pushed = yield* communication
					.execute(EffectId.make(`${effectId}:push`), {
						_tag: 'Push',
						subscription,
						title: typeof message['title'] === 'string' && message['title'] !== '' ? message['title'] : workspace.definition.name,
						body: typeof message['body'] === 'string' ? message['body'] : ''
					})
					.pipe(Effect.result);
				if (Result.isFailure(pushed) && pushed.failure.code === WEB_PUSH_SUBSCRIPTION_GONE)
					yield* query(EffectId.make(`${effectId}:gone`), `delete from bolt_push_subscriptions where recipient = $1 and endpoint = $2`, [recipient, subscription.endpoint]);
			}
			return { status: 'sent' as const };
		});

		/** A person's verified address on a transport: email by sign-in, chat by a redeemed registration. */
		const addressOf = Effect.fn('Channels.addressOf')(function* (effectId: EffectId, userId: string, transport: Transport) {
			const rows = decodeRows(
				(yield* query(effectId, `select email, channels from "user" where id::text = $1`, [userId])).rows
			);
			const user = rows[0];
			if (user === undefined) return null;
			// A workspace address is proven by signing in with it: sign-in is a code sent to it.
			if (transport === 'email' && typeof user['email'] === 'string' && user['email'] !== '') return user['email'];
			const identities = Array.isArray(user['channels']) ? (user['channels'] as ReadonlyArray<Values>) : [];
			const found = identities.find((identity) => identity['type'] === transport && identity['verified'] === true);
			return typeof found?.['address'] === 'string' ? found['address'] : null;
		});

		/** The thread a mail belongs to: every message id seen in it, oldest first. */
		const threadOf = Effect.fn('Channels.threadOf')(function* (effectId: EffectId, channel: string, thread: string) {
			const rows = decodeRows(
				(yield* query(
					effectId,
					`select provider_message_id from channel_messages where channel = $1 and deleted_at is null and (conversation_id = $2 or outbox_id in (select id::text from bolt_channel_outbox where channel = $1 and thread_key = $2)) order by sent_at limit 50`,
					[channel, thread]
				)).rows
			);
			return rows.map((row) => String(row['provider_message_id']));
		});

		const sendOne = Effect.fn('Channels.sendOne')(function* (effectId: EffectId, channel: ChannelDeclaration, row: Values) {
			if (channel.transport === 'inbox') return yield* deliverInbox(effectId, row);
			let message = row['message'] as Values | null;
			const recipient = text(row['recipient_user']);
			if (recipient !== null) {
				const address = yield* addressOf(EffectId.make(`${effectId}:address`), recipient, channel.transport);
				if (address === null) return { status: 'skipped' as const, error: `no verified ${channel.transport} address` };
				const title = String(message?.['title'] ?? '');
				const body = String(message?.['body'] ?? '');
				message = channel.transport === 'email' ? { to: [address], subject: title, text: body } : { to: address, text: title === '' ? body : `${title}\n\n${body}` };
			}
			const decoded = Schema.decodeUnknownResult(MessageSchemas[channel.transport] as Schema.Codec<unknown, unknown>)(message);
			if (Result.isFailure(decoded)) return { status: 'failed' as const, error: `the message does not fit ${channel.transport}: ${String(decoded.failure)}` };
			if (channel.transport === 'http') {
				const request = decoded.success as { method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; path: string; query?: Record<string, string>; body?: Schema.Json };
				const resolved = yield* resolveConnection(
					(id, secret) =>
						secrets.read(id, secret).pipe(
							Effect.mapError((error) => ({ message: describeCause(error) })),
							Effect.flatMap((value) => (value === null || value === '' ? Effect.fail({ message: `${channel.name} needs ${secret}` }) : Effect.succeed(value)))
						),
					EffectId.make(`${effectId}:connection`),
					channel.connection!
				).pipe(Effect.result);
				if (Result.isFailure(resolved)) return { status: 'failed' as const, error: resolved.failure.message };
				const url = connectionUrl(resolved.success, request.path);
				for (const [key, value] of Object.entries(request.query ?? {})) url.searchParams.set(key, value);
				const answer = yield* performRequest(connector, EffectId.make(`${effectId}:http`), { method: request.method, url: url.toString(), headers: { ...resolved.success.headers, 'idempotency-key': String(row['id']) }, ...(request.body === undefined ? {} : { body: request.body }) }, undefined).pipe(Effect.result);
				if (Result.isFailure(answer)) return { status: answer.failure.retryable ? ('retry' as const) : ('failed' as const), error: answer.failure.message };
				return { status: 'sent' as const, providerMessageId: String(row['id']) };
			}
			const thread = text(row['thread_key']) ?? (channel.transport === 'email' ? text(row['conversation_id']) : null);
			const references = thread === null ? [] : yield* threadOf(EffectId.make(`${effectId}:thread`), channel.name, thread);
			const receipt = yield* communication
				.execute(EffectId.make(`${effectId}:send`), {
					_tag: 'Send',
					channel: channel.name,
					transport: channel.transport,
					outboxId: String(row['id']),
					message: decoded.success as Schema.Json,
					...(references.length === 0 ? {} : { inReplyTo: references.at(-1)!, references })
				})
				.pipe(Effect.result);
			if (Result.isFailure(receipt)) return { status: receipt.failure.retryable ? ('retry' as const) : ('failed' as const), error: `${receipt.failure.code}: ${receipt.failure.message}` };
			const providerMessageId = receipt.success.providerMessageId ?? String(row['id']);
			// The sent message is history too (§7.2), so the chat an envoy reads back is what was sent.
			const sentAt = new Date(yield* Clock.currentTimeMillis).toISOString();
			const sent = decoded.success as Values;
			const envelope: ChannelEnvelope =
				channel.transport === 'email'
					? {
							_tag: 'email',
							messageId: providerMessageId,
							threadId: references[0] ?? thread ?? providerMessageId,
							from: { address: channel.address ?? channel.name },
							to: (sent['to'] as ReadonlyArray<string>).map((address) => ({ address })),
							cc: ((sent['cc'] as ReadonlyArray<string> | undefined) ?? []).map((address) => ({ address })),
							subject: String(sent['subject']),
							text: receipt.success.body ?? String(sent['text'] ?? ''),
							...(typeof sent['html'] === 'string' ? { html: sent['html'] } : {}),
							attachments: [],
							sentAt,
							headers: {}
						}
					: {
							_tag: 'chat',
							conversationId: text(row['conversation_id']) ?? String(sent['to']),
							conversationKind: 'dm',
							messageId: providerMessageId,
							sentAt,
							invocation: 'direct',
							text: receipt.success.body ?? String(sent['text']),
							attachments: []
						};
			yield* ingest(EffectId.make(`${effectId}:history`), channel.name, [{ _tag: 'Upsert', envelope, version: sentAt, origin: 'live', direction: 'outbound' }], {});
			yield* query(EffectId.make(`${effectId}:link`), `update channel_messages set outbox_id = $3 where channel = $1 and provider_message_id = $2`, [channel.name, providerMessageId, String(row['id'])]);
			return { status: 'sent' as const, providerMessageId };
		});

		const drain: Interface['drain'] = Effect.fn('Channels.drain')(function* (effectId, name) {
			const channel = yield* requireChannel(name);
			const claimed = decodeRows(
				(yield* query(
					EffectId.make(`${effectId}:claim`),
					`update bolt_channel_outbox set status = 'inflight', attempts = attempts + 1, updated_at = now() where id in (select id from bolt_channel_outbox where channel = $1 and (status = 'pending' or (status = 'inflight' and updated_at < now() - interval '10 minutes')) and next_attempt_at <= now() order by sequence limit $2 for update skip locked) returning *`,
					[name, DRAIN_BATCH]
				)).rows
			).toSorted((left, right) => numeric(left['sequence']) - numeric(right['sequence']));
			let sent = 0;
			for (const row of claimed) {
				const id = String(row['id']);
				const outcome = yield* sendOne(EffectId.make(`${effectId}:${id}`), channel, row).pipe(
					Effect.catch((error) => Effect.succeed({ status: 'retry' as const, error: describeCause(error) }))
				);
				const attempts = numeric(row['attempts']);
				if (outcome.status === 'sent') {
					sent += 1;
					yield* query(EffectId.make(`${effectId}:${id}:sent`), `update bolt_channel_outbox set status = 'sent', provider_message_id = $2, sent_at = now(), last_error = null, updated_at = now() where id = $1::uuid`, [id, 'providerMessageId' in outcome ? outcome.providerMessageId ?? null : null]);
					yield* patchSource(EffectId.make(`${effectId}:${id}:sent-event`), channel, row, 'sent', { at: new Date(yield* Clock.currentTimeMillis).toISOString() });
					continue;
				}
				const retry = outcome.status === 'retry' && attempts < MAX_ATTEMPTS;
				const delay = Math.ceil(retryDelayMs(attempts - 1, { initialDelayMs: 1000, maxDelayMs: 300_000 }, undefined, 0) / 1000);
				yield* query(
					EffectId.make(`${effectId}:${id}:settle`),
					`update bolt_channel_outbox set status = $2, last_error = $3, next_attempt_at = now() + make_interval(secs => $4), updated_at = now() where id = $1::uuid`,
					[id, retry ? 'pending' : outcome.status === 'skipped' ? 'skipped' : 'failed', outcome.error.slice(0, 2000), delay]
				);
				// A send refused for good is the record's failure too; the relay never reports one it never took.
				if (!retry && outcome.status !== 'skipped')
					yield* patchSource(EffectId.make(`${effectId}:${id}:failed-event`), channel, row, 'failed', { at: new Date(yield* Clock.currentTimeMillis).toISOString(), reason: outcome.error.slice(0, 500) });
			}
			const due = decodeRows((yield* query(EffectId.make(`${effectId}:due`), `select min(next_attempt_at) as due from bolt_channel_outbox where channel = $1 and status = 'pending'`, [name])).rows)[0]?.['due'];
			const dueAt = typeof due === 'string' ? Date.parse(due) : Number.NaN;
			if (Number.isFinite(dueAt)) {
				yield* queue.wake(EffectId.make(`${effectId}:wake`), dueAt);
				yield* query(
					EffectId.make(`${effectId}:again`),
					`insert into bolt_task (command, input, effect_id, run_at, status) values ('channels.drain', $1::jsonb, $2, $3, 'pending') on conflict (effect_id) do nothing`,
					[JSON.stringify({ channel: name }), `channels.drain:${name}:${new Date(dueAt).toISOString()}`, new Date(dueAt).toISOString()]
				);
			}
			return { channel: name, claimed: claimed.length, sent };
		});

		const send: Interface['send'] = Effect.fn('Channels.send')(function* (effectId, name, message, options = {}) {
			const channel = yield* requireChannel(name);
			if (channel.transport === 'inbox') return yield* new ChannelError({ channel: name, message: 'An inbox channel is reached through api.notify.' });
			const decoded = Schema.decodeUnknownResult(MessageSchemas[channel.transport] as Schema.Codec<unknown, unknown>)(message);
			if (Result.isFailure(decoded)) return yield* new ChannelError({ channel: name, message: `the message does not fit ${channel.transport}: ${String(decoded.failure)}` });
			const outboxId = deriveRecordId(`${effectId}:send`);
			yield* queue.wake(EffectId.make(`${effectId}:wake`), yield* Clock.currentTimeMillis);
			yield* transaction(EffectId.make(`${effectId}:enqueue`), sendStatements(channel, outboxId, decoded.success, options, `${effectId}`));
			return { outboxId };
		});

		const notify: Interface['notify'] = Effect.fn('Channels.notify')(function* (effectId, input) {
			if (!workspace.definition.channels.some(({ transport }) => transport !== 'http'))
				return yield* new ChannelError({ channel: 'notify', message: 'api.notify needs a declared person channel.' });
			if (input.via.length === 0) return yield* new ChannelError({ channel: 'notify', message: 'api.notify needs a non-empty via.' });
			const statements = yield* Effect.try({
				try: () => notifyStatements(workspace.definition.channels, { key: input.key, recipients: input.recipients, via: input.via, message: { title: input.title, body: input.body, key: input.key } }, `${effectId}`),
				catch: (cause) => new ChannelError({ channel: input.via.join(','), message: describeCause(cause) })
			});
			yield* queue.wake(EffectId.make(`${effectId}:wake`), yield* Clock.currentTimeMillis);
			yield* transaction(EffectId.make(`${effectId}:notify`), statements);
		});

		const receiveWebhook: Interface['receiveWebhook'] = Effect.fn('Channels.receiveWebhook')(function* (effectId, name, delivery) {
			const channel = yield* requireChannel(name);
			const webhook = channel.webhook;
			if (channel.transport !== 'http' || webhook === undefined) return yield* new ChannelError({ channel: name, message: 'This channel receives no webhook.' });
			const secret = yield* secrets.read(effectId, webhook.signature.secret.env).pipe(Effect.mapError((error) => new ChannelError({ channel: name, message: describeCause(error) })));
			const verdict = yield* verifyDelivery(webhook.signature, secret ?? '', delivery, yield* Clock.currentTimeMillis).pipe(Effect.mapError((error) => new ChannelError({ channel: name, message: describeCause(error) })));
			if (!verdict.verified) return yield* new ChannelError({ channel: name, message: `delivery refused: ${verdict.refusal.reason}` });
			const body = yield* Effect.try({ try: () => JSON.parse(delivery.body) as Schema.Json, catch: () => new ChannelError({ channel: name, message: 'delivery body is not JSON' }) });
			const headers = Object.fromEntries(Object.entries(delivery.headers).map(([key, value]) => [key.toLowerCase(), value]));
			const messageId = (webhook.eventIdHeader === undefined ? undefined : headers[webhook.eventIdHeader.toLowerCase()]) ?? verdict.proof.digest;
			const sentAt = new Date(yield* Clock.currentTimeMillis).toISOString();
			return yield* ingest(effectId, name, [{ _tag: 'Upsert', envelope: { _tag: 'http', messageId, headers, body, sentAt }, version: sentAt, origin: 'live', direction: 'inbound' }], {});
		});

		const status: Interface['status'] = Effect.fn('Channels.status')(function* (effectId, name) {
			const channel = yield* requireChannel(name);
			const row = decodeRows(
				(yield* query(
					effectId,
					`select (select state from bolt_channel_state where channel = $1) as state, (select horizon from bolt_channel_state where channel = $1) as horizon, (select last_inbound_at from bolt_channel_state where channel = $1) as last_inbound_at, (select count(*) from channel_messages where channel = $1 and direction = 'inbound') as received, (select count(*) from bolt_channel_outbox where channel = $1 and status = 'sent') as sent, (select count(*) from bolt_channel_outbox where channel = $1 and status in ('pending', 'inflight')) as pending, (select count(*) from bolt_channel_outbox where channel = $1 and status = 'failed') as failed`,
					[name]
				)).rows
			)[0] ?? {};
			return {
				channel: name,
				transport: channel.transport,
				history: (text(row['state']) ?? (channel.transport === 'inbox' ? 'live' : 'unlinked')) as HistoryState,
				horizon: text(row['horizon']),
				lastInboundAt: text(row['last_inbound_at']),
				received: numeric(row['received']),
				sent: numeric(row['sent']),
				pending: numeric(row['pending']),
				failed: numeric(row['failed'])
			};
		});

		return Service.of({
			ingest,
			event: (effectId, name, events) => event(effectId, name, events),
			drain,
			send,
			notify,
			receiveWebhook,
			status
		});
	})
);
