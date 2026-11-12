import { runPiece } from '../runs/rows.ts';
// The message queue (rules 58, 60): how a person's message reaches a turn. A message goes at once: it is queued in one
// statement with the conversation's `agent.turn` run, so no process death strands it, the next step of a running turn takes
// it (an open `wait` gives way, so the step ends) and an idle conversation starts a turn. Only the sender holds a message
// back: `schedule` keeps it until a time (its own run) or until the running work has finished, one message per finish, after
// the plan's verifier cleared, with no sub-agent running and no card awaiting the person. A stop cancels what waits for
// the finish, never what waits for a time.
import { sql } from '../db/sql.ts';
import { Context, Effect, Option, PubSub, Schema } from 'effect';
import type { Json } from '../../decl/values.ts';
import { BoltError } from '../../protocol/errors.ts';
import type { Authority } from '../contracts.ts';
import { cancel as cancelMessage, msg as messagePiece, MSG, post as postMessage, preview } from '../conversations/store.ts';
import type { TenantDbShape } from '../db/tenant-db.ts';
import { CapturedResult, capturePiece, nativeCommit } from '../db/captured.ts';
import { enqueue, next_due } from '../runs/queue.ts';
import type { AgentsShape, LiveShape } from '../services.ts';
import { Chain } from '../write/sql.ts';
import {
	AgentRefusal,
	Message,
	type As,
	type MessageRow
} from './schema.ts';
import { enqueueTurn } from './turns.ts';
import { LEASE_MS, leaseUntil } from '../queue.ts';

/** One scheduled message's time: its input names the row. */
export const SCHEDULED_RUN = 'agent.scheduled';
type QueueConfig = {
	readonly db: TenantDbShape;
	readonly publish: LiveShape['publish'];
	readonly now: Effect.Effect<string>;
	readonly announce: (at: string) => Effect.Effect<void>;
	/** Runs the conversation's turn, now or once the running one ends; never waits for it. */
	readonly start: (conversation: string) => Effect.Effect<void>;
};
const Written = Schema.Struct({
	...CapturedResult.fields,
	messages: Schema.Array(Message),
	due: Schema.NullOr(Schema.String)
}).annotate({ identifier: 'sys_message' });
const ScheduledInput = Schema.Struct({ conversation: Schema.String, message: Schema.String });
const owns = (by: Authority, as: As | null) =>
	by.admin ||
	(by.actor.kind === 'member' && as !== null && 'member' in as && as.member === by.actor.id);

