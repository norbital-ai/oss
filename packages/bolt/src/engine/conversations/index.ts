// Conversations: what a conversation instance's link hands the engine, and the messages it sends. Each
// inbound message is one statement keyed by its instance: the conversation (a DM or a group), the message by
// `(instance, provider_id)` — a newer version converges it, a revoke tombstones it, an admitted row keeps the transcript
// the agent saw — its files, the sync inbox and, for a new live message on an active workspace
// instance with an envoy, its `envoys.admit` run: everything is durable before the link acknowledges. A personal (owner)
// instance imports its account (origin `sync`), never sends and never admits. A file a row cannot store stays a named
// descriptor (no `id`) and a malformed message is logged: neither is a failure the link would redeliver forever.
// Replies are matched to the outbound row they answer — a redelivered one again, since a match that failed after its row
// was stored is what the provider redelivers it for; every send is a queued row `integrations.deliver` delivers. A cleared
// or deleted chat tombstones its rows up to the clear in one statement, under the same admitted-transcript rule.
// A webhook is a hint, not the state: `recent` names the threads a link reconciles and `repair` passes what differs
// from the platform's view of one through this same path.
import { sql } from '../db/sql.ts';
import { Clock, Crypto, Effect, Layer, Option, Predicate, Schema } from 'effect';
import { enqueue, next_due } from '../runs/queue.ts';
import type { Json } from '../../decl/values.ts';
import type { DriverEvent, ReconcilePage } from '../contracts.ts';
import { Files, Logs, type LogsShape } from '../ports.ts';
import { Port, uuid } from '../port.ts';
import { TenantDb } from '../db/tenant-db.ts';
import { CapturedResult, capturePiece, nativeCommit } from '../db/captured.ts';
import { DbError } from '../errors.ts';
import {
	Conversations as ConversationsTag,
	Manifest,
	Live,
	Outbound as OutboundTag,
	Wake,
	RunHandlers,
	type OutboundShape
} from '../services.ts';
import { LIMITS } from '../contracts.ts';
import { BoltError } from '../../protocol/errors.ts';
import type { AgentEngine } from '../agent/index.ts';
import { conversationOf, definitionOf } from '../integrations/instances.ts';
import { notice_sends, prepareNoticeFiles } from '../notifications/notify.ts';
import { NOTICE_DELIVER } from '../notifications/queue.ts';
import { inboxPiece } from '../sync/hint.ts';
import { canonical } from '@norbital-ai/store';
import { Chain } from '../write/sql.ts';
import { heldLonger } from '../agent/throttle.ts';
import { InboundMessage, normalizeInbound, type Inbound } from './inbound.ts';
import { ImportStart } from '../../protocol/schema.ts';
import { permitsImport } from '../integrations/import-start.ts';
import { prepareSend, sendPiece } from './outbound.ts';
import { is_auto_reply, is_reported } from './status.ts';
import { delivery_piece } from '../integrations/outbound.ts';
import {
	ADMIT,
	conversationId,
	messageId,
	preview,
	stableId,
	msg as messagePiece
} from './store.ts';
type ConversationsConfig = {
	crypto: Crypto.Crypto;
	engine: Pick<AgentEngine, 'manifest' | 'db' | 'live'>;
	files?: Files['Service'];
	filesReady: (ids: readonly string[]) => Effect.Effect<void, import('../errors.ts').EngineError>;
	logs: LogsShape;
	clock?: Effect.Effect<string>;
	/** The engine's wake: a statement here queued runs due at `at` (admission, sync, delivery). */
	announce?: (at: string) => Effect.Effect<void>;
	/** The outbound area's delivery (`integrations.deliver`), its reports and reply matching. */
	outbound: Pick<OutboundShape, 'deliver' | 'delivered' | 'reference'>;
};
/** The instance a message arrived on: its definition, the kind of messages it carries and its owner (personal: sync only). */
type Instance = {
	id: string;
	integration: string;
	owner: string | null;
	kind: 'chat' | 'email';
	import_start: ImportStart | null;
	importStartRaw: Json;
};
/** An admitted row (`role` set) keeps its transcript content; only unadmitted history is rewritten by an edit or a revoke. */
const KEEP = (col: string) =>
	`CASE WHEN sys_message.role IS NULL AND excluded.version > sys_message.version THEN excluded.${col} ELSE sys_message.${col} END`;
