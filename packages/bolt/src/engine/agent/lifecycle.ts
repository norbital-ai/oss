// Cross-turn lifecycle: late job steering, sub-agent reporting, turn-run scheduling, run-end propagation and restart recovery.
import { Effect, FiberSet, PubSub, Schema } from 'effect';
import type { Json } from '../../decl/values.ts';
import { BoltError } from '../../protocol/errors.ts';
import { CapturedResult, nativeCommit } from '../db/captured.ts';
import { sql } from '../db/sql.ts';
import type { EngineError } from '../errors.ts';
import { next_due } from '../runs/queue.ts';
import { Chain } from '../write/sql.ts';
import type { AgentStore } from './messages.ts';
import type { As, MessageRow } from './schema.ts';
import { FIXED, TurnInput, type AgentConfig, type DrainOptions } from './shared.ts';
import { enqueueTurn, TURN_RUN } from './turns.ts';

export type LifecycleDeps = {
	readonly config: AgentConfig;
	readonly store: AgentStore;
	readonly detached: FiberSet.FiberSet<unknown, never>;
	readonly watched: Set<string>;
	readonly reports: PubSub.PubSub<string>;
	readonly kick: (id: string) => Effect.Effect<void>;
	readonly drain: (
		id: string,
		options?: DrainOptions
	) => Effect.Effect<{ ran: boolean; reply: MessageRow | null }, EngineError>;
};

