// The message queue (rules 58, 60): how a person's message reaches a turn. A message goes at once: it is queued in one
// statement with the conversation's `agent.turn` run, so no process death strands it, the next step of a running turn takes
// it (an open `wait` gives way, so the step ends) and an idle conversation starts a turn. Only the sender holds a message
// back: `schedule` keeps it until a time (its own run) or until the running work has finished, one message per finish, after
// the plan's verifier cleared, with no sub-agent running and no card awaiting the person. A stop cancels what waits for
// the finish, never what waits for a time.
import { Context, Effect, PubSub, Schema } from 'effect';
import type { Json } from '../../decl/values.ts';
import { BoltError } from '../../protocol/errors.ts';
import type { Authority } from '../contracts.ts';
import { msg as messagePiece, MSG, post as postMessage, preview } from '../conversations/store.ts';
import type { TenantDbShape } from '../db/tenant-db.ts';
import { enqueue, nextDue } from '../runs/queue.ts';
import type { AgentsShape, LiveShape } from '../services.ts';
import { Chain } from '../write/sql.ts';
import {
	AgentRefusal,
	conversationCommit,
	Message,
	messageCommit,
	rowsOf,
	type As,
	type MessageRow
} from './schema.ts';
import { enqueueTurn, TURN_LEASE_MS } from './turns.ts';

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
const q = (text: string, ...params: Json[]) => ({ text, params });
const Written = Schema.Struct({
	messages: Schema.Array(Message),
	conversations: Schema.Array(Schema.Record(Schema.String, Schema.Json)),
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
		source: string,
		opened?: string
	) {
		const [result] = yield* db.returning(
			Written,
			chain.sql(`(SELECT coalesce(jsonb_agg(r), '[]'::jsonb) FROM ${source}) AS messages,
			${opened === undefined ? `'[]'::jsonb` : `(SELECT coalesce(jsonb_agg(r), '[]'::jsonb) FROM ${opened})`} AS conversations,
			${nextDue(chain)}::text AS due`)
		);
		if (result === undefined)
			return yield* Effect.fail(
				BoltError.make('corrupt', 'commit', 'a queue statement returned no result')
			);
		if (result.messages.length > 0) cfg.publish(messageCommit(result.messages));
		if (result.conversations.length > 0) cfg.publish(conversationCommit(result.conversations));
		if (result.due !== null) yield* cfg.announce(result.due);
		return result.messages;
	});
	const lease = cfg.now.pipe(
		Effect.map((now) => new Date(Date.parse(now) + TURN_LEASE_MS).toISOString())
	);
	const stored = Effect.fn('MessageQueue.stored')(function* (message: string) {
		const [r] = yield* rowsOf(
			(yield* db.read([q(`SELECT ${MSG} FROM sys_message m WHERE id = $1`, message)]))[0]!.rows
		);
		return r;
	});
	const post = Effect.fn('MessageQueue.post')(function* (o: Parameters<AgentsShape['post']>[0]) {
		// a follow-up in a stopped conversation runs; the stopped turn's cancelled inputs stay cancelled (L-BOLT-408)
		// an untitled conversation is named by its first message (the panel's list). Its own statement: posting a file
		// writes the same conversation row, and one statement cannot write a row twice
		const opened = yield* Schema.decodeUnknownEffect(
			Schema.Array(Schema.Record(Schema.String, Schema.Json))
		)(
			(yield* db.write(
				q(
					`UPDATE sys_conversation AS c SET status = CASE WHEN status = 'stopped' THEN 'idle' ELSE status END, title = coalesce(title, left($2, 80))
					WHERE id = $1 AND (status = 'stopped' OR title IS NULL) RETURNING to_jsonb(c) AS r`,
					o.conversation,
					o.text
				)
			)).rows.map((x) => x['r'])
		).pipe(Effect.mapError((error) => BoltError.make('corrupt', 'decode', error.message, error)));
		if (opened.length > 0) cfg.publish(conversationCommit(opened));
		const due = yield* lease,
			chain = new Chain();
		const source = postMessage(chain, {
			conversation: o.conversation,
			role: 'user',
			content: { text: o.text, ...(o.tz === undefined ? {} : { tz: o.tz }) },
			text: o.text,
			state: 'queued',
			mode: o.mode ?? 'agent',
			as: o.as,
			author: o.author ?? null,
			supersedes: o.supersedes ?? null,
			files: o.files === undefined ? [] : [...o.files]
		});
		enqueueTurn(chain, o.conversation, due);
		const [row] = yield* commit(chain, source);
		if (row === undefined)
			return yield* Effect.fail(
				BoltError.make('corrupt', 'commit', 'the message insert returned no row')
			);
		return row;
	});
	return {
		post,
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
				Effect.mapError((error) => BoltError.make('invalidInput', 'decode', error.message, error))
			);
			const until = yield* lease,
				chain = new Chain();
			chain.params.push(message, conversation);
			const source = messagePiece(
				chain,
				`UPDATE sys_message m SET state = 'queued', meta = NULL WHERE id = $1 AND state = 'scheduled'`
			);
			const opened = chain.cte(
				'opened',
				`UPDATE sys_conversation AS c SET status = 'idle' WHERE id = $2 AND status = 'stopped' AND EXISTS (SELECT 1 FROM ${source}) RETURNING to_jsonb(c) AS r`
			);
			enqueueTurn(chain, conversation, until, `EXISTS (SELECT 1 FROM ${source})`);
			const sent = yield* commit(chain, source, opened);
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
							q(
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
				q(
					`SELECT 1 FROM sys_message WHERE conversation = $1 AND state = 'queued' LIMIT 1`,
					conversation
				)
			]);
			return (left?.rows.length ?? 0) > 0;
		}),
		revise: Effect.fn('MessageQueue.revise')(function* (
			messageId: string,
			text: string,
			by?: Authority
		) {
			const r: MessageRow | undefined = yield* stored(messageId);
			if (r === undefined || r.role !== 'user')
				return yield* Effect.fail(
					new AgentRefusal({ message: 'only a posted message can be revised' })
				);
			if (by !== undefined && !owns(by, r.as))
				return yield* Effect.fail(
					new AgentRefusal({ message: 'only its author revises a message' })
				);
			const [newer] = (yield* db.read([
				q(`SELECT 1 FROM sys_message WHERE supersedes = $1 LIMIT 1`, messageId)
			]))[0]!.rows;
			if (newer !== undefined)
				return yield* Effect.fail(
					new AgentRefusal({ message: 'only the newest revision can be revised' })
				);
			if (r.state === 'queued' || r.state === 'scheduled') {
				const chain = new Chain();
				chain.params.push(messageId, text, preview(text));
				yield* commit(
					chain,
					messagePiece(
						chain,
						`UPDATE sys_message m SET text = $2, preview = $3, content = content || jsonb_build_object('text', $2::text) WHERE id = $1`
					)
				);
				return r.id;
			}
			return (yield* post({
				conversation: r.conversation,
				as: r.as!,
				text,
				author: r.author,
				mode: r.mode ?? 'agent',
				supersedes: r.id
			})).id;
		}),
		remove: Effect.fn('MessageQueue.remove')(function* (messageId: string, by?: Authority) {
			const r = yield* stored(messageId);
			if (by !== undefined && (r === undefined || !owns(by, r.as)))
				return yield* Effect.fail(
					new AgentRefusal({ message: 'only its author removes a queued message' })
				);
			const chain = new Chain();
			chain.params.push(messageId);
			chain.cte(
				'unscheduled',
				`DELETE FROM sys_run WHERE automation = '${SCHEDULED_RUN}' AND state = 'queued' AND input->>'message' = $1 RETURNING id`
			);
			yield* commit(
				chain,
				messagePiece(
					chain,
					`UPDATE sys_message m SET state = 'cancelled' WHERE id = $1 AND state IN ('queued', 'scheduled')`
				)
			);
		}),
		reorder: Effect.fn('MessageQueue.reorder')(function* (
			conversation: string,
			ids: readonly string[],
			by?: Authority
		) {
			const queued = yield* rowsOf(
				(yield* db.read([
					q(
						`SELECT ${MSG} FROM sys_message m WHERE conversation = $1 AND state = 'queued' AND id IN (SELECT jsonb_array_elements_text($2::jsonb))`,
						conversation,
						JSON.stringify(ids)
					)
				]))[0]!.rows
			);
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
			yield* commit(
				chain,
				messagePiece(
					chain,
					`WITH want AS (SELECT id, ord FROM jsonb_array_elements_text($1::jsonb) WITH ORDINALITY AS t(id, ord)),
				slot AS (SELECT seq, row_number() OVER (ORDER BY seq) AS n FROM sys_message WHERE id IN (SELECT id FROM want))
				UPDATE sys_message m SET seq = slot.seq FROM want JOIN slot ON slot.n = want.ord WHERE m.id = want.id AND m.state = 'queued'`
				)
			);
		})
	};
});
export type Queue = Effect.Success<ReturnType<typeof messageQueue>>;
export class MessageQueue extends Context.Service<MessageQueue, Queue>()('bolt/MessageQueue') {}