/** A revoke, a delete for me or a cleared chat stamps `deleted_at` on every row; it erases content only where no agent saw it. */
const TOMBSTONE = `text = CASE WHEN sys_message.role IS NULL THEN '' ELSE sys_message.text END, preview = CASE WHEN sys_message.role IS NULL THEN '' ELSE sys_message.preview END,
	email = CASE WHEN sys_message.role IS NULL THEN NULL ELSE sys_message.email END`;
/** What a reconcile walks: threads with activity this recently, this many at most. */
const RECENT_MS = 7 * 86_400_000,
	RECENT_THREADS = 200;
/** The stored rows of a thread a repair compares at most, newest first; an older one stays as it is. */
const REPAIR_ROWS = 1000;
/** A message this young may simply not be in the page yet, so it is never called deleted. Above a link call's wall. */
const SETTLE_MS = 5 * 60_000;
/**
 * The rule for a repaired message and an envoy: it is history, which no envoy answers, unless it is new and younger
 * than this. A sender that recent may still be waiting, so it is admitted as its delivery would have been; anything
 * older has moved on, and a reply would answer something long past. An edit or a delete never admits.
 */
const REPLY_WINDOW_MS = 3_600_000;
const StoredMessage = Schema.Struct({
	provider_id: Schema.String,
	version: Schema.NullOr(Schema.String),
	origin: Schema.NullOr(Schema.String),
	deleted: Schema.Boolean,
	settled: Schema.Boolean
});
const decodeInbound = Schema.decodeUnknownOption(InboundMessage);
const Queued = Schema.Struct({
	...CapturedResult.fields,
	admitted: Schema.Boolean,
	next_due: Schema.NullOr(Schema.String)
});
const Due = Schema.Struct({ ...CapturedResult.fields, due: Schema.NullOr(Schema.String) });
const source_changed = (event: 'message' | 'clear') =>
	BoltError.make('source_changed', 'admission',
		`The integration import start changed; redeliver this ${event}.`);