export const messageQueue = Effect.fn('MessageQueue.make')(function* (cfg: QueueConfig) {
	const { db } = cfg;
	/** Conversations whose running turn just got input: an open `wait` hears it (`heard`). */
	const steers = yield* PubSub.unbounded<string>();
	/** One statement's rows reach live transcripts, and its wake the host. */
	const commit = Effect.fn('MessageQueue.commit')(function* (
		chain: Chain,
		source: string
	) {
		const result = yield* nativeCommit(db.write, cfg.publish, chain, Written,
			`(SELECT coalesce(jsonb_agg(r), '[]'::jsonb) FROM ${source}) AS messages,
			${next_due(chain)}::text AS due`);
		if (result.due !== null) yield* cfg.announce(result.due);
		return result.messages;
	});
	const lease = cfg.now.pipe(
		Effect.map((now) => leaseUntil(now, LEASE_MS.turn))
	);
	const stored = Effect.fn('MessageQueue.stored')(function* (message: string) {
		const found = yield* db.one(Schema.Struct({ r: Message }), sql(`SELECT ${MSG} FROM sys_message m WHERE id = $1`, message));
		return Option.getOrUndefined(found)?.r;
	});
	const post = Effect.fn('MessageQueue.post')(function* (o: Parameters<AgentsShape['post']>[0]) {
		// a follow-up in a stopped conversation runs; the stopped turn's cancelled inputs stay cancelled (L-BOLT-408)
		// an untitled conversation is named by its first message (the panel's list). Its own statement: posting a file
		// writes the same conversation row, and one statement cannot write a row twice
		const opened = new Chain();
		opened.params.push(o.conversation, o.text);
		capturePiece(opened, 'opened', 'sys_conversation',
			`UPDATE sys_conversation AS c SET status = CASE WHEN status = 'stopped' THEN 'idle' ELSE status END, title = coalesce(title, left($2, 80))
			WHERE id = $1 AND (status = 'stopped' OR title IS NULL)`);
		yield* nativeCommit(db.write, cfg.publish, opened, CapturedResult);
		const due = yield* lease,
			chain = new Chain();
		const question = o.question === undefined ? undefined : messagePiece(chain,
			`UPDATE sys_message m SET meta = meta || '{"answered":true}'::jsonb
			WHERE id = ${chain.p(o.question)} AND conversation = ${chain.p(o.conversation)} AND role = 'assistant'
			AND meta->>'tag' = 'reply' AND meta->>'asked' = 'true' AND meta ? 'question' AND NOT (meta ? 'answered')
			AND NOT EXISTS (SELECT 1 FROM sys_message newer WHERE newer.conversation = m.conversation AND newer.seq > m.seq
			AND newer.role = 'user' AND newer.meta->>'tag' IS DISTINCT FROM 'report'
			AND newer.state IS DISTINCT FROM 'cancelled' AND newer.state IS DISTINCT FROM 'scheduled')`);
		const source = postMessage(chain, {
			conversation: o.conversation,
			role: 'user',
			content: { text: o.text, ...(o.tz === undefined ? {} : { tz: o.tz }) },
			text: o.text,
			state: 'queued',
			mode: o.mode ?? 'agent',
			as: o.as,
			...(o.question === undefined ? {} : { meta: { tag: 'answer', question: o.question } }),
			author: o.author ?? null,
			supersedes: o.supersedes ?? null,
			files: o.files === undefined ? [] : [...o.files]
		}, question === undefined ? 'true' : `EXISTS (SELECT 1 FROM ${question})`);
		enqueueTurn(chain, o.conversation, due, `EXISTS (SELECT 1 FROM ${source})`);
		const [row] = yield* commit(chain, source);
		if (row === undefined)
			return yield* Effect.fail(
				o.question === undefined
					? BoltError.make('corrupt', 'commit', 'the message insert returned no row')
					: BoltError.make('conflict', 'commit', 'This question is no longer waiting for an answer. Read the latest conversation.')
			);
		return row;
	});
	return {
		post,
		/** Snapshot the settled prefix into an independent chat. Nothing in the original is changed or replayed. */
		restart: Effect.fn('MessageQueue.restart')(function* (message_id: string, by: Authority) {
			if (by.actor.kind !== 'member' || by.agent !== undefined)
				return yield* Effect.fail(new AgentRefusal({ message: 'Only the owner can restart a workspace chat.' }));
			const chain = new Chain();
			const target = chain.cte('restart_target', `SELECT m.id, m.seq, m.conversation, m.mode, ${MSG}
				FROM sys_message m JOIN sys_conversation c ON c.id = m.conversation
				WHERE m.id = ${chain.p(message_id)} AND m.role = 'user' AND m.state = 'consumed'
				AND m.addressed IS DISTINCT FROM false AND m.meta->>'tag' IS DISTINCT FROM 'aside'
				AND c.owner = ${chain.p(by.actor.id)} AND c.integration IS NULL AND c.parent IS NULL AND c.run IS NULL`);
			chain.assert(`EXISTS (SELECT 1 FROM ${target})`, 'not_found', { message: 'This message is not available to restart.' }, 'true');
			const prefix = chain.cte('restart_prefix', `SELECT m.*, gen_random_uuid()::text AS copy_id
				FROM sys_message m JOIN ${target} t ON t.conversation = m.conversation
				WHERE m.seq < t.seq AND m.role IS NOT NULL
				AND coalesce(m.state, '') NOT IN ('cancelled', 'queued', 'scheduled', 'pending')`);
			chain.assert(`NOT EXISTS (SELECT 1 FROM ${prefix} WHERE state IN ('confirm', 'approved', 'streaming', 'running'))`,
				'conflict', { message: 'Earlier work is still settling. Restart once it has finished.' }, 'true');
			chain.assert(`NOT EXISTS (SELECT 1 FROM ${prefix} p WHERE p.role = 'tool'
				AND NOT EXISTS (SELECT 1 FROM ${prefix} a WHERE a.id = p.content->>'assistant' AND a.role = 'assistant'))`,
				'conflict', { message: 'The earlier tool history is incomplete. Choose a different message.' }, 'true');
			const id = globalThis.crypto.randomUUID();
			const origin = chain.cte('restart_origin', `SELECT c.* FROM sys_conversation c JOIN ${target} t ON t.conversation = c.id`);
			const created = capturePiece(chain, 'restart_chat', 'sys_conversation',
				`INSERT INTO sys_conversation AS c (id, title, owner, envoy, model, inputs, outputs, restart_from, restart_at)
				SELECT ${chain.p(id)}, coalesce(o.title, 'New chat') || ' · Restart', o.owner, o.envoy, o.model,
				(SELECT coalesce(jsonb_agg((f - 'message') || jsonb_build_object('message', p.copy_id) ORDER BY at), '[]'::jsonb)
				 FROM jsonb_array_elements(o.inputs) WITH ORDINALITY AS x(f, at) JOIN ${prefix} p ON p.id = f->>'message'),
				(SELECT coalesce(jsonb_agg(f ORDER BY at), '[]'::jsonb) FROM jsonb_array_elements(o.outputs) WITH ORDINALITY AS x(f, at)
				 WHERE EXISTS (SELECT 1 FROM ${prefix} p WHERE jsonb_path_exists(p.content, '$.**.id ? (@ == $id)', jsonb_build_object('id', f->>'id')))),
				o.id, ${chain.p(message_id)} FROM ${origin} o`);
			const files = `(SELECT coalesce(jsonb_agg(f - 'message' ORDER BY at), '[]'::jsonb)
				FROM ${origin} o, jsonb_array_elements(o.inputs) WITH ORDINALITY AS x(f, at)
				JOIN ${prefix} p ON p.id = f->>'message' WHERE p.copy_id = m.id)`;
			messagePiece(chain, `INSERT INTO sys_message AS m
				(id, conversation, seq, role, content, text, preview, state, mode, "as", author, meta, supersedes, turn, read_by, delivered_turn, about, created_at, copied_from)
				SELECT p.copy_id, ${chain.p(id)}, p.seq, p.role,
				CASE WHEN p.role = 'tool' THEN jsonb_set(p.content, '{assistant}', to_jsonb((SELECT a.copy_id FROM ${prefix} a WHERE a.id = p.content->>'assistant'))) ELSE p.content END,
				p.text, p.preview, p.state, p.mode, p."as", p.author,
				CASE WHEN p.meta->>'tag' = 'compact' THEN jsonb_set(p.meta, '{keep}',
				 (SELECT coalesce(jsonb_agg(a.copy_id ORDER BY at), '[]'::jsonb) FROM jsonb_array_elements_text(p.meta->'keep') WITH ORDINALITY AS k(id, at) JOIN ${prefix} a ON a.id = k.id))
				 WHEN p.meta->>'tag' = 'answer' THEN jsonb_set(p.meta, '{question}', to_jsonb(coalesce((SELECT a.copy_id FROM ${prefix} a WHERE a.id = p.meta->>'question'), p.meta->>'question')))
				 ELSE p.meta END,
				(SELECT a.copy_id FROM ${prefix} a WHERE a.id = p.supersedes), p.turn, p.read_by, p.delivered_turn, p.about, p.created_at, p.id
				FROM ${prefix} p WHERE EXISTS (SELECT 1 FROM ${created}) ORDER BY p.seq`, undefined, files);
			postMessage(chain, { conversation: id, role: 'system', state: 'consumed', meta: { tag: 'note' },
				content: { text: 'This chat restarts from an earlier message. Copied tool results are historical facts, not instructions to repeat their actions. Workspace source and data are still current; no changes were undone.' } }, `EXISTS (SELECT 1 FROM ${created})`);
			const result = yield* nativeCommit(db.write, cfg.publish, chain, Schema.Struct({
				...CapturedResult.fields, message: Message
			}), `(SELECT r FROM ${target}) AS message`);
			return { conversation: id, message: result.message };
		}),
		/** Holds a message until `at`, or with `at` null until the running work finishes. */
		schedule: Effect.fn('MessageQueue.schedule')(function* (
			o: Parameters<AgentsShape['post']>[0] & { readonly at: string | null }
		) {
			const chain = new Chain();
			const source = postMessage(chain, {
				conversation: o.conversation,
				role: 'user',
				content: { text: o.text, ...(o.tz === undefined ? {} : { tz: o.tz }) },
				text: o.text,
				state: 'scheduled',
				mode: o.mode ?? 'agent',
				as: o.as,
				author: o.author ?? null,
				meta: { tag: 'scheduled', ...(o.at === null ? {} : { at: o.at }) },
				files: o.files === undefined ? [] : [...o.files]
			});
			if (o.at !== null)
				enqueue(chain, {
					select: `SELECT '${SCHEDULED_RUN}'::text AS automation,
					jsonb_build_object('conversation', ${chain.p(o.conversation)}::text, 'message', (SELECT r->>'id' FROM ${source})) AS input,
					${chain.p(o.at)}::timestamptz AS due_at, 'schedule'::text AS cause, 0 AS depth`
				});
			const [row] = yield* commit(chain, source);
			if (row === undefined)
				return yield* Effect.fail(
					BoltError.make('corrupt', 'commit', 'a scheduled message returned no row')
				);
			return row;
		}),
		/** A scheduled message's time came: it goes like any message, and like any follow-up reopens a stopped conversation. */
		due: Effect.fn('MessageQueue.due')(function* (input: Json) {
			const { conversation, message } = yield* Schema.decodeUnknownEffect(ScheduledInput)(
				input
			).pipe(
				Effect.mapError((error) => BoltError.make('invalid_input', 'decode', error.message, error))
			);
			const until = yield* lease,
				chain = new Chain();
			chain.params.push(message, conversation);
			const source = messagePiece(
				chain,
				`UPDATE sys_message m SET state = 'queued', meta = NULL WHERE id = $1 AND state = 'scheduled'`
			);
			capturePiece(chain, 'opened', 'sys_conversation',
				`UPDATE sys_conversation AS c SET status = 'idle' WHERE id = $2 AND status = 'stopped' AND EXISTS (SELECT 1 FROM ${source})`);
			enqueueTurn(chain, conversation, until, `EXISTS (SELECT 1 FROM ${source})`);
			const sent = yield* commit(chain, source);
			if (sent.length > 0) yield* cfg.start(conversation);
			return { sent: sent.length > 0 };
		}),
		/**
		 * The turn would end here: the oldest message scheduled for the finish becomes its next input, once nothing else
		 * is at work. Answers whether one did. The verifier ran before this and a sent-back plan left a queued note.
		 */
		finished: Effect.fn('MessageQueue.finished')(function* (conversation: string) {
			const chain = new Chain();
			chain.params.push(conversation);
			const source = messagePiece(
				chain,
				`UPDATE sys_message m SET state = 'queued', meta = NULL WHERE id = (SELECT id FROM sys_message WHERE conversation = $1 AND state = 'scheduled' AND meta->>'at' IS NULL ORDER BY seq LIMIT 1)
				AND NOT EXISTS (SELECT 1 FROM sys_message WHERE conversation = $1 AND state IN ('queued', 'confirm', 'approved'))
				AND NOT EXISTS (SELECT 1 FROM sys_conversation WHERE parent = $1 AND status = 'running')`
			);
			return (yield* commit(chain, source)).length > 0;
		}),
		/** Input landed for a running turn. */
		ring: (conversation: string) => PubSub.publish(steers, conversation).pipe(Effect.asVoid),
		/** Ends once input waits for the conversation. */
		heard: (conversation: string) =>
			Effect.scoped(
				Effect.gen(function* () {
					const rings = yield* PubSub.subscribe(steers);
					for (;;) {
						const [waiting] = yield* db.read([
							sql(
								`SELECT 1 FROM sys_message WHERE conversation = $1 AND state = 'queued' LIMIT 1`,
								conversation
							)
						]);
						if ((waiting?.rows.length ?? 0) > 0) return;
						yield* PubSub.take(rings).pipe(
							Effect.repeat({ until: (ring) => ring === conversation })
						);
					}
				})
			),
		/** Input is waiting for the conversation. */
		waiting: Effect.fn('MessageQueue.waiting')(function* (conversation: string) {
			const [left] = yield* db.read([
				sql(
					`SELECT 1 FROM sys_message WHERE conversation = $1 AND state = 'queued' LIMIT 1`,
					conversation
				)
			]);
			return (left?.rows.length ?? 0) > 0;
		}),
		revise: Effect.fn('MessageQueue.revise')(function* (
			messageId: string,
			text: string,
			by?: Authority,
			attachments?: readonly Json[]
		) {
			const r: MessageRow | undefined = yield* stored(messageId);
			if (r === undefined || r.role !== 'user' || r.as === null)
				return yield* Effect.fail(
					new AgentRefusal({ message: 'only a posted message can be revised' })
				);
			if (by !== undefined && !owns(by, r.as))
				return yield* Effect.fail(
					new AgentRefusal({ message: 'only its author revises a message' })
				);
			const newer = yield* db.one(Schema.Struct({ found: Schema.Boolean }),
				sql(`SELECT true AS found FROM sys_message WHERE supersedes = $1 LIMIT 1`, messageId));
			if (Option.isSome(newer))
				return yield* Effect.fail(
					new AgentRefusal({ message: 'only the newest revision can be revised' })
				);
			const files = attachments ?? r.files ?? [];
			if (text.trim() === '' && files.length === 0)
				return yield* Effect.fail(new AgentRefusal({ message: 'A message needs text or an attachment.' }));
			if (r.state === 'queued' || r.state === 'scheduled') {
				const chain = new Chain();
				chain.params.push(messageId, text, preview(text));
				const refs = `${chain.p(files)}::jsonb`;
				const source = messagePiece(
					chain,
					`UPDATE sys_message m SET text = $2, preview = $3, content = content || jsonb_build_object('text', $2::text)
					WHERE id = $1 AND state IN ('queued', 'scheduled')`,
					undefined,
					refs
				);
				capturePiece(chain, 'revised_inputs', 'sys_conversation',
					`UPDATE sys_conversation SET inputs =
					(SELECT coalesce(jsonb_agg(f ORDER BY at), '[]'::jsonb) FROM jsonb_array_elements(inputs) WITH ORDINALITY AS x(f, at) WHERE f->>'message' IS DISTINCT FROM $1)
					|| (SELECT coalesce(jsonb_agg(f || jsonb_build_object('message', $1::text)), '[]'::jsonb) FROM jsonb_array_elements(${refs}) f)
					WHERE id = ${chain.p(r.conversation)} AND EXISTS (SELECT 1 FROM ${source})`);
				const revised = yield* commit(chain, source);
				if (revised.length === 0)
					return yield* Effect.fail(new AgentRefusal({ message: 'The message was delivered before the edit. Read the latest conversation.' }));
				return r.id;
			}
			return (yield* post({
				conversation: r.conversation,
				as: r.as,
				text,
				author: r.author,
				mode: r.mode ?? 'agent',
				supersedes: r.id,
				files
			})).id;
		}),
		remove: Effect.fn('MessageQueue.remove')(function* (messageId: string, by?: Authority) {
			const r = yield* stored(messageId);
			if (by !== undefined && (r === undefined || !owns(by, r.as)))
				return yield* Effect.fail(
					new AgentRefusal({ message: 'only its author removes a queued message' })
				);
			if (r === undefined) return;
			const chain = new Chain();
			chain.params.push(messageId);
			runPiece(chain, 'unscheduled', `DELETE FROM sys_run WHERE automation = '${SCHEDULED_RUN}' AND state = 'queued' AND input->>'message' = $1`);
			yield* commit(
				chain,
				cancelMessage(chain, r.conversation, messageId, true)
			);
		}),
		reorder: Effect.fn('MessageQueue.reorder')(function* (
			conversation: string,
			ids: readonly string[],
			by?: Authority
		) {
			const queued = (yield* db.rows(Schema.Struct({ r: Message }),
					sql(
						`SELECT ${MSG} FROM sys_message m WHERE conversation = $1 AND state = 'queued' AND id IN (SELECT jsonb_array_elements_text($2::jsonb))`,
						conversation,
						JSON.stringify(ids)
					)
			)).map((row) => row.r);
			if (queued.length !== new Set(ids).size || queued.length !== ids.length)
				return yield* Effect.fail(
					new AgentRefusal({
						message: 'only queued messages of this conversation can be reordered'
					})
				);
			if (by !== undefined && queued.some((r) => !owns(by, r.as)))
				return yield* Effect.fail(
					new AgentRefusal({ message: 'only its author reorders a queued message' })
				);
			// the rows swap their own seq values, so nothing else in the transcript moves
			const chain = new Chain();
			chain.params.push(JSON.stringify(ids));
			const want = chain.cte('want', `SELECT id, ord FROM jsonb_array_elements_text($1::jsonb) WITH ORDINALITY AS t(id, ord)`);
			const locked = chain.cte('locked', `SELECT m.id, m.seq FROM sys_message m JOIN ${want} w ON w.id = m.id
				WHERE m.conversation = ${chain.p(conversation)} AND m.state = 'queued' ORDER BY m.id FOR UPDATE OF m`);
			chain.assert(`(SELECT count(*) FROM ${locked}) = ${chain.p(ids.length)}`, 'conflict',
				{ message: 'The queue changed before it could be reordered. Read the latest conversation.' }, 'true');
			yield* commit(
				chain,
				messagePiece(
					chain,
					`WITH slot AS (SELECT seq, row_number() OVER (ORDER BY seq) AS n FROM ${locked})
				UPDATE sys_message m SET seq = slot.seq FROM ${want} JOIN slot ON slot.n = want.ord
				WHERE m.id = want.id AND m.id IN (SELECT id FROM ${locked}) AND m.state = 'queued'`
				)
			);
		})
	};
});
export type Queue = Effect.Success<ReturnType<typeof messageQueue>>;
export class MessageQueue extends Context.Service<MessageQueue, Queue>()('bolt/MessageQueue') {}
