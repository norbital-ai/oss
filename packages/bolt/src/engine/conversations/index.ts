const sql = (text: string, ...params: import('../../decl/values.ts').Json[]) => ({ text, params });
// Conversations (§4.3, rule 61): what a conversation instance's link hands the engine, and the messages it sends. Each
// inbound message is one statement keyed by its instance: the conversation (a DM or a group), the message by
// `(instance, provider_id)` — a newer version converges it, a revoke tombstones it, an admitted row keeps the transcript
// the agent saw — its files, the sync inbox and, for a new live message on an active workspace
// instance with an envoy, its `envoys.admit` run: everything is durable before the link acknowledges. A personal (owner)
// instance imports its account (origin `sync`), never sends and never admits. A file a row cannot store stays a named
// descriptor (no `id`) and a malformed message is logged: neither is a failure the link would redeliver forever.
// Replies are matched to the outbound row they answer — a redelivered one again, since a match that failed after its row
// was stored is what the provider redelivers it for; every send is a queued row `integrations.deliver` delivers. A cleared
// or deleted chat tombstones its rows up to the clear in one statement, under the same admitted-transcript rule.
import { Clock, Crypto, Effect, Layer, Option, Predicate, Schema } from 'effect';
import * as EffectArray from 'effect/Array';
import { teams } from '../manifest.ts';
import { enqueue, nextDue } from '../runs/queue.ts';
import type { Json } from '../../decl/values.ts';
import type { Bindings, DriverEvent, RowData } from '../contracts.ts';
import { Drivers, Files, Logs, type LogsShape } from '../ports.ts';
import { Port } from '../port.ts';
import { TenantDb } from '../db/tenant-db.ts';
import { DbError } from '../errors.ts';
import {
	Conversations as ConversationsTag,
	Manifest,
	Reads,
	Outbound as OutboundTag,
	Wake,
	RunHandlers,
	type OutboundShape
} from '../services.ts';
import { bindingsAt } from '../query/reader.ts';
import { LIMITS } from '../contracts.ts';
import { BoltError } from '../../protocol/errors.ts';
import type { AgentEngine } from '../agent/index.ts';
import { conversationOf, definitionOf } from '../integrations/instances.ts';
import { prepareNoticeFiles } from '../notifications/notify.ts';
import { inboxPiece } from '../sync/hint.ts';
import { canonical } from '@norbital-ai/store';
import { Chain } from '../write/sql.ts';
import { heldLonger } from '../agent/triage.ts';
import { InboundMessage, normalizeInbound, type Inbound } from './inbound.ts';
import { ImportStart } from '../../protocol/schema.ts';
import { permitsImport } from '../integrations/import-start.ts';
import { prepareSend, sendPiece } from './outbound.ts';
import { isAutoReply, isReported } from './status.ts';
import {
	ADMIT,
	conversationId,
	messageId,
	NOTIFY,
	preview,
	stableId,
	msg as messagePiece
} from './store.ts';
type ConversationsConfig = {
	crypto: Crypto.Crypto;
	engine: Pick<AgentEngine, 'manifest' | 'db' | 'read'> & { bindings: (now: string) => Bindings };
	files?: Files['Service'];
	drivers: Drivers['Service'];
	filesReady: (ids: readonly string[]) => Effect.Effect<void, import('../errors.ts').EngineError>;
	logs: LogsShape;
	clock?: Effect.Effect<string>;
	/** The engine's wake: a statement here queued runs due at `at` (admission, sync, delivery). */
	announce?: (at: string) => Effect.Effect<void>;
	/** The outbound area's delivery (`integrations.deliver`), its reports and reply matching. */
	outbound: Pick<OutboundShape, 'deliver' | 'delivered' | 'replied'>;
};
/** The instance a message arrived on: its definition, the kind of messages it carries and its owner (personal: sync only). */
type Instance = {
	id: string;
	integration: string;
	owner: string | null;
	kind: 'chat' | 'email';
	importStart: ImportStart | null;
	importStartRaw: Json;
};
/** An admitted row (`role` set) keeps its transcript content; only unadmitted history is rewritten by an edit or a revoke. */
const KEEP = (col: string) =>
	`CASE WHEN sys_message.role IS NULL AND excluded.version > sys_message.version THEN excluded.${col} ELSE sys_message.${col} END`;
/** A revoke, a delete for me or a cleared chat stamps `deleted_at` on every row; it erases content only where no agent saw it. */
const TOMBSTONE = `text = CASE WHEN sys_message.role IS NULL THEN '' ELSE sys_message.text END, preview = CASE WHEN sys_message.role IS NULL THEN '' ELSE sys_message.preview END,
	email = CASE WHEN sys_message.role IS NULL THEN NULL ELSE sys_message.email END`;