export function conversations(cfg: ConversationsConfig) {
	const { manifest: m, db } = cfg.engine;
	const newId = uuid(cfg.crypto);
	const clock =
		cfg.clock ?? Clock.currentTimeMillis.pipe(Effect.map((now) => new Date(now).toISOString()));
	const announce = (at: string | null | undefined) =>
		at == null ? Effect.void : cfg.announce?.(at) ?? Effect.void;
	const instanceOf = Effect.fn('Agents.instanceOf')(function* (id: string) {
		const found = yield* db.one(
			Schema.Struct({
				integration: Schema.String,
				owner: Schema.NullOr(Schema.String),
				import_start: Schema.NullOr(Schema.Json)
			}),
			{
				text: 'SELECT integration, owner, import_start FROM sys_integration WHERE id = $1',
				params: [id]
			}
		);
		const row = Option.getOrUndefined(found),
			def = row === undefined ? undefined : definitionOf(m, row.integration);
		const conv = def === undefined ? undefined : conversationOf(def);
		if (row === undefined || conv === undefined)
			return yield* Effect.fail(
				BoltError.make('not_found', 'decode', `no conversation instance '${id}'`)
			);
		const import_start = yield* Schema.decodeUnknownEffect(Schema.NullOr(ImportStart))(
			row.import_start
		).pipe(
			Effect.mapError(() =>
				BoltError.make('invalid_input', 'admission', 'The integration import start is invalid.')
			)
		);
		return {
			id,
			integration: row.integration,
			owner: row.owner,
			kind: conv.kind,
			import_start,
			importStartRaw: row.import_start
		};
	});
	const files = Effect.fn('Agents.files')(function* (
		instance: string,
		inbound: Inbound,
		bins: readonly Uint8Array[] | undefined,
		c: Chain,
		now: string
	) {
		const out: Json[] = [];
		for (const [i, a] of inbound.attachments.entries()) {
			const named = { name: a.name, mime: a.mime, bytes: a.bytes };
			const data = a.bin === undefined ? undefined : bins?.[a.bin];
			if (
				a.id !== undefined ||
				data === undefined ||
				data.byteLength !== a.bytes ||
				data.byteLength > LIMITS.storedFileBytes
			) {
				out.push(a.id === undefined ? named : { id: a.id, ...named });
				continue;
			}
			const port = cfg.files;
			if (port === undefined)
				return yield* Effect.fail(
					BoltError.make('files', 'facility', 'the host provides no files')
				);
			const blob = yield* port.put(data, { name: a.name, mime: a.mime }).pipe(
				Port.call('files', LIMITS.callMs.attachment),
				Effect.mapError((error) => BoltError.make('files', 'facility', error.message, error))
			);
			const id = stableId('file', instance, inbound.id, String(i));
			capturePiece(c,
				`f${i}`,
				'sys_file',
				`INSERT INTO sys_file (id, name, mime, size, key, sha256, field, created_at) SELECT ${c.p(id)}, ${c.p(a.name)}, ${c.p(a.mime)},
				${c.p(data.byteLength)}, ${c.p(blob.key)}, ${c.p(blob.sha256)}, 'sys_conversation.inputs', ${c.p(now)}::timestamptz WHERE EXISTS (SELECT 1 FROM source) ON CONFLICT (id) DO NOTHING`
			);
			out.push({ id, ...named });
		}
		return out;
	});
	/**
	 * The runs a changed message queues in its own statement: the definition's sync inbox (its edits and recalls
	 * too) and, for a new live message (`admit`), its admission while the instance is active, has an envoy and no owner.
	 */
	function queue(
		c: Chain,
		inst: Instance,
		msg: string,
		id: string,
		version: string,
		admit: {
			mentions: readonly string[];
		} | null,
		now: string,
		deleted = false
	): void {
		inboxPiece(
			m,
			c,
			'message_inbox',
			inst.id,
			inst.integration,
			() => `SELECT ${c.p(`${id}:${version}:${deleted}`)}::text AS delivery,
			jsonb_build_object('kind', 'message', 'id', ${c.p(id)}::text) AS body WHERE EXISTS (SELECT 1 FROM ${msg})`,
			now
		);
		if (admit !== null)
			enqueue(
				c,
				{
					select: `SELECT '${ADMIT}'::text AS automation, ${c.p({ message: id, mentions: admit.mentions })}::jsonb AS input,
                ${c.p(now)}::timestamptz AS due_at, ${c.p(JSON.stringify([ADMIT, id]))}::text AS key, 'provider'::text AS cause, 0 AS depth
                WHERE EXISTS (SELECT 1 FROM ${msg} WHERE inserted)
                AND EXISTS (SELECT 1 FROM sys_integration i WHERE i.id = ${c.p(inst.id)} AND i.active AND i.envoy IS NOT NULL AND i.owner IS NULL)`
				},
				{ conflict: 'keep' }
			);
	}
	const ingest = Effect.fn('Agents.ingest')(function* (
		inst: Instance,
		message: Json,
		bins: readonly Uint8Array[] | undefined,
		history: boolean
	) {
		const now = yield* clock,
			c = new Chain();
		const decoded = yield* Schema.decodeUnknownEffect(InboundMessage)(message).pipe(
			Effect.catch(() => Effect.succeed(null))
		);
		let normalized =
			decoded === null || !Predicate.isObject(message)
				? null
				: normalizeInbound(inst.kind, decoded, message, history, now);
		if (normalized === null) {
			// the link's bug, never a row: recorded, and acknowledged so the message does not hold the instance's inbound
			yield* cfg.logs.write({
				at: now,
				severity: 'warn',
				event: 'conversation.malformed',
				invocation: inst.id,
				run: null,
				conversation: null,
				turn: null,
				attributes: { instance: inst.id, message: preview(JSON.stringify(message)) }
			});
			return null;
		}
		if (inst.kind === 'email' && !normalized.deleted && normalized.references.length > 0) {
			// Provider ids are registered before sending; a fast reply may precede its acknowledgement.
			const linked = yield* db.one(Schema.Struct({ thread: Schema.String }), {
				text: `SELECT c.thread FROM jsonb_array_elements_text($2::jsonb) WITH ORDINALITY AS ref(id, position)
				JOIN sys_message sent ON sent.integration = $1 AND sent.provider_id = ref.id
				JOIN sys_conversation c ON c.id = sent.conversation
				WHERE sent.direction = 'outbound' AND sent.deleted_at IS NULL
				AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(coalesce(sent.message->'to', '[]'::jsonb)
					|| coalesce(sent.message->'cc', '[]'::jsonb) || coalesce(sent.message->'bcc', '[]'::jsonb)) recipient(address)
					WHERE lower(recipient.address) = lower($3))
				ORDER BY ref.position, sent.seq DESC LIMIT 1`,
				params: [inst.id, JSON.stringify(normalized.references), normalized.sender]
			});
			if (Option.isSome(linked)) normalized = { ...normalized, thread: linked.value.thread };
		}
		const inbound = normalized;
		if (!permitsImport(inst.import_start, inbound.source_at ?? undefined)) {
			if (!inbound.deleted || inbound.source_at !== null) return null;
			const previous = yield* db.one(Schema.Struct({ source_at: Schema.NullOr(Schema.String) }), {
				text: 'SELECT source_at::text AS source_at FROM sys_message WHERE id = $1 AND integration = $2',
				params: [messageId(inst.id, inbound.id), inst.id]
			});
			if (
				Option.isNone(previous) ||
				!permitsImport(inst.import_start, previous.value.source_at ?? undefined)
			)
				return null;
		}
		// The row lock and equality fence make a concurrent boundary change precede or follow this whole ingest.
		c.cte(
			'source',
			`SELECT id FROM sys_integration WHERE id = ${c.p(inst.id)} AND import_start IS NOT DISTINCT FROM ${c.p(inst.importStartRaw)}::jsonb FOR SHARE`
		);
		const personal = inst.owner !== null,
			origin = inbound.history || personal ? 'sync' : 'live';
		const conv = conversationId(inst.id, inbound.thread),
			id = messageId(inst.id, inbound.id);

		const content =
			inbound.deleted || !inbound.attachments.some((attachment) => attachment.bin !== undefined)
				? true
				: yield* db
						.one(Schema.Struct({ version: Schema.NullOr(Schema.String) }), {
							text: 'SELECT version FROM sys_message WHERE id = $1',
							params: [id]
						})
						.pipe(
							Effect.map(
								(row) =>
									Option.isNone(row) ||
									row.value.version === null ||
									row.value.version < inbound.version
							)
						);
		// Uploads finish before SQL acquisition; the batch rechecks the source under its native row lock.
		const stored = inbound.deleted || !content ? [] : yield* files(inst.id, inbound, bins, c, now);
		let nextDueAt: string | undefined;
		const persist = (write: typeof db.write) =>
			Effect.gen(function* () {
				if (inbound.deleted && inbound.thread === '') {
					// a bare revoke: tombstone the row, or hold the id so the message never lands
					c.cte(
						'msg',
						`SELECT * FROM ${messagePiece(c, `UPDATE sys_message SET deleted_at = ${c.p(now)}::timestamptz, ${TOMBSTONE} WHERE id = ${c.p(id)} AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM source)`, 'false AS inserted')}`
					);
					messagePiece(
						c,
						`INSERT INTO sys_message (id, integration, direction, origin, provider_id, text, preview, deleted_at, created_at)
				SELECT ${c.p(id)}, ${c.p(inst.id)}, 'inbound', ${c.p(origin)}, ${c.p(inbound.id)}, '', '', ${c.p(now)}::timestamptz, ${c.p(now)}::timestamptz
				WHERE EXISTS (SELECT 1 FROM source) AND NOT EXISTS (SELECT 1 FROM sys_message WHERE id = ${c.p(id)}) ON CONFLICT (id) DO NOTHING`,
						'id'
					);
					queue(c, inst, 'msg', id, inbound.version, null, now, true);
					const row = yield* nativeCommit(write, cfg.engine.live.publish, c, Queued,
						`EXISTS (SELECT 1 FROM source) AS admitted, ${next_due(c)}::text AS next_due`);
					if (!row.admitted)
						return yield* Effect.fail(source_changed('message'));
					if (row.next_due !== null) nextDueAt = row.next_due;
					return null;
				}
				c.cte('previous', `SELECT version FROM sys_message WHERE id = ${c.p(id)}`);
				// a group's name follows the provider's latest (a renamed group), never erased by a message that does not carry it;
				// `envoy` is the instance's at this message (display: admission reads the instance as it is then)
				// a received file is one of the conversation's inputs, naming its message, once: a redelivery or an edit adds none
				const inputs = stored.map((ref) =>
					Predicate.isObject(ref) ? { ...ref, message: id } : ref
				);
				capturePiece(c,
					'conv',
					'sys_conversation',
					`INSERT INTO sys_conversation (id, integration, thread, kind, envoy, title, participants, inputs) SELECT ${c.p(conv)}, ${c.p(inst.id)}, ${c.p(inbound.thread)},
			${c.p(inbound.group ? 'group' : 'dm')}, (SELECT i.envoy FROM sys_integration i WHERE i.id = ${c.p(inst.id)} AND i.owner IS NULL), ${c.p(inbound.title)},
			${c.p(personal ? (inbound.participants ?? null) : null)}::jsonb, ${c.p(inputs)}::jsonb WHERE EXISTS (SELECT 1 FROM source) ON CONFLICT (id) DO UPDATE SET
			envoy = excluded.envoy, title = coalesce(excluded.title, sys_conversation.title), participants = coalesce(excluded.participants, sys_conversation.participants),
			inputs = sys_conversation.inputs || (SELECT coalesce(jsonb_agg(e), '[]'::jsonb) FROM jsonb_array_elements(excluded.inputs) e
				WHERE NOT sys_conversation.inputs @> jsonb_build_array(jsonb_build_object('message', e->'message')))
			WHERE sys_conversation.envoy IS DISTINCT FROM excluded.envoy OR (excluded.title IS NOT NULL AND sys_conversation.title IS DISTINCT FROM excluded.title)
			OR (excluded.participants IS NOT NULL AND sys_conversation.participants IS DISTINCT FROM excluded.participants) OR excluded.inputs <> '[]'::jsonb`,
					{ returning: 'id, inputs' }
				);
				const text = inbound.deleted ? '' : inbound.text;
				// a personal account's own sent message is imported as outbound; it is history, never a send
				const direction =
					personal && Predicate.isObject(message) && message['direction'] === 'outbound'
						? 'outbound'
						: 'inbound';
				c.cte(
					'msg',
					`SELECT * FROM ${messagePiece(
						c,
						`INSERT INTO sys_message (id, conversation, integration, direction, origin, provider_id, version, sender, sender_name, sent_at, source_at, invocation,
			preview, text, email, reply_to, deleted_at, created_at)
		SELECT ${c.p(id)}, ${c.p(conv)}, ${c.p(inst.id)}, ${c.p(direction)}, ${c.p(origin)}, ${c.p(inbound.id)}, ${c.p(inbound.version)},
			${c.p(inbound.sender)}, ${c.p(inbound.sender_name)}, ${c.p(inbound.sent_at)}::timestamptz, ${c.p(inbound.source_at)}::timestamptz, ${c.p(inbound.invocation)}, ${c.p(preview(text))}, ${c.p(text)},
			${c.p(inbound.email)}::jsonb, ${c.p(inbound.reply_to)}, ${inbound.deleted ? `${c.p(now)}::timestamptz` : 'NULL'}, ${c.p(now)}::timestamptz WHERE EXISTS (SELECT 1 FROM source)
		ON CONFLICT (id) DO UPDATE SET ${
			inbound.deleted
				? `deleted_at = excluded.deleted_at, ${TOMBSTONE} WHERE sys_message.deleted_at IS NULL`
				: // an admitted row is the agent's transcript: an edit never rewrites what the model already saw
					`text = ${KEEP('text')}, preview = ${KEEP('preview')}, email = ${KEEP('email')}, source_at = coalesce(sys_message.source_at, excluded.source_at), version = greatest(sys_message.version, excluded.version),
				sender_name = CASE WHEN excluded.version > sys_message.version THEN coalesce(excluded.sender_name, sys_message.sender_name) ELSE sys_message.sender_name END, edited_at = CASE WHEN excluded.version > sys_message.version THEN ${c.p(now)}::timestamptz ELSE sys_message.edited_at END
			WHERE sys_message.deleted_at IS NULL AND (excluded.version > sys_message.version OR (sys_message.source_at IS NULL AND excluded.source_at IS NOT NULL))`
		}
		`,
						'(xmax = 0) AS inserted',
						`(SELECT coalesce(jsonb_agg(f.e - 'message' ORDER BY f.at), '[]'::jsonb)
						FROM jsonb_array_elements(coalesce((SELECT inputs FROM conv),
							(SELECT inputs FROM sys_conversation WHERE id = ${c.p(conv)}), '[]'::jsonb)) WITH ORDINALITY AS f(e, at)
						WHERE f.e->>'message' = ${c.p(id)})`
					)}`
				);
				c.cte(
					'changed',
					`SELECT * FROM msg WHERE inserted OR ${inbound.deleted ? 'true' : 'false'} OR EXISTS (SELECT 1 FROM previous WHERE version < ${c.p(inbound.version)})`
				);
				const live = origin === 'live' && !inbound.deleted && direction === 'inbound';
				const mail = inbound.email;
				if (!personal && !inbound.deleted && (mail !== null ? inbound.references.length > 0 : inbound.reply_to !== null)) {
					const refs = mail !== null ? [...inbound.references, inbound.thread] : [inbound.reply_to];
					const headers = mail !== null && Predicate.isObject(mail['headers'])
						? Object.fromEntries(Object.entries(mail['headers']).map(([key, value]) => [key, String(value)])) : {};
					const automatic = mail !== null && is_auto_reply(headers, typeof mail['subject'] === 'string' ? mail['subject'] : '');
					const reply: Json = mail !== null ? { ...mail, attachments: stored } : {
						id: inbound.id, thread: inbound.thread, sent_at: inbound.sent_at,
						from: { handle: inbound.sender, name: inbound.sender_name },
						reply_to: inbound.reply_to, text: inbound.text, attachments: stored
					};
					delivery_piece(m, c,
						`integration = ${c.p(inst.id)} AND conversation = ${c.p(conv)}
						AND (provider_id IN (SELECT jsonb_array_elements_text(${c.p(refs)}::jsonb))
							OR thread IN (SELECT jsonb_array_elements_text(${c.p(refs)}::jsonb)))
						AND EXISTS (SELECT 1 FROM msg WHERE inserted)`,
						{ kind: automatic ? 'auto_replied' : 'replied', at: inbound.sent_at, provider: 'bolt', reply: id },
						{ reply }
					);
				}
				queue(
					c,
					inst,
					'changed',
					id,
					inbound.version,
					live ? { mentions: inbound.mentions } : null,
					now,
					inbound.deleted
				);
				const row = yield* nativeCommit(write, cfg.engine.live.publish, c, Queued,
					`EXISTS (SELECT 1 FROM source) AS admitted, ${next_due(c)}::text AS next_due`);
				if (!row.admitted)
					return yield* Effect.fail(source_changed('message'));
				if (row.next_due !== null) nextDueAt = row.next_due;
			});
		const binary =
			!inbound.deleted &&
			content &&
			inbound.attachments.some((attachment) => attachment.bin !== undefined);
		yield* persist(
			binary
				? (statement) =>
						db
							.transaction({
								statements: [
									sql(
										"SELECT bolt_assert(EXISTS (SELECT id FROM sys_integration WHERE id = $1 AND import_start IS NOT DISTINCT FROM $2::jsonb FOR SHARE), 'source_changed', NULL)",
										inst.id,
										inst.importStartRaw
									),
									statement
								]
							})
							.pipe(Effect.flatMap((rows) => rows[1] === undefined
								? Effect.fail(DbError.make('XX000', 'an inbound transaction returned no mutation answer'))
								: Effect.succeed(rows[1])))
				: db.write
		).pipe(
			Effect.catch((error) =>
				error instanceof DbError && error.sqlstate === 'BA001' && error.message === 'source_changed'
					? Effect.fail(source_changed('message'))
					: Effect.fail(error)
			)
		);
		yield* announce(nextDueAt);
	});
	/** A cleared or deleted chat: one statement tombstones its rows up to `before`; the sync inbox names them. */
	const clear = Effect.fn('Agents.clear')(function* (
		inst: Instance,
		thread: string,
		before: string
	) {
		const now = yield* clock,
			c = new Chain();
		c.cte(
			'source',
			`SELECT id FROM sys_integration WHERE id = ${c.p(inst.id)} AND import_start IS NOT DISTINCT FROM ${c.p(inst.importStartRaw)}::jsonb FOR SHARE`
		);
		const gone = messagePiece(
			c,
			`UPDATE sys_message SET deleted_at = ${c.p(now)}::timestamptz, ${TOMBSTONE}
		WHERE conversation = ${c.p(conversationId(inst.id, thread))} AND sent_at <= ${c.p(before)}::timestamptz AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM source)`,
			'id'
		);
		inboxPiece(
			m,
			c,
			'cleared_inbox',
			inst.id,
			inst.integration,
			() => `SELECT 'clear:' || id || ':' || ${c.p(now)}::text AS delivery,
			jsonb_build_object('kind', 'message', 'id', id) AS body FROM ${gone}`,
			now
		);
		const row = yield* nativeCommit(db.write, cfg.engine.live.publish, c, Queued,
			`EXISTS (SELECT 1 FROM source) AS admitted, ${next_due(c)}::text AS next_due`);
		if (!row.admitted)
			return yield* Effect.fail(source_changed('clear'));
		yield* announce(row.next_due);
	});
	/** The sender is still typing: the thread's held burst is decided later, within its cap (`heldLonger`). */
	const stillTyping = Effect.fn('Conversations.stillTyping')(function* (
		instance: string,
		thread: string
	) {
		const chain = new Chain();
		heldLonger(
			chain,
			`(SELECT id FROM sys_conversation WHERE integration = ${chain.p(instance)} AND thread = ${chain.p(thread)})`,
			chain.p(yield* clock)
		);
		const held = yield* nativeCommit(db.write, cfg.engine.live.publish, chain, Due,
			'(SELECT min(due_at)::text FROM held) AS due');
		yield* announce(held.due);
	});
	const receive = Effect.fn('Agents.receive')(function* (
		instance: string,
		event: Exclude<
			DriverEvent,
			{
				kind: 'invalidate';
			}
		>,
		expectedImportStart?: ImportStart | null
	) {
		if (event.kind === 'outbound_ref') {
			yield* cfg.outbound.reference(instance, { message: event.message, provider_id: event.provider_id });
			return;
		}
		if (event.kind === 'delivery') {
			if (is_reported(event.report.kind))
				yield* cfg.outbound.delivered(instance, event.provider_id, event.report);
			return;
		}
		if (event.kind === 'presence') {
			if (event.typing) yield* stillTyping(instance, event.thread);
			return;
		}
		const inst = yield* instanceOf(instance);
		if (
			expectedImportStart !== undefined &&
			canonical(expectedImportStart) !== canonical(inst.import_start)
		)
			return yield* Effect.fail(
				BoltError.make(
					'source_changed',
					'admission',
					'The integration import start changed; reopen the link before importing.'
				)
			);
		if (event.kind === 'clear') return yield* clear(inst, event.thread, event.before);
		for (const message of event.messages)
			yield* ingest(inst, message, event.bins, event.history === true);
	});
	const recent = Effect.fn('Conversations.recent')(function* (instance: string) {
		const since = new Date(Date.parse(yield* clock) - RECENT_MS).toISOString();
		// one probe of (conversation, seq) per conversation of the instance: its newest row says when it was last active
		const rows = yield* db.rows(Schema.Struct({ thread: Schema.String }), {
			text: `SELECT c.thread FROM sys_conversation c CROSS JOIN LATERAL
			(SELECT m.created_at FROM sys_message m WHERE m.conversation = c.id ORDER BY m.seq DESC LIMIT 1) newest
			WHERE c.integration = $1 AND c.thread IS NOT NULL AND newest.created_at >= $2::timestamptz
			ORDER BY newest.created_at DESC LIMIT ${RECENT_THREADS}`,
			params: [instance, since]
		});
		return { since, threads: rows.map((row) => row.thread) };
	});
	const repair = Effect.fn('Conversations.repair')(function* (
		instance: string,
		thread: string,
		since: string,
		page: ReconcilePage,
		expectedImportStart?: ImportStart | null
	) {
		const inst = yield* instanceOf(instance),
			now = yield* clock,
			at = Date.parse(now);
		const stored = yield* db.rows(StoredMessage, {
			text: `SELECT provider_id, version, origin, deleted_at IS NOT NULL AS deleted,
			sent_at >= $4::timestamptz AND sent_at < $5::timestamptz AS settled FROM sys_message
			WHERE conversation = $1 AND integration = $2 AND provider_id IS NOT NULL AND sent_at >= $3::timestamptz
			ORDER BY seq DESC LIMIT ${REPAIR_ROWS}`,
			params: [
				conversationId(instance, thread),
				instance,
				since,
				page.since !== undefined && Date.parse(page.since) > Date.parse(since) ? page.since : since,
				new Date(at - SETTLE_MS).toISOString()
			]
		});
		const rows = new Map(stored.map((row) => [row.provider_id, row])),
			seen = new Set<string>(),
			live: Json[] = [],
			history: Json[] = [];
		for (const message of page.messages) {
			const decoded = decodeInbound(message);
			const inbound =
				Option.isNone(decoded) || !Predicate.isObject(message)
					? null
					: normalizeInbound(inst.kind, decoded.value, message, true, now);
			// the path it belongs to records a malformed message
			if (inbound === null) {
				history.push(message);
				continue;
			}
			seen.add(inbound.id);
			const row = rows.get(inbound.id);
			// a page may echo what bolt sent (no `origin`): that row is the message already
			if (
				row === undefined
					? inbound.deleted
					: row.origin === null ||
						row.deleted ||
						(!inbound.deleted && row.version !== null && row.version >= inbound.version)
			)
				continue;
			(row === undefined && Date.parse(inbound.sent_at) >= at - REPLY_WINDOW_MS
				? live
				: history
			).push(message);
		}
		if (page.complete)
			for (const row of stored)
				if (row.origin !== null && row.settled && !row.deleted && !seen.has(row.provider_id))
					history.push({ id: row.provider_id, deleted: true });
		const bins = page.bins === undefined ? {} : { bins: page.bins };
		if (live.length > 0)
			yield* receive(instance, { kind: 'messages', messages: live, ...bins }, expectedImportStart);
		if (history.length > 0)
			yield* receive(
				instance,
				{ kind: 'messages', messages: history, history: true, ...bins },
				expectedImportStart
			);
	});
	const send = Effect.fn('Agents.send')(function* (
		to: string,
		message: Json,
		options: {
			kind?: 'dm' | 'group' | undefined;
			id?: string | undefined;
		} = {}
	) {
		const prepared = yield* prepareSend(m, db, to, message, cfg.crypto);
		if ('error' in prepared)
			return yield* Effect.fail(BoltError.make('invalid_input', 'decode', prepared.error));
		const now = yield* clock,
			c = new Chain(),
			id = options.id ?? (yield* newId);
		sendPiece(
			c,
			{ ...prepared, id, ...(options.kind === undefined ? {} : { kind: options.kind }) },
			now
		);
		const queued = yield* nativeCommit(db.write, cfg.engine.live.publish, c, Due,
			`${next_due(c)}::text AS due`);
		yield* announce(queued.due);
		yield* cfg.outbound.deliver.pipe(Effect.tapCause(Effect.logWarning), Effect.ignore);
		return id;
	});
	const notify = Effect.fn('Agents.notify')(function* (input: Json) {
		const ids =
			Predicate.isObject(input) && Array.isArray(input['ids']) ? input['ids'].map(String) : [];
		if (ids.length === 0) return { queued: 0, skipped: 0 };
		yield* cfg.filesReady(ids);
		const { sends, skipped } = yield* notice_sends(m, db, ids);
		for (const s of sends) yield* send(s.slot, s.message, { id: s.id });
		return { queued: sends.length, skipped };
	});
	return {
		receive,
		recent,
		repair,
		send,
		/** The notices' platform run: `runs.platform`. */
		handlers: { [NOTICE_DELIVER]: notify }
	};
}
export type Conversations = ReturnType<typeof conversations>;

export const ConversationsLive = Layer.effect(
	ConversationsTag,
	Effect.gen(function* () {
		const manifest = yield* Manifest,
			db = yield* TenantDb,
			live = yield* Live,
			files = yield* Files,
			outbound = yield* OutboundTag,
			wake = yield* Wake,
			handlers = yield* RunHandlers;
		const fileContext =
			yield* Effect.context<Effect.Services<ReturnType<typeof prepareNoticeFiles>>>();
		const api = conversations({
			crypto: yield* Crypto.Crypto,
			engine: {
				manifest,
				db,
				live
			},
			files,
			filesReady: (ids) => prepareNoticeFiles(ids).pipe(Effect.provideContext(fileContext)),
			logs: yield* Logs,
			outbound,
			announce: wake.at
		});
		yield* handlers.register(api.handlers);
		return api;
	})
);
