// Conversation and message persistence, turn leasing, durable job records, and transcript settlement.
import { Deferred, Effect, Option, Schema } from 'effect';
import { type Sql, uuidv7 } from '@norbital-ai/host-api';
import type { Json } from '../../decl/values.ts';
import { BoltError } from '../../protocol/errors.ts';
import type { Bindings } from '../contracts.ts';
import {
	cancel as cancelMessage,
	msg as messagePiece,
	MSG,
	post as postMessage
} from '../conversations/store.ts';
import { CapturedResult, capturePiece, nativeCommit } from '../db/captured.ts';
import { sql } from '../db/sql.ts';
import type { TenantDbShape } from '../db/tenant-db.ts';
import { leaseUntil } from '../queue.ts';
import { next_due } from '../runs/queue.ts';
import { runPiece } from '../runs/rows.ts';
import type { AgentsShape, LiveShape } from '../services.ts';
import { Chain } from '../write/sql.ts';
import { pageWaiting, projection } from './context.ts';
import {
	AgentRefusal,
	Conversation,
	Message,
	rowsOf,
	storable,
	type As,
	type ConversationRow,
	type MessageRow,
	type Meta
} from './schema.ts';
import {
	AGENT_LIMITS,
	CONV_COLS,
	DEFAULT_MODEL,
	FIXED,
	j,
	PAGE_ANSWER_MS
} from './shared.ts';
import { enqueueTurn, TURN_RUN } from './turns.ts';

export type StoreDeps = {
	readonly db: TenantDbShape;
	readonly publish: LiveShape['publish'];
	readonly bindings: Effect.Effect<Bindings>;
	readonly announce?: ((at: string) => Effect.Effect<void>) | undefined;
	readonly kick: (conversation: string) => Effect.Effect<void>;
};

export type InsertMessageRow = {
	conversation: string;
	role: MessageRow['role'];
	content: Json;
	text?: string | null;
	state?: MessageRow['state'];
	mode?: MessageRow['mode'];
	as?: As | null;
	author?: string | null;
	meta?: Meta | null;
	supersedes?: string | null;
	turn?: string | null;
	files?: readonly Json[];
	addressed?: false;
};

const UNTURN = `DELETE FROM sys_run WHERE automation = '${TURN_RUN}' AND state = 'queued' AND input->>'conversation' = $1`;
const JOB_RECORD = `m.conversation IS NULL AND m.state = 'job'`;

