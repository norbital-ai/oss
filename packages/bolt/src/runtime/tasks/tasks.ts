import { Context, Effect, Layer, type Schema } from 'effect';
import { EffectId, type DatabaseRequest, type EffectId as EffectIdType } from '@norbital-ai/bolt-protocol';
import { Database, type CallContext } from '../facilities/database.js';
import { Tasks } from '../facilities/services.js';
import {
	enqueueStatements,
	makeQueue,
	type Declaration,
	type Enqueue,
	type Rejection,
	type Statement
} from './queue.js';
import { makeRunner, type Run, type TickReport } from './runner.js';

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
					parameters: statement.parameters as ReadonlyArray<Schema.Json>
				}))
			}
		: { _tag: 'Query', sql: only.sql, parameters: only.parameters as ReadonlyArray<Schema.Json> };
};

/**
 * How long this invocation has left.
 *
 * Floored at one millisecond, exactly as `runtime/app.ts` floors the timeout it enforces against the
 * same field — one subtraction, one clamp, one meaning. The floor is why the runner has a floor of
 * its own: a tick that arrives past its deadline would otherwise hide a row for a millisecond and
 * burn an attempt on work it had no time to try.
 */
const remainingMillis = (deadlineEpochMs: number): number =>
	Math.max(1, deadlineEpochMs - Date.now());

export const layer = (context: CallContext) =>
	Layer.effect(
		Service,
		Effect.gen(function* () {
			const database = yield* Database.Service;
			const tasks = yield* Tasks.Service;

			/**
			 * The queue's one dependency, built over the database facility.
			 *
			 * Promise-shaped because `queue.ts` is, and bridged with `Effect.runPromise` the same way
			 * `identity.ts` bridges Better Auth — the effect it runs needs no services, so there is no
			 * context to lose. A failure is rethrown as the `FacilityError` it already is rather than as a
			 * stringified copy, so the typed error survives the round trip and `mapError` below can hand
			 * it straight back.
			 *
			 * Each call takes its own effect id. The database facility meters per call and keys that meter
			 * on `(release, effectId)`, so a tick that used one id for all three round trips would have two
			 * of them billed to an observation that already exists.
			 */
			const executeUnder = (effectId: EffectIdType, label: string) => {
				let issued = 0;
				return async (statements: ReadonlyArray<Statement>) => {
					issued += 1;
					const outcome = await Effect.runPromise(
						database.execute(EffectId.make(`${effectId}:${label}:${issued}`), asRequest(statements)).pipe(
							Effect.match({
								onSuccess: (response) => ({ ok: true as const, response }),
								onFailure: (error) => ({ ok: false as const, error })
							})
						)
					);
					if (!outcome.ok) throw outcome.error;
					return outcome.response.rows as ReadonlyArray<Record<string, unknown>>;
				};
			};

			/** Recovers the typed failure `executeUnder` rethrew, so nothing downstream sees an `unknown`. */
			const asFacilityError = (cause: unknown): Database.FacilityError =>
				cause instanceof Database.FacilityError
					? cause
					: new Database.FacilityError({
							operation: 'tasks',
							code: 'task_queue_failed',
							message: cause instanceof Error ? cause.message : String(cause),
							retryable: true,
							outcome: 'unknown'
						});

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
					const soonest = enqueues.reduce(
						(earliest, enqueue) => Math.min(earliest, enqueue.runAtEpochMs ?? Date.now()),
						Number.POSITIVE_INFINITY
					);
					yield* wake(EffectId.make(`${effectId}:wake`), soonest);
					yield* database.execute(effectId, asRequest(enqueueStatements(enqueues)));
				}),
				declare: Effect.fn('TaskQueue.declare')(function* (effectId, declarations, nowEpochMs) {
					return yield* Effect.tryPromise({
						try: () => queueUnder(effectId, 'declare').declare(declarations, nowEpochMs),
						catch: asFacilityError
					});
				}),
				tick: (effectId, run) =>
					makeRunner(queueUnder(effectId, 'tick'), run, asFacilityError).tick({
						nowEpochMs: Date.now(),
						remainingMillis: remainingMillis(context.deadlineEpochMs)
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

export * as TaskQueue from './tasks.js';