export const makeAgentLifecycle = (deps: LifecycleDeps) => {
	const { config, store, detached, watched, reports, kick, drain } = deps;
	const e = config.engine,
		db = e.db;

	const steer = (conversation: string, as: As | null, lines: readonly string[]) =>
		Effect.gen(function* () {
			for (const line of lines) yield* store.queuedNote(conversation, as, line);
			yield* FiberSet.run(detached, kick(conversation));
		}).pipe(Effect.tapCause(Effect.logWarning), Effect.ignore);

	/**
	 * A generation's start resumes, once, each approved call a switch-over restarted (its card settled by the old generation,
	 * no reply after it): the new generation runs the turn that reports it. One statement at start, none while idle.
	 */
	const resumeSettled = Effect.gen(function* () {
		const rows = yield* store.changed(
			sql(
				`UPDATE sys_message m SET content = content || '{"resumed":true}'::jsonb
				WHERE m.role = 'tool' AND m.state IS NULL AND m.meta->>'tag' = 'confirm' AND NOT m.content ? 'resumed'
				AND m.content->'result'->>'error' = $1
				AND NOT EXISTS (SELECT 1 FROM sys_message a WHERE a.conversation = m.conversation AND a.seq > m.seq AND a.role = 'assistant')`,
				FIXED.unreported
			)
		);
		for (const id of new Set(rows.map((r) => r.conversation)))
			yield* FiberSet.run(
				detached,
				drain(id, { force: true }).pipe(Effect.tapCause(Effect.logWarning), Effect.ignore)
			);
	}).pipe(Effect.tapCause(Effect.logWarning), Effect.ignore);

	/**
	 * A sub-agent's turn ended (its answer, a question for its parent, a failure or a stop): its report lands in the parent
	 * conversation as a queued input from the same sender, which a running parent turn claims at its next step and an idle
	 * parent runs a turn on. The sub-agent runs detached, so the parent can answer the person and finish meanwhile. A stop
	 * is reported by whoever stopped the turn (`stopped`), wherever the turn ran; the stopped turn's own end says nothing.
	 */
	const reportUp = Effect.fn('Agents.reportUp')(function* (
		child: string,
		reply: MessageRow | null,
		stopped: boolean = false
	) {
		const conv = yield* store.conversation(child);
		if (
			conv.parent === null ||
			conv.status === 'running' ||
			(conv.status === 'stopped') !== stopped
		)
			return;
		const task = (yield* store.transcript(child)).find((r) => r.role === 'user');
		const asked = reply?.meta?.tag === 'reply' && reply.meta.asked === true;
		// OpenCode's background `task` result; a question and a stop are ours
		const [state, summary] = stopped
			? ['cancelled', 'Background task cancelled']
			: asked
				? ['question', 'Background task asks you']
				: reply?.meta?.tag === 'failed'
					? ['error', 'Background task failed']
					: ['completed', 'Background task completed'];
		const tag = state === 'error' ? 'task_error' : 'task_result';
		const text = [
			`<task id="${child}" state="${state}">`,
			`<summary>${summary}: ${conv.title ?? ''}</summary>`,
			`<${tag}>`,
			reply?.text ?? '',
			`</${tag}>`,
			'</task>'
		].join('\n');
		yield* store.insert({
			conversation: conv.parent,
			role: 'user',
			content: { text },
			text,
			state: 'queued',
			mode: 'agent',
			as: task?.as ?? null,
			author: 'sub-agent',
			meta: { tag: 'report', conversation: child, ...(asked ? { asked: true as const } : {}) }
		});
		yield* PubSub.publish(reports, conv.parent);
		yield* FiberSet.run(detached, kick(conv.parent));
	});

	/** Turns that died with their host: each says so, and a sub-agent's parent hears it. */
	const gaveUp = (conversations: readonly string[]) =>
		Effect.forEach(
			conversations,
			(conversation) =>
				Effect.gen(function* () {
					const row = yield* store.insert({
						conversation,
						role: 'assistant',
						content: { text: FIXED.broke, toolCalls: [] },
						text: FIXED.broke,
						meta: { tag: 'failed', code: 'gaveUp' }
					});
					yield* reportUp(conversation, row).pipe(
						Effect.tapCause(Effect.logWarning),
						Effect.ignore
					);
				}),
			{ discard: true }
		);

	/**
	 * A run an in-app agent started ended where no turn of this process watches it (its watcher died with its host, or
	 * another generation ran it): one queued note in its conversation, once per run, which wakes it. A failed turn run
	 * (its third lost lease) whose turn's lease lapsed releases that turn and reports it now, not at the next boot.
	 */
	const runsEnded = Effect.fn('Agents.runsEnded')(function* (ids: readonly string[]) {
		const unwatched = ids.filter((id) => !watched.delete(id));
		if (unwatched.length === 0) return;
		const ended = yield* db.rows(
			Schema.Struct({
				id: Schema.String,
				automation: Schema.String,
				state: Schema.String,
				error: Schema.NullOr(Schema.String),
				conversation: Schema.String
			}),
			sql(
				`SELECT r.id::text AS id, r.automation, r.state, r.error->>'message' AS error,
				coalesce(r.trigger->'agent'->>'conversation', r.input->>'conversation') AS conversation
				FROM sys_run r WHERE r.id::text IN (SELECT jsonb_array_elements_text($1::jsonb)) AND r.state NOT IN ('queued', 'running', 'waiting')
				AND ((r.trigger->'agent'->>'conversation' IS NOT NULL
				AND NOT EXISTS (SELECT 1 FROM sys_message m WHERE m.conversation = r.trigger->'agent'->>'conversation' AND m.meta->>'run' = r.id::text))
				OR (r.automation = '${TURN_RUN}' AND r.state = 'failed'))`,
				JSON.stringify(unwatched)
			)
		);
		const turns = ended.filter((run) => run.automation === TURN_RUN);
		if (turns.length > 0) {
			const released = yield* store.convChanged(
				sql(
					`UPDATE sys_conversation AS c SET status = 'idle', lease_until = NULL, revision = revision + 1, updated_at = now()
				WHERE c.status = 'running' AND (c.lease_until IS NULL OR c.lease_until < $2::timestamptz) AND c.id IN (SELECT jsonb_array_elements_text($1::jsonb))`,
					JSON.stringify(turns.map((run) => run.conversation)),
					(yield* config.bindings).now
				)
			);
			yield* gaveUp(released.flatMap((row) => (typeof row['id'] === 'string' ? [row['id']] : [])));
		}
		for (const run of ended) {
			if (run.automation === TURN_RUN) continue;
			const text = `[run ${run.id} ${run.state}] automation ${run.automation}${run.error === null ? '' : `: ${run.error}`}`;
			yield* store.insert({
				conversation: run.conversation,
				role: 'system',
				content: { text },
				text,
				state: 'queued',
				mode: 'agent',
				meta: { tag: 'note', run: run.id }
			});
			yield* FiberSet.run(detached, kick(run.conversation));
		}
	});

	const turnRun = Effect.fn('Agents.turnRun')(function* (
		input: Json,
		run: (conversation: string, envoy: boolean) => Effect.Effect<{ ran: boolean }, EngineError>
	) {
		const { conversation: id } = yield* Schema.decodeUnknownEffect(TurnInput, {
			onExcessProperty: 'error'
		})(input).pipe(
			Effect.mapError((error) =>
				BoltError.make('invalid_input', 'decode', 'An agent turn needs a conversation id.', error)
			)
		);
		const conv = yield* store.maybeConversation(id);
		if (conv === null) return { conversation: id, gone: true };
		if ((yield* run(id, conv.envoy !== null && conv.integration !== null)).ran)
			return { conversation: id, ran: true };
		const [lease] = yield* db.read([
			sql(
				`SELECT (extract(epoch FROM lease_until) * 1000)::float8 AS until FROM sys_conversation WHERE id = $1 AND status = 'running'`,
				id
			)
		]);
		const live = lease?.rows[0];
		if (live === undefined) return { conversation: id, ran: false };
		const due = new Date(
			Math.max(Number(live['until']), Date.parse((yield* config.bindings).now)) + 1000
		).toISOString();
		const chain = new Chain();
		enqueueTurn(chain, id, due);
		const queued = yield* nativeCommit(
			db.write,
			e.live.publish,
			chain,
			Schema.Struct({ ...CapturedResult.fields, due: Schema.NullOr(Schema.String) }),
			`${next_due(chain)}::text AS due`
		);
		if (queued.due !== null) yield* config.announce?.(queued.due) ?? Effect.void;
		return { conversation: id, deferred: due };
	});

	return {
		steer,
		resumeSettled,
		reportUp,
		gaveUp,
		runsEnded,
		turnRun
	};
};