export const makeAgentStore = (deps: StoreDeps) => {
	const { db, publish, bindings, announce, kick } = deps;

	const messageStatement = Effect.fn('Agents.messageStatement')(function* (
		chain: Chain,
		source: string
	) {
		const result = yield* nativeCommit(
			db.write,
			publish,
			chain,
			Schema.Struct({ ...CapturedResult.fields, messages: Schema.Array(Message) }).annotate({
				identifier: 'sys_message'
			}),
			`(SELECT coalesce(jsonb_agg(r), '[]'::jsonb) FROM ${source}) AS messages`
		);
		return result.messages;
	});

	const changed = Effect.fn('Agents.changed')(function* (statement: Sql) {
		const chain = new Chain();
		chain.params.push(...statement.params);
		const source = messagePiece(chain, statement.text);
		return yield* messageStatement(chain, source);
	});

	const cancelQueued = (conversation: string) => {
		const chain = new Chain();
		return messageStatement(chain, cancelMessage(chain, conversation, null));
	};

	const convChanged = Effect.fn('Agents.conversationChanged')(function* (statement: Sql) {
		const chain = new Chain();
		chain.params.push(...statement.params);
		const source = capturePiece(chain, 'conversation', 'sys_conversation', statement.text, {
			returning: 'to_jsonb(c) AS r'
		});
		const result = yield* nativeCommit(
			db.write,
			publish,
			chain,
			Schema.Struct({
				...CapturedResult.fields,
				rows: Schema.Array(Schema.Record(Schema.String, Schema.Json))
			}),
			`(SELECT coalesce(jsonb_agg(r), '[]'::jsonb) FROM ${source}) AS rows`
		);
		return result.rows;
	});

	const discard = (row: MessageRow) =>
		changed(sql('DELETE FROM sys_message m WHERE id = $1', row.id));

	const unfinished = (conversation: string, of?: string) =>
		changed(
			sql(
				`UPDATE sys_message m SET state = NULL, meta = CASE WHEN role = 'assistant' THEN coalesce(meta, '{"tag":"cut"}'::jsonb) ELSE meta END,
				content = CASE WHEN role = 'tool' THEN content || '{"result":{"error":"The turn ended before this call finished."}}'::jsonb ELSE content END
				WHERE conversation = $1 AND state IN ('streaming', 'running') ${of === undefined ? '' : 'AND turn = $2'}`,
				...(of === undefined ? [conversation] : [conversation, of])
			)
		).pipe(Effect.tapCause(Effect.logWarning));

	const conversation = Effect.fn('Agents.conversation')(function* (id: string) {
		const row = yield* db.one(
			Conversation,
			sql(`SELECT ${CONV_COLS} FROM sys_conversation WHERE id = $1`, id)
		);
		if (Option.isNone(row)) return yield* new AgentRefusal({ message: `no conversation '${id}'` });
		return row.value;
	});

	const maybeConversation = (id: string) =>
		conversation(id).pipe(
			Effect.tapCause(Effect.logWarning),
			Effect.catchTag('AgentRefusal', () => Effect.succeed(null))
		);

	const transcript = Effect.fn('Agents.transcript')(function* (
		id: string,
		page?: { from: number } | { before: number; limit: number }
	) {
		const [result] = yield* db.read([
			page === undefined
				? sql(`SELECT ${MSG} FROM sys_message m WHERE conversation = $1 ORDER BY seq`, id)
				: 'from' in page
					? sql(
							`SELECT ${MSG} FROM sys_message m WHERE conversation = $1 AND seq >= $2 ORDER BY seq`,
							id,
							page.from
						)
					: sql(
							`SELECT x.r FROM (SELECT ${MSG}, m.seq FROM sys_message m WHERE conversation = $1 AND seq < $2 ORDER BY seq DESC LIMIT $3) x ORDER BY x.seq`,
							id,
							page.before,
							page.limit
						)
		]);
		return yield* rowsOf(result?.rows ?? []);
	});

	const insert = Effect.fn('Agents.insert')(function* (row: InsertMessageRow) {
		const chain = new Chain();
		const source = postMessage(chain, {
			...row,
			content: storable(row.content),
			...(row.text === undefined || row.text === null ? {} : { text: storable(row.text) }),
			state: row.state ?? null,
			mode: row.mode ?? null,
			as: row.as ?? null,
			meta: row.meta === undefined || row.meta === null ? null : storable(row.meta),
			files: row.files === undefined ? [] : [...row.files]
		});
		const [message] = yield* messageStatement(chain, source);
		if (message === undefined)
			return yield* BoltError.make('corrupt', 'commit', 'the message insert returned no row');
		return message;
	});

	const setConv = (id: string, set: string, ...params: Json[]) =>
		convChanged(
			sql(
				`UPDATE sys_conversation AS c SET ${set}, revision = revision + 1, updated_at = now() WHERE id = $1`,
				id,
				...params
			)
		);

	const start = Effect.fn('Agents.start')(function* (o: Parameters<AgentsShape['start']>[0]) {
		const id = uuidv7();
		yield* convChanged(
			sql(
				`INSERT INTO sys_conversation AS c (id, title, owner, envoy, integration, parent, model) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
				id,
				o.title ?? null,
				o.owner ?? null,
				o.envoy ?? null,
				o.integration ?? null,
				o.parent ?? null,
				o.model ?? DEFAULT_MODEL
			)
		);
		return id;
	});

	const ambient = (o: {
		conversation: string;
		text: string;
		author: string;
		files?: readonly Json[];
	}) =>
		insert({
			conversation: o.conversation,
			role: 'user',
			content: { text: o.text },
			text: o.text,
			author: o.author,
			addressed: false,
			...(o.files === undefined ? {} : { files: o.files })
		});

	const runningChildren = Effect.fn('Agents.runningChildren')(function* (parent: string) {
		return yield* db.value(
			Schema.Number,
			sql(
				`SELECT count(*)::int AS n FROM sys_conversation WHERE parent = $1 AND status = 'running'`,
				parent
			)
		);
	});

	const ownChild = Effect.fn('Agents.ownChild')(function* (parent: string, child: string) {
		return (yield* maybeConversation(child))?.parent === parent;
	});

	const claim = Effect.fn('Agents.claim')(function* (id: string) {
		const now = (yield* bindings).now,
			due = leaseUntil(now, AGENT_LIMITS.leaseMs),
			chain = new Chain();
		capturePiece(
			chain,
			'c',
			'sys_conversation',
			`UPDATE sys_conversation SET status = 'running', updated_at = ${chain.p(now)}::timestamptz, lease_until = ${chain.p(due)}::timestamptz
			WHERE id = ${chain.p(id)} AND (status = 'idle' OR (status = 'running' AND lease_until < ${chain.p(now)}::timestamptz))`
		);
		enqueueTurn(chain, id, due, 'EXISTS (SELECT 1 FROM c)');
		const result = yield* nativeCommit(
			db.write,
			publish,
			chain,
			Schema.Struct({
				...CapturedResult.fields,
				claimed: Schema.Number,
				next_due: Schema.NullOr(Schema.String),
				taken: Schema.Boolean
			}),
			`(SELECT count(*)::int FROM c) AS claimed, ${next_due(chain)}::text AS next_due,
			EXISTS (SELECT 1 FROM sys_conversation WHERE id = ${chain.p(id)} AND status = 'running') AS taken`
		);
		if (result.next_due !== null) yield* announce?.(result.next_due) ?? Effect.void;
		return result.claimed !== 1 ? null : result.taken ? 'takeover' : 'claimed';
	});

	const release = (id: string) =>
		Effect.gen(function* () {
			const now = (yield* bindings).now,
				chain = new Chain();
			chain.params.push(id, now);
			capturePiece(
				chain,
				'released',
				'sys_conversation',
				"UPDATE sys_conversation SET lease_until = $2::timestamptz WHERE id = $1 AND status = 'running'"
			);
			runPiece(
				chain,
				'moved',
				`UPDATE sys_run SET due_at = $2::timestamptz
			WHERE automation = '${TURN_RUN}' AND state = 'queued' AND input->>'conversation' = $1 AND EXISTS (SELECT 1 FROM released)`
			);
			const result = yield* nativeCommit(
				db.write,
				publish,
				chain,
				Schema.Struct({ ...CapturedResult.fields, moved: Schema.Number }),
				'(SELECT count(*)::int FROM moved) AS moved'
			);
			if (result.moved > 0) yield* announce?.(now) ?? Effect.void;
		}).pipe(Effect.timeout(2000), Effect.tapCause(Effect.logWarning), Effect.ignore);

	const idle = Effect.fn('Agents.idle')(function* (id: string, onlyEmpty: boolean) {
		const chain = new Chain();
		chain.params.push(id);
		capturePiece(
			chain,
			'settled',
			'sys_conversation',
			`UPDATE sys_conversation SET status = 'idle', lease_until = NULL
			WHERE id = $1 AND status = 'running'${onlyEmpty ? " AND NOT EXISTS (SELECT 1 FROM sys_message WHERE conversation = $1 AND state = 'queued')" : ''}`
		);
		runPiece(chain, 'unqueued', `${UNTURN} AND EXISTS (SELECT 1 FROM settled)`);
		const result = yield* nativeCommit(
			db.write,
			publish,
			chain,
			Schema.Struct({ ...CapturedResult.fields, changed: Schema.Number }),
			'(SELECT count(*)::int FROM settled) AS changed'
		);
		return result.changed;
	});

	const queuedNote = (conversationId: string, as: As | null, text: string) =>
		insert({
			conversation: conversationId,
			role: 'system',
			content: { text },
			text,
			state: 'queued',
			mode: 'agent',
			as,
			meta: { tag: 'note' }
		});

	const openJob = (conversationId: string, as: As | null, job: string, label: string) =>
		db
			.returning(
				Schema.Struct({ id: Schema.String }),
				sql(
					`INSERT INTO sys_message AS m (id, role, content, text, preview, state, mode, "as", meta)
			VALUES (uuidv7()::text, 'system', $1::jsonb, $2, $2, 'job', 'agent', $3::jsonb, '{"tag":"note"}'::jsonb) RETURNING id`,
					j({ conversation: conversationId }),
					`[job ${job} died] ${label}: its host stopped before it finished`,
					j(as)
				)
			)
			.pipe(
				Effect.map(([row]) => row?.id),
				Effect.tapCause(Effect.logWarning),
				Effect.orElseSucceed(() => undefined)
			);

	const closeJob = (conversationId: string, record: string, late: string | undefined) =>
		(late === undefined
			? db
					.returning(
						Schema.Struct({ id: Schema.String }),
						sql(`DELETE FROM sys_message m WHERE id = $1 AND ${JOB_RECORD} RETURNING id`, record)
					)
					.pipe(Effect.map((rows) => rows.length > 0))
			: changed(
					sql(
						`UPDATE sys_message m SET conversation = content->>'conversation', content = jsonb_build_object('text', $2::text), text = $2, preview = $2, state = 'queued'
					WHERE id = $1 AND ${JOB_RECORD}`,
						record,
						late
					)
				).pipe(
					Effect.tap((rows) => (rows.length === 0 ? Effect.void : kick(conversationId))),
					Effect.as(false)
				)
		).pipe(
			Effect.tapCause(Effect.logWarning),
			Effect.orElseSucceed(() => true)
		);

	const jobsDied = Effect.gen(function* () {
		const rows = yield* changed(
			sql(
				`UPDATE sys_message m SET conversation = content->>'conversation', content = jsonb_build_object('text', text), state = 'queued'
			WHERE ${JOB_RECORD} AND EXISTS (SELECT 1 FROM sys_conversation c WHERE c.id = m.content->>'conversation')`
			)
		);
		yield* db.write(
			sql(
				`DELETE FROM sys_message m WHERE ${JOB_RECORD} AND NOT EXISTS (SELECT 1 FROM sys_conversation c WHERE c.id = m.content->>'conversation')`
			)
		);
		for (const id of new Set(rows.map((r) => r.conversation))) yield* kick(id);
	}).pipe(Effect.tapCause(Effect.logWarning), Effect.ignore);

	const confirmations = new Map<string, Set<Deferred.Deferred<void>>>();
	const withConfirmation = <A, E, R>(conversationId: string, work: Effect.Effect<A, E, R>) =>
		Effect.acquireUseRelease(
			Effect.gen(function* () {
				const done = yield* Deferred.make<void>();
				const active = confirmations.get(conversationId) ?? new Set<Deferred.Deferred<void>>();
				active.add(done);
				confirmations.set(conversationId, active);
				return done;
			}),
			() => work,
			(done) =>
				Effect.sync(() => {
					const active = confirmations.get(conversationId);
					active?.delete(done);
					if (active?.size === 0) confirmations.delete(conversationId);
					Deferred.doneUnsafe(done, Effect.void);
				})
		);

	const declinePending = (id: string) =>
		changed(
			sql(
				`UPDATE sys_message m SET state = NULL, content = content || jsonb_build_object('result', $2::jsonb, 'resumed', true)
		 WHERE conversation = $1 AND role = 'tool' AND state = 'confirm' AND meta->>'tag' = 'confirm'`,
				id,
				j({ declined: true, reason: 'A new turn started before approval.' })
			)
		);

	const modelRows = Effect.fn('Agents.modelRows')(function* (
		id: string,
		conv: Pick<ConversationRow, 'plan'>
	) {
		for (;;) {
			const rows = yield* transcript(id);
			const inFlight = (row: MessageRow) =>
				(row.role === 'tool' && row.state === 'running') ||
				(row.role === 'assistant' && row.state === 'streaming');
			if (rows.some(inFlight)) {
				yield* unfinished(id);
				if ((yield* transcript(id)).some(inFlight))
					return yield* BoltError.make(
						'corrupt',
						'admission',
						'The previous step could not be settled.'
					);
				continue;
			}
			if (
				rows.some(
					(row) =>
						row.role === 'tool' &&
						(row.state === 'confirm' || row.state === 'approved') &&
						row.meta?.tag !== 'confirm'
				)
			)
				return yield* BoltError.make(
					'corrupt',
					'admission',
					'An unsettled confirmation has no saved call.'
				);
			if (rows.some((row) => row.role === 'tool' && row.state === 'confirm')) {
				yield* declinePending(id);
				continue;
			}
			if (!rows.some((row) => row.role === 'tool' && row.state === 'approved')) {
				const missing = projection(rows, conv).flatMap((row) =>
					row.role === 'assistant' && row.content !== null && typeof row.content === 'object'
						? (row.content.toolCalls ?? [])
								.filter(
									(call) =>
										!rows.some(
											(tool) =>
												tool.role === 'tool' &&
												tool.content.assistant === row.id &&
												tool.content.id === call.id
										)
								)
								.map((call) => ({ row, call }))
						: []
				);
				if (missing.length === 0) return rows;
				for (const { row, call } of missing)
					yield* insert({
						conversation: id,
						role: 'tool',
						content: {
							id: call.id,
							name: call.name,
							assistant: row.id,
							result: { error: FIXED.unreported }
						},
						turn: row.turn
					});
				continue;
			}
			const active = [...(confirmations.get(id) ?? [])];
			if (active.length > 0)
				yield* Effect.forEach(active, Deferred.await, {
					concurrency: 'unbounded',
					discard: true
				});
			else
				yield* changed(
					sql(
						`UPDATE sys_message m SET state = NULL, content = content || jsonb_build_object('result', $2::jsonb)
				 WHERE conversation = $1 AND role = 'tool' AND state = 'approved' AND meta->>'tag' = 'confirm'`,
						id,
						j({ error: FIXED.unreported })
					)
				);
		}
	});

	const pageWaits = new Map<string, Deferred.Deferred<void>>();
	const pageAnswer = Effect.fn('Agents.pageAnswer')(function* (
		id: string,
		conv: Pick<ConversationRow, 'plan'>
	) {
		const answered = yield* Deferred.make<void>();
		pageWaits.set(id, answered);
		return yield* Effect.gen(function* () {
			const rows = yield* modelRows(id, conv);
			if (!pageWaiting(rows)) return rows;
			yield* Deferred.await(answered).pipe(Effect.timeoutOption(PAGE_ANSWER_MS));
			return yield* modelRows(id, conv);
		}).pipe(
			Effect.ensuring(
				Effect.sync(() => {
					if (pageWaits.get(id) === answered) pageWaits.delete(id);
				})
			)
		);
	});

	return {
		messageStatement,
		changed,
		cancelQueued,
		convChanged,
		discard,
		unfinished,
		conversation,
		maybeConversation,
		transcript,
		insert,
		setConv,
		start,
		ambient,
		runningChildren,
		ownChild,
		claim,
		release,
		idle,
		queuedNote,
		openJob,
		closeJob,
		jobsDied,
		withConfirmation,
		declinePending,
		modelRows,
		pageWaits,
		pageAnswer
	};
};

export type AgentStore = ReturnType<typeof makeAgentStore>;