export function conversations(cfg: ConversationsConfig) {
	const { manifest: m, db } = cfg.engine;
	const uuid = cfg.crypto.randomUUIDv4().pipe(
		Effect.mapError((error) =>
			BoltError.make('unavailable', 'facility', 'Secure random UUID generation failed.', error)
		)
	);
	const clock =
		cfg.clock ?? Clock.currentTimeMillis.pipe(Effect.map((now) => new Date(now).toISOString()));
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
				BoltError.make('notFound', 'decode', `no conversation instance '${id}'`)
			);
		const importStart = yield* Schema.decodeUnknownEffect(Schema.NullOr(ImportStart))(
			row.import_start
		).pipe(
			Effect.mapError(() =>
				BoltError.make('invalidInput', 'admission', 'The integration import start is invalid.')
			)
		);
		return {
			id,
			integration: row.integration,
			owner: row.owner,
			kind: conv.kind,
			importStart,
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
			c.cte(
				`f${i}`,
				`INSERT INTO sys_file (id, name, mime, size, key, sha256, field, created_at) SELECT ${c.p(id)}, ${c.p(a.name)}, ${c.p(a.mime)},
				${c.p(data.byteLength)}, ${c.p(blob.key)}, ${c.p(blob.sha256)}, 'sys_conversation.inputs', ${c.p(now)}::timestamptz WHERE EXISTS (SELECT 1 FROM source) ON CONFLICT (id) DO NOTHING RETURNING id`
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
	): string[] {
		const out: string[] = [];
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
			out.push(
				enqueue(
					c,
					{
						select: `SELECT '${ADMIT}'::text AS automation, ${c.p({ message: id, mentions: admit.mentions })}::jsonb AS input,
                ${c.p(now)}::timestamptz AS due_at, ${c.p(JSON.stringify([ADMIT, id]))}::text AS key, 'provider'::text AS cause, 0 AS depth
                WHERE EXISTS (SELECT 1 FROM ${msg} WHERE inserted)
                AND EXISTS (SELECT 1 FROM sys_integration i WHERE i.id = ${c.p(inst.id)} AND i.active AND i.envoy IS NOT NULL AND i.owner IS NULL)`
					},
					{ conflict: 'keep' }
				)
			);
		return out;
	}
	const counted = (ctes: readonly string[]) =>
		ctes.length === 0 ? '0' : ctes.map((x) => `(SELECT count(*) FROM ${x})`).join(' + ');
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
		const inbound =
			decoded === null || !Predicate.isObject(message)
				? null
				: normalizeInbound(inst.kind, decoded, message, history, now);
		if (inbound === null) {
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
		if (!permitsImport(inst.importStart, inbound.sourceAt ?? undefined)) {
			if (!inbound.deleted || inbound.sourceAt !== null) return null;
			const previous = yield* db.one(Schema.Struct({ source_at: Schema.NullOr(Schema.String) }), {
				text: 'SELECT source_at::text AS source_at FROM sys_message WHERE id = $1 AND integration = $2',
				params: [messageId(inst.id, inbound.id), inst.id]
			});
			if (
				Option.isNone(previous) ||
				!permitsImport(inst.importStart, previous.value.source_at ?? undefined)
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
					const runs = queue(c, inst, 'msg', id, inbound.version, null, now, true);
					const [row] = (yield* write(
						c.sql(
							`EXISTS (SELECT 1 FROM source) AS admitted, ${counted(runs)} AS queued, ${nextDue(c)}::text AS next_due`
						)
					)).rows;
					if (row?.['admitted'] !== true)
						return yield* Effect.fail(
							BoltError.make(
								'sourceChanged',
								'admission',
								'The integration import start changed; redeliver this message.'
							)
						);
					if (typeof row?.['next_due'] === 'string') nextDueAt = row['next_due'];
					return null;
				}
				c.cte('previous', `SELECT version FROM sys_message WHERE id = ${c.p(id)}`);
				// a group's name follows the provider's latest (a renamed group), never erased by a message that does not carry it;
				// `envoy` is the instance's at this message (display: admission reads the instance as it is then)
				// a received file is one of the conversation's inputs, naming its message, once: a redelivery or an edit adds none
				const inputs = stored.map((ref) =>
					Predicate.isObject(ref) ? { ...ref, message: id } : ref
				);
				c.cte(
					'conv',
					`INSERT INTO sys_conversation (id, integration, thread, kind, envoy, title, participants, inputs) SELECT ${c.p(conv)}, ${c.p(inst.id)}, ${c.p(inbound.thread)},
			${c.p(inbound.group ? 'group' : 'dm')}, (SELECT i.envoy FROM sys_integration i WHERE i.id = ${c.p(inst.id)} AND i.owner IS NULL), ${c.p(inbound.title)},
			${c.p(personal ? (inbound.participants ?? null) : null)}::jsonb, ${c.p(inputs)}::jsonb WHERE EXISTS (SELECT 1 FROM source) ON CONFLICT (id) DO UPDATE SET
			envoy = excluded.envoy, title = coalesce(excluded.title, sys_conversation.title), participants = coalesce(excluded.participants, sys_conversation.participants),
			inputs = sys_conversation.inputs || (SELECT coalesce(jsonb_agg(e), '[]'::jsonb) FROM jsonb_array_elements(excluded.inputs) e
				WHERE NOT sys_conversation.inputs @> jsonb_build_array(jsonb_build_object('message', e->'message')))
			WHERE sys_conversation.envoy IS DISTINCT FROM excluded.envoy OR (excluded.title IS NOT NULL AND sys_conversation.title IS DISTINCT FROM excluded.title)
			OR (excluded.participants IS NOT NULL AND sys_conversation.participants IS DISTINCT FROM excluded.participants) OR excluded.inputs <> '[]'::jsonb RETURNING id`
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
			${c.p(inbound.sender)}, ${c.p(inbound.senderName)}, ${c.p(inbound.sentAt)}::timestamptz, ${c.p(inbound.sourceAt)}::timestamptz, ${c.p(inbound.invocation)}, ${c.p(preview(text))}, ${c.p(text)},
			${c.p(inbound.email)}::jsonb, ${c.p(inbound.replyTo)}, ${inbound.deleted ? `${c.p(now)}::timestamptz` : 'NULL'}, ${c.p(now)}::timestamptz WHERE EXISTS (SELECT 1 FROM source)
		ON CONFLICT (id) DO UPDATE SET ${
			inbound.deleted
				? `deleted_at = excluded.deleted_at, ${TOMBSTONE} WHERE sys_message.deleted_at IS NULL`
				: // an admitted row is the agent's transcript: an edit never rewrites what the model already saw
					`text = ${KEEP('text')}, preview = ${KEEP('preview')}, email = ${KEEP('email')}, source_at = coalesce(sys_message.source_at, excluded.source_at), version = greatest(sys_message.version, excluded.version),
				sender_name = CASE WHEN excluded.version > sys_message.version THEN coalesce(excluded.sender_name, sys_message.sender_name) ELSE sys_message.sender_name END, edited_at = CASE WHEN excluded.version > sys_message.version THEN ${c.p(now)}::timestamptz ELSE sys_message.edited_at END
			WHERE sys_message.deleted_at IS NULL AND (excluded.version > sys_message.version OR (sys_message.source_at IS NULL AND excluded.source_at IS NOT NULL))`
		}
		`,
						'(xmax = 0) AS inserted'
					)}`
				);
				c.cte(
					'changed',
					`SELECT * FROM msg WHERE inserted OR ${inbound.deleted ? 'true' : 'false'} OR EXISTS (SELECT 1 FROM previous WHERE version < ${c.p(inbound.version)})`
				);
				const live = origin === 'live' && !inbound.deleted && direction === 'inbound';
				const runs = queue(
					c,
					inst,
					'changed',
					id,
					inbound.version,
					live ? { mentions: inbound.mentions } : null,
					now,
					inbound.deleted
				);
				const [row] = (yield* write(
					c.sql(
						`EXISTS (SELECT 1 FROM source) AS admitted, (SELECT inserted FROM msg) AS inserted, (SELECT count(*) FROM msg)::int AS n, ${counted(runs)} AS queued, ${nextDue(c)}::text AS next_due`
					)
				)).rows;
				if (row?.['admitted'] !== true)
					return yield* Effect.fail(
						BoltError.make(
							'sourceChanged',
							'admission',
							'The integration import start changed; redeliver this message.'
						)
					);
				if (typeof row?.['next_due'] === 'string') nextDueAt = row['next_due'];
				// `moved` false: a redelivery, an older version, or a change to a tombstone
				return {
					inbound,
					row: id,
					conversation: conv,
					inserted: row!['inserted'] === true,
					moved: row!['n'] !== 0,
					files: stored
				};
			});
		const binary =
			!inbound.deleted &&
			content &&
			inbound.attachments.some((attachment) => attachment.bin !== undefined);
		const result = yield* persist(
			binary
				? (statement) =>
						db
							.transaction({
								statements: [
									sql(
										"SELECT bolt_assert(EXISTS (SELECT id FROM sys_integration WHERE id = $1 AND import_start IS NOT DISTINCT FROM $2::jsonb FOR SHARE), 'sourceChanged', NULL)",
										inst.id,
										inst.importStartRaw
									),
									statement
								]
							})
							.pipe(Effect.map((rows) => rows[1] ?? { rows: [], affected: 0 }))
				: db.write
		).pipe(
			Effect.catch((error) =>
				error instanceof DbError && error.sqlstate === 'BA001' && error.message === 'sourceChanged'
					? Effect.fail(
							BoltError.make(
								'sourceChanged',
								'admission',
								'The integration import start changed; redeliver this message.'
							)
						)
					: Effect.fail(error)
			)
		);
		if (nextDueAt !== undefined) yield* cfg.announce?.(nextDueAt) ?? Effect.void;
		return result;
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
		const runs: string[] = [];
		const [row] = (yield* db.write(
			c.sql(
				`EXISTS (SELECT 1 FROM source) AS admitted, ${counted(runs)} AS queued, ${nextDue(c)}::text AS next_due`
			)
		)).rows;
		if (row?.['admitted'] !== true)
			return yield* Effect.fail(
				BoltError.make(
					'sourceChanged',
					'admission',
					'The integration import start changed; redeliver this clear.'
				)
			);
		const due = row?.['next_due'];
		if (typeof due === 'string') yield* cfg.announce?.(due) ?? Effect.void;
	});
	const replied = Effect.fn('Agents.replied')(function* (
		instance: string,
		got: NonNullable<Effect.Success<ReturnType<typeof ingest>>>
	) {
		const x = got.inbound,
			mail = x.email;
		const reply: Json =
			mail !== null
				? { ...mail, attachments: got.files }
				: {
						id: x.id,
						thread: x.thread,
						sentAt: x.sentAt,
						from: { handle: x.sender, name: x.senderName },
						replyTo: x.replyTo,
						text: x.text,
						attachments: got.files
					};
		yield* cfg.outbound.replied(
			instance,
			mail !== null ? [...x.references, x.thread] : [x.replyTo!],
			{
				row: got.row,
				at: x.sentAt,
				auto:
					mail !== null &&
					isAutoReply(
						Predicate.isObject(mail['headers'])
							? (mail['headers'] as {
									[k: string]: string;
								})
							: {},
						String(mail['subject'] ?? '')
					),
				message: reply
			}
		);
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
		const [held] = yield* db.returning(
			Schema.Struct({ due: Schema.NullOr(Schema.String) }),
			chain.sql(`(SELECT min(due_at)::text FROM held) AS due`)
		);
		if (held !== undefined && held.due !== null) yield* cfg.announce?.(held.due) ?? Effect.void;
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
		if (event.kind === 'delivery') {
			if (isReported(event.report.kind))
				yield* cfg.outbound.delivered(instance, event.providerId, event.report);
			return;
		}
		if (event.kind === 'presence') {
			if (event.typing) yield* stillTyping(instance, event.thread);
			return;
		}
		const inst = yield* instanceOf(instance);
		if (
			expectedImportStart !== undefined &&
			canonical(expectedImportStart) !== canonical(inst.importStart)
		)
			return yield* Effect.fail(
				BoltError.make(
					'sourceChanged',
					'admission',
					'The integration import start changed; reopen the link before importing.'
				)
			);
		if (event.kind === 'clear') return yield* clear(inst, event.thread, event.before);
		for (const message of event.messages) {
			const got = yield* ingest(inst, message, event.bins, event.history === true);
			// a new message, or a redelivered one (its match may be what failed; a recorded match records nothing again), never an edit
			if (
				got === null ||
				(got.moved && !got.inserted) ||
				got.inbound.deleted ||
				inst.owner !== null
			)
				continue;
			if (
				got.inbound.email !== null
					? got.inbound.references.length > 0
					: got.inbound.replyTo !== null
			)
				yield* replied(inst.id, got);
		}
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
			return yield* Effect.fail(BoltError.make('invalidInput', 'decode', prepared.error));
		const now = yield* clock,
			c = new Chain(),
			id = options.id ?? (yield* uuid);
		const sent = sendPiece(
			c,
			{ ...prepared, id, ...(options.kind === undefined ? {} : { kind: options.kind }) },
			now
		);
		const [queued] = yield* db.returning(
			Schema.Struct({ due: Schema.NullOr(Schema.String) }),
			c.sql(`${nextDue(c)}::text AS due, (SELECT count(*) FROM ${sent})::int AS n`)
		);
		if (queued?.due !== null && queued?.due !== undefined)
			yield* cfg.announce?.(queued.due) ?? Effect.void;
		yield* cfg.outbound.deliver.pipe(Effect.tapCause(Effect.logWarning), Effect.ignore);
		return id;
	});
	const notify = Effect.fn('Agents.notify')(function* (input: Json) {
		const teamPolicies = teams(m),
			signupPolicies = m.workspace.signup?.policies ?? [];
		const ids =
			Predicate.isObject(input) && Array.isArray(input['ids']) ? input['ids'].map(String) : [];
		if (ids.length === 0) return { sent: 0, skipped: 0 };
		yield* cfg.filesReady(ids);
		const [notes, users] = yield* db.read([
			sql(
				`SELECT id, recipient, title, body, attachments FROM sys_notification WHERE member IS NULL AND id IN (SELECT jsonb_array_elements_text($1::jsonb))`,
				JSON.stringify(ids)
			),
			sql(
				`SELECT u.id, u.email, u.phone, u.telegram, u.team, u.signup FROM sys_user u WHERE u.active AND u.kind = 'staff'`
			)
		]);
		let sent = 0,
			skipped = 0;
		for (const n of notes!.rows) {
			const to = Predicate.isObject(n['recipient']) ? n['recipient'] : {};
			const slot = String(to['channel'] ?? ''),
				list = EffectArray.isArray(to['recipients'])
					? to['recipients'].filter((x) => Predicate.isObject(x))
					: [];
			const def = Object.hasOwn(m.connections, slot)
				? definitionOf(m, m.connections[slot]!.integration)
				: undefined;
			const conv = def === undefined ? undefined : conversationOf(def);
			if (def === undefined || conv === undefined) {
				skipped++;
				continue;
			}
			const members = users!.rows.filter((u) =>
				list.some(
					(r) =>
						r['user'] === u['id'] ||
						(typeof r['team'] === 'string' &&
							typeof u['team'] === 'string' &&
							r['team'] === u['team'] &&
							Object.hasOwn(teamPolicies, u['team'])) ||
						(typeof r['policy'] === 'string' &&
							((typeof u['team'] === 'string' &&
								(teamPolicies[u['team']]?.policies ?? []).includes(r['policy'])) ||
								(u['signup'] === true && signupPolicies.includes(r['policy']))))
				)
			);
			const title = String(n['title']),
				text = typeof n['body'] === 'string' && n['body'] !== '' ? String(n['body']) : title;
			for (const u of members) {
				const digits = typeof u['phone'] === 'string' ? u['phone'].replace(/\D/g, '') : '';
				const handle =
					conv.handle === 'email'
						? u['email']
						: conv.handle === 'telegram'
							? u['telegram']
							: conv.handle === 'phone'
								? digits === ''
									? null
									: def.driver === 'whatsapp'
										? `${digits}@s.whatsapp.net`
										: digits
								: null;
				if (typeof handle !== 'string' || handle === '') {
					skipped++;
					continue;
				}
				const message: RowData =
					conv.kind === 'email'
						? { to: [handle], subject: title, text, attachments: n['attachments'] ?? [] }
						: {
								to: handle,
								text: text === title ? title : `${title}\n${text}`,
								attachments: n['attachments'] ?? []
							};
				yield* send(slot, message, { id: stableId('notice', String(n['id']), String(u['id'])) });
				sent++;
			}
		}
		return { sent, skipped };
	});
	return {
		receive,
		send,
		/** The notices' platform run (rule 48): `runs.platform`. */
		handlers: { [NOTIFY]: notify }
	};
}
export type Conversations = ReturnType<typeof conversations>;

export const ConversationsLive = Layer.effect(
	ConversationsTag,
	Effect.gen(function* () {
		const manifest = yield* Manifest,
			db = yield* TenantDb,
			reads = yield* Reads,
			files = yield* Files,
			drivers = yield* Drivers,
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
				read: reads.run,
				bindings: (now) => bindingsAt(now, manifest.workspace.tz)
			},
			files,
			drivers,
			filesReady: (ids) => prepareNoticeFiles(ids).pipe(Effect.provideContext(fileContext)),
			logs: yield* Logs,
			outbound,
			announce: wake.at
		});
		yield* handlers.register(api.handlers);
		return api;
	})
);
