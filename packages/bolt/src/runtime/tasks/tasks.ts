import { Clock, Context, Effect, Layer, Number as ENumber, Schema } from 'effect';
import {
	EffectId,
	type DatabaseRequest,
	type EffectId as EffectIdType
} from '@norbital-ai/bolt-protocol';
import * as Database from '#lib/runtime/facilities/database.js';
import type { CallContext } from '#lib/runtime/facilities/database.js';
import { Tasks } from '#lib/runtime/facilities/services.js';
import {
	enqueueStatements,
	makeQueue,
	type Declaration,
	type Enqueue,
	type Rejection,
	type Statement
} from '#lib/runtime/tasks/queue.js';
import { makeRunner, type Run, type TickReport } from '#lib/runtime/tasks/runner.js';

/**
 * Scheduled and background work, composed against the facilities a host binds.
 *
 * This is the only module in `runtime/tasks/` that knows Effect services exist. `queue.ts` is a
 * function of `execute`, `runner.ts` is a function of a queue and a way to run a command, and this
 * is where those meet `Database` and `Tasks` — so the engine stays drivable by a test with no
 * database and no host, and everything host-shaped is in one file.
 *
 * **The task id a caller gets back is the effect id.** Not the row's uuid, and the difference
 * matters on a replay: an enqueue is `on conflict (effect_id) do nothing`, so a repeated enqueue
 * keeps the first row and a freshly minted uuid would name a row that was never written. The effect
 * id is stable, unique, and computable by the caller before the insert lands, which is what a
 * caller asking "how is my automation doing?" actually needs.
 */

export type Interface = Readonly<{
	/**
	 * Statements to append to a caller's own transaction.
	 *
	 * This is the whole durability story for work caused by a write: the task row cannot exist without
	 * the change that asked for it, and the change cannot commit without the task row. There is no
	 * second write and so nothing to reconcile. A caller using this must `wake` *before* it commits.
	 */
	readonly statements: (enqueues: ReadonlyArray<Enqueue>) => ReadonlyArray<Statement>;
	/** Tells the host to come back no later than this instant. Send before the commit, never after. */
	readonly wake: (
		effectId: EffectIdType,
		notLaterThanEpochMs: number
	) => Effect.Effect<void, Database.FacilityError>;
	/** Enqueues in a transaction of its own — for callers with no write of their own to ride. */
	readonly enqueue: (
		effectId: EffectIdType,
		enqueues: ReadonlyArray<Enqueue>
	) => Effect.Effect<void, Database.FacilityError>;
	/** Brings `bolt_schedule` into line with what this release declares, and says when next. */
	readonly declare: (
		effectId: EffectIdType,
		declarations: ReadonlyArray<Declaration>,
		nowEpochMs: number
	) => Effect.Effect<
		{
			readonly rejections: ReadonlyArray<Rejection>;
			readonly nextDueAtEpochMs: number | undefined;
		},
		Database.FacilityError
	>;
	/**
	 * One tick: roll, take, run, finish, and report when anything is next due.
	 *
	 * It reads the clock and the invocation's deadline itself rather than taking them, because both
	 * decide correctness rather than presentation — the hide interval a task is taken under *is* the
	 * remaining deadline, and a caller passing a number of its own could hand out a row that becomes
	 * visible again while the run that holds it is still going. There is one source for that number
	 * and it is the invocation.
	 */
	readonly tick: <E, R>(
		effectId: EffectIdType,
		run: Run<E, R>
	) => Effect.Effect<TickReport, E | Database.FacilityError, R>;
	/**
	 * The recent runs of one command, newest first.
	 *
	 * `status` answers about a task somebody already holds the id of, which is enough to watch a run
	 * you started and useless for the question "what has this automation been doing" — the answer to
	 * which is rows nobody in this session enqueued. Bounded rather than paged: a log surface wants
	 * the last handful, and an unbounded read of a table that has drained a year of work is a
	 * different feature with a different cost.
	 */
	readonly history: (
		effectId: EffectIdType,
		command: string,
		limit: number
	) => Effect.Effect<ReadonlyArray<Schema.Json>, Database.FacilityError>;
	/** What a queued item came to, by the id its enqueuer was given. */
	readonly status: (
		effectId: EffectIdType,
		taskId: string
	) => Effect.Effect<Schema.Json | undefined, Database.FacilityError>;
	/** Gives up on a queued item nobody wants any more. Running work is not interrupted. */
	readonly cancel: (
		effectId: EffectIdType,
		taskId: string
	) => Effect.Effect<void, Database.FacilityError>;
}>;

/** Identifies the task queue in Effect's context so dependency wiring remains explicit and type checked. */
export const Service = Context.Service<Interface>('@norbital-ai/bolt/TaskQueue');

/**
 * A statement list as the facility wants it.
 *
 * One statement goes as a `Query` rather than as a one-item `Transaction` because a host may serve a
 * `Query` off a pooled connection without opening a transaction at all — the distinction the
 * facility already draws, and the cheaper side of it.
 */
const asRequest = (statements: ReadonlyArray<Statement>): DatabaseRequest => {
	const only = statements.length === 1 ? statements[0] : undefined;
	return only === undefined
		? {
				_tag: 'Transaction',
				statements: statements.map((statement) => ({
					sql: statement.sql,
					parameters: statement.parameters
				}))
			}
		: { _tag: 'Query', sql: only.sql, parameters: only.parameters };
};

const JsonObject = Schema.Record(Schema.String, Schema.Json);
const DatabaseRows = Schema.Array(JsonObject);

/**
 * How long this invocation has left.
 *
 * Floored at one millisecond, exactly as `runtime/app.ts` floors the timeout it enforces against the
 * same field — one subtraction, one clamp, one meaning. The floor is why the runner has a floor of
 * its own: a tick that arrives past its deadline would otherwise hide a row for a millisecond and
 * burn an attempt on work it had no time to try.
 */
const remainingMillis = (deadlineEpochMs: number, nowEpochMs: number): number =>
	Math.max(1, deadlineEpochMs - nowEpochMs);

export const layer = (context: CallContext) =>
	Layer.effect(
		Service,
		Effect.gen(function* () {
			const database = yield* Database.Service;
			const tasks = yield* Tasks.Service;

			/**
			 * The queue's one dependency, built over the database facility.
			 *
			 * Each call takes its own effect id. The database facility meters per call and keys that meter
			 * on `(release, effectId)`, so a tick that used one id for all three round trips would have two
			 * of them billed to an observation that already exists.
			 */
			const executeUnder = (effectId: EffectIdType, label: string) => {
				let issued = 0;
				return (statements: ReadonlyArray<Statement>) => {
					issued += 1;
					return database
						.execute(EffectId.make(`${effectId}:${label}:${issued}`), asRequest(statements))
						.pipe(
							Effect.flatMap((response) =>
								Schema.decodeUnknownEffect(DatabaseRows)(response.rows).pipe(
									Effect.mapError(
										() =>
											new Database.FacilityError({
												operation: 'tasks',
												code: 'task_queue_invalid_response',
												message: 'Task queue database query returned a non-row value',
												retryable: false,
												outcome: 'known'
											})
									)
								)
							)
						);
				};
			};

			const queueUnder = (effectId: EffectIdType, label: string) =>
				makeQueue(executeUnder(effectId, label));

			/**
			 * Announces the instant, then writes the work — in that order, always.
			 *
			 * A host holds the earliest instant it has been told and ignores a later one, so this can be
			 * unconditional: the guest has no way to know what the host currently holds, and finding out
			 * would mean a round trip to learn something the host can decide for free in memory. What the
			 * *host* must do is only write its store when the instant moves earlier, which is what keeps a
			 * workspace whose next job is tomorrow from re-announcing on every write.
			 */
			const wake = Effect.fn('TaskQueue.wake')(function* (
				effectId: EffectIdType,
				notLaterThanEpochMs: number
			) {
				yield* tasks.execute(effectId, { _tag: 'Wake', notLaterThanEpochMs });
			});

			return Service.of({
				statements: enqueueStatements,
				wake,
				enqueue: Effect.fn('TaskQueue.enqueue')(function* (effectId, enqueues) {
					if (enqueues.length === 0) return;
					const nowEpochMs = yield* Clock.currentTimeMillis;
					const soonest = enqueues.reduce(
						(earliest, enqueue) => Math.min(earliest, enqueue.runAtEpochMs ?? nowEpochMs),
						Number.POSITIVE_INFINITY
					);
					yield* wake(EffectId.make(`${effectId}:wake`), soonest);
					yield* database.execute(effectId, asRequest(enqueueStatements(enqueues)));
				}),
				declare: Effect.fn('TaskQueue.declare')((effectId, declarations, nowEpochMs) =>
					queueUnder(effectId, 'declare').declare(declarations, nowEpochMs)
				),
				tick: (effectId, run) =>
					Effect.flatMap(Clock.currentTimeMillis, (nowEpochMs) =>
						makeRunner(queueUnder(effectId, 'tick'), run).tick({
							nowEpochMs,
							remainingMillis: remainingMillis(context.deadlineEpochMs, nowEpochMs)
						})
					),
				history: Effect.fn('TaskQueue.history')(function* (effectId, command, limit) {
					const rows = yield* database.execute(effectId, {
						_tag: 'Query',
						// `created_at` and not `updated_at`: a row that failed and was retried updates, and
						// ordering by that would shuffle a run up the list every time it was attempted again.
						// When a run *started* is the thing a reader is placing on a timeline.
						sql:
							'select effect_id, status, attempts, error, created_at, updated_at ' +
							'from bolt_task where command = $1 order by created_at desc limit $2',
						parameters: [command, ENumber.clamp({ minimum: 1, maximum: 50 })(Math.trunc(limit))]
					});
					return rows.rows;
				}),
				status: Effect.fn('TaskQueue.status')(function* (effectId, taskId) {
					const rows = yield* database.execute(effectId, {
						_tag: 'Query',
						sql: 'select status, attempts, max_attempts, error, result from bolt_task where effect_id = $1',
						parameters: [taskId]
					});
					return rows.rows[0];
				}),
				cancel: Effect.fn('TaskQueue.cancel')(function* (effectId, taskId) {
					// Only what has not started. A task already running is a fiber inside somebody else's
					// invocation, and there is nothing here that could reach into it — saying otherwise on the
					// row would be the queue reporting a stop it did not perform.
					yield* database.execute(effectId, {
						_tag: 'Query',
						sql: "update bolt_task set status = 'failed', error = 'cancelled', updated_at = now() where effect_id = $1 and status = 'pending'",
						parameters: [taskId]
					});
				})
			});
		})
	);
