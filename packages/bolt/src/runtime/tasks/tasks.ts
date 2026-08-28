import { Cause, Clock, Context, Effect, Exit, Layer, Schema } from 'effect';
import {
	EffectId,
	type DatabaseRequest,
	type EffectId as EffectIdType
} from '@norbital-ai/bolt-protocol';
import * as Database from '#lib/runtime/facilities/database.js';
import type { CallContext } from '#lib/runtime/facilities/database.js';
import { Tasks } from '#lib/runtime/facilities/services.js';
import * as SyncWake from '#lib/runtime/sync/wake.js';
import {
	cancelStatement,
	decodeTaskRow,
	dequeueStatement,
	directClaimStatement,
	directSettleStatement,
	enqueueStatements,
	interruptLaneStatement,
	makeQueue,
	progressStatement,
	reorderStatements,
	resumeLaneStatements,
	resumeStatement,
	stopLaneStatements,
	statusStatement,
	stopStatement,
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
	/** Registers one direct I/O invocation for best-effort interruption; it schedules nothing. */
	readonly active: (effectId: EffectIdType, taskId: string) => Effect.Effect<void>;
	/** Releases the host's in-memory interruption handle for a direct invocation. */
	readonly settled: (effectId: EffectIdType, taskId: string) => Effect.Effect<void>;
	/** Interrupts a currently active direct invocation, if this host still owns it. */
	readonly interruptActive: (effectId: EffectIdType, taskId: string) => Effect.Effect<void>;
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
	/** Releases the guest isolate to its host without performing I/O or scheduling work. */
	/** Enqueues in a transaction of its own — for callers with no write of their own to ride. */
	readonly enqueue: (
		effectId: EffectIdType,
		enqueues: ReadonlyArray<Enqueue>
	) => Effect.Effect<void, Database.FacilityError>;
	/** Persists an immediate run without arming or waking the durable scheduler. */
	readonly admit: (
		effectId: EffectIdType,
		enqueues: ReadonlyArray<Enqueue>
	) => Effect.Effect<void, Database.FacilityError>;
	/**
	 * Executes one explicitly named immediate run in this invocation.
	 *
	 * Database/model/tool waits remain ordinary I/O waits; only the authored handler's individual
	 * facility spans consume their own CPU allowance. No scheduler owns or re-enters the body.
	 */
	readonly runDirect: <E, R>(
		effectId: EffectIdType,
		taskId: string,
		command: string,
		run: (
			task: import('#lib/runtime/tasks/queue.js').TaskRow,
			attemptEffectId: string
		) => Effect.Effect<Schema.Json, E, R>
	) => Effect.Effect<Schema.Json | undefined, E | Database.FacilityError, R>;
	/**
	 * Claims, executes and settles an explicitly named set of immediate runs in three batched
	 * database calls: claim, authored I/O, settle. Each returned exit still belongs to its own task;
	 * one failed body cannot prevent its siblings from reaching a terminal row.
	 */
	readonly runDirectMany: <E, R>(
		effectId: EffectIdType,
		runs: ReadonlyArray<Readonly<{ readonly taskId: string; readonly command: string }>>,
		run: (
			task: import('#lib/runtime/tasks/queue.js').TaskRow,
			attemptEffectId: string
		) => Effect.Effect<Schema.Json, E, R>
	) => Effect.Effect<
		ReadonlyArray<
			Readonly<{
				readonly task: import('#lib/runtime/tasks/queue.js').TaskRow;
				readonly exit: Exit.Exit<Schema.Json, E>;
			}>
		>,
		Database.FacilityError,
		R
	>;
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
	/** Internal lifecycle observation used only to stop an in-flight automation at facility fences. */
	readonly status: (
		effectId: EffectIdType,
		taskId: string
	) => Effect.Effect<Schema.Json | undefined, Database.FacilityError>;
	/** Replaces one automation task's durable progress snapshot. */
	readonly progress: (
		effectId: EffectIdType,
		taskId: string,
		value: Schema.Json
	) => Effect.Effect<void, Database.FacilityError>;
	/** Permanently cancels a non-automation task, scoped to its exact command. */
	readonly cancel: (
		effectId: EffectIdType,
		taskId: string,
		command: string
	) => Effect.Effect<void, Database.FacilityError>;
	/**
	 * Stops one durable automation run without making it terminal.
	 *
	 * A running guest observes the state at its next authored facility boundary. The row, its input,
	 * progress and idempotency key remain outside the guest so the same run can be resumed later.
	 */
	readonly stop: (
		effectId: EffectIdType,
		taskId: string,
		command: string
	) => Effect.Effect<void, Database.FacilityError>;
	/** Resumes the same stopped row; no replacement task or copied input is created. */
	readonly resume: (
		effectId: EffectIdType,
		taskId: string,
		command: string
	) => Effect.Effect<void, Database.FacilityError>;
	/** Moves a stopped immediate run back to `resuming` without emitting a scheduler wake. */
	readonly resumeDirect: (
		effectId: EffectIdType,
		taskId: string,
		command: string
	) => Effect.Effect<void, Database.FacilityError>;
	/** Removes one not-yet-running message from a serial agent lane. */
	readonly dequeue: (
		effectId: EffectIdType,
		taskId: string,
		lane: string,
		command: string
	) => Effect.Effect<boolean, Database.FacilityError>;
	/** Reorders the queued task ids in one lane. */
	readonly reorder: (
		effectId: EffectIdType,
		lane: string,
		command: string,
		orderedTaskIds: ReadonlyArray<string>
	) => Effect.Effect<void, Database.FacilityError>;
	/** Pauses queued and running work in one lane, preserving the same rows for resume. */
	readonly stopLane: (
		effectId: EffectIdType,
		lane: string,
		command: string
	) => Effect.Effect<ReadonlyArray<string>, Database.FacilityError>;
	/** Resumes the exact paused rows in one lane. */
	readonly resumeLane: (
		effectId: EffectIdType,
		lane: string,
		command: string
	) => Effect.Effect<void, Database.FacilityError>;
	/** Terminates only the currently running row in a lane. */
	readonly interruptLane: (
		effectId: EffectIdType,
		lane: string,
		command: string
	) => Effect.Effect<ReadonlyArray<string>, Database.FacilityError>;
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
/** Built once: every facility response this module reads goes through it. */
const decodeDatabaseRows = Schema.decodeUnknownEffect(DatabaseRows);
const TaskIdRows = Schema.Array(Schema.Struct({ taskId: Schema.NonEmptyString }));
const decodeTaskIdRows = (rows: unknown): ReadonlyArray<{ readonly taskId: string }> => {
	const decoded = Schema.decodeUnknownOption(TaskIdRows)(rows);
	return decoded._tag === 'Some' ? decoded.value : [];
};

export const layer = (context: CallContext) =>
	Layer.effect(
		Service,
		Effect.gen(function* () {
			const database = yield* Database.Service;
			const tasks = yield* Tasks.Service;
			const syncWake = yield* SyncWake.Service;

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
								decodeDatabaseRows(response.rows).pipe(
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
			 * Announces an already-durable instant to the host scheduler.
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
				active: (effectId, taskId) =>
					Effect.ignore(tasks.execute(effectId, { _tag: 'Active', taskId })),
				settled: (effectId, taskId) =>
					Effect.ignore(tasks.execute(effectId, { _tag: 'Settled', taskId })),
				interruptActive: (effectId, taskId) =>
					Effect.ignore(tasks.execute(effectId, { _tag: 'Interrupt', taskId })),
				statements: enqueueStatements,
				wake,
				enqueue: Effect.fn('TaskQueue.enqueue')(function* (effectId, enqueues) {
					if (enqueues.length === 0) return;
					const nowEpochMs = yield* Clock.currentTimeMillis;
					const soonest = enqueues.reduce(
						(earliest, enqueue) => Math.min(earliest, enqueue.runAtEpochMs ?? nowEpochMs),
						Number.POSITIVE_INFINITY
					);
					yield* database.execute(effectId, asRequest(enqueueStatements(enqueues)));
					yield* wake(EffectId.make(`${effectId}:wake`), soonest);
					yield* syncWake.announce(
						EffectId.make(`${effectId}:sync`),
						enqueues.some(({ lane }) => lane !== undefined)
							? ['automation_run', 'agent_mailbox', 'agent_run']
							: ['automation_run']
					);
				}),
				admit: Effect.fn('TaskQueue.admit')(function* (effectId, enqueues) {
					if (enqueues.length === 0) return;
					yield* database.execute(effectId, asRequest(enqueueStatements(enqueues)));
					yield* syncWake.announce(EffectId.make(`${effectId}:sync`), ['automation_run']);
				}),
				runDirect: (effectId, taskId, command, run) =>
					Effect.gen(function* () {
						const claimed = yield* database.execute(
							EffectId.make(`${effectId}:claim`),
							asRequest([directClaimStatement(taskId, command)])
						);
						const task = decodeTaskRow(claimed.rows[0]);
						if (task === undefined) return undefined;
						yield* syncWake.announce(EffectId.make(`${effectId}:claim:sync`), ['automation_run']);
						const attemptEffectId = `${task.effectId}:${task.attempts}`;
						const controlled = Effect.acquireUseRelease(
							Effect.ignore(
								tasks.execute(EffectId.make(`${attemptEffectId}:active`), {
									_tag: 'Active',
									taskId: task.effectId
								})
							),
							() => run(task, attemptEffectId),
							() =>
								Effect.ignore(
									tasks.execute(EffectId.make(`${attemptEffectId}:settled`), {
										_tag: 'Settled',
										taskId: task.effectId
									})
								)
						);
						return yield* Effect.matchCauseEffect(controlled, {
							onFailure: (cause) =>
								Effect.gen(function* () {
									yield* database.execute(
										EffectId.make(`${effectId}:failed`),
										asRequest([
											directSettleStatement(task, {
												_tag: 'Failed',
												error: Cause.pretty(cause)
											})
										])
									);
									yield* syncWake.announce(EffectId.make(`${effectId}:failed:sync`), [
										'automation_run'
									]);
									return yield* Effect.failCause(cause);
								}),
							onSuccess: (result) =>
								Effect.gen(function* () {
									yield* database.execute(
										EffectId.make(`${effectId}:done`),
										asRequest([directSettleStatement(task, { _tag: 'Done', result })])
									);
									yield* syncWake.announce(EffectId.make(`${effectId}:done:sync`), [
										'automation_run'
									]);
									return result;
								})
						});
					}),
				runDirectMany: (effectId, runs, run) =>
					Effect.gen(function* () {
						if (runs.length === 0) return [];
						const claimed = yield* database.execute(
							EffectId.make(`${effectId}:claim`),
							asRequest(runs.map(({ taskId, command }) => directClaimStatement(taskId, command)))
						);
						// Multiple returning statements are safe here because every row carries both its database id
						// and effect id. The facility flattens the transaction response, but no positional identity is
						// needed to associate a result with its task.
						const claimedTasks = claimed.rows.flatMap((row) => {
							const task = decodeTaskRow(row);
							return task === undefined ? [] : [task];
						});
						if (claimedTasks.length === 0) return [];
						yield* syncWake.announce(EffectId.make(`${effectId}:claim:sync`), ['automation_run']);
						const outcomes = yield* Effect.forEach(
							claimedTasks,
							(task) => {
								const attemptEffectId = `${task.effectId}:${task.attempts}`;
								return Effect.acquireUseRelease(
									Effect.ignore(
										tasks.execute(EffectId.make(`${attemptEffectId}:active`), {
											_tag: 'Active',
											taskId: task.effectId
										})
									),
									() => Effect.exit(run(task, attemptEffectId)),
									() =>
										Effect.ignore(
											tasks.execute(EffectId.make(`${attemptEffectId}:settled`), {
												_tag: 'Settled',
												taskId: task.effectId
											})
										)
								).pipe(Effect.map((exit) => ({ task, exit })));
							},
							{ concurrency: 'unbounded' }
						);
						yield* database.execute(
							EffectId.make(`${effectId}:settle`),
							asRequest(
								outcomes.map(({ task, exit }) =>
									Exit.isSuccess(exit)
										? directSettleStatement(task, { _tag: 'Done', result: exit.value })
										: directSettleStatement(task, {
												_tag: 'Failed',
												error: Cause.pretty(exit.cause)
											})
								)
							)
						);
						yield* syncWake.announce(EffectId.make(`${effectId}:settle:sync`), ['automation_run']);
						return outcomes;
					}),
				declare: Effect.fn('TaskQueue.declare')((effectId, declarations, nowEpochMs) =>
					queueUnder(effectId, 'declare').declare(declarations, nowEpochMs)
				),
				tick: (effectId, run) =>
					Effect.gen(function* () {
						const nowEpochMs = yield* Clock.currentTimeMillis;
						const controlledRun: typeof run = (task, attemptEffectId) =>
							Effect.acquireUseRelease(
								Effect.ignore(
									tasks.execute(EffectId.make(`${attemptEffectId}:active`), {
										_tag: 'Active',
										taskId: task.effectId
									})
								),
								() => run(task, attemptEffectId),
								() =>
									Effect.ignore(
										tasks.execute(EffectId.make(`${attemptEffectId}:settled`), {
											_tag: 'Settled',
											taskId: task.effectId
										})
									)
							);
						const report = yield* makeRunner(queueUnder(effectId, 'tick'), controlledRun).tick({
							nowEpochMs,
							// Floored at one millisecond, exactly as `runtime/app.ts` floors the timeout it
							// enforces against the same deadline. A late tick must not burn an attempt on work
							// it had no time to try.
							remainingMillis: Math.max(1, context.deadlineEpochMs - nowEpochMs)
						});
						// `finish` also prunes old task rows. Announce every real tick rather than trying to
						// predict whether its private queue writes changed an automation projection.
						yield* syncWake.announce(EffectId.make(`${effectId}:sync`), [
							'automation_run',
							'agent_run'
						]);
						return report;
					}),
				status: Effect.fn('TaskQueue.status')(function* (effectId, taskId) {
					const rows = yield* database.execute(effectId, asRequest([statusStatement(taskId)]));
					return rows.rows[0];
				}),
				progress: Effect.fn('TaskQueue.progress')(function* (effectId, taskId, value) {
					yield* database.execute(effectId, asRequest([progressStatement(taskId, value)]));
					yield* syncWake.announce(EffectId.make(`${effectId}:sync`), ['automation_run']);
				}),
				cancel: Effect.fn('TaskQueue.cancel')(function* (effectId, taskId, command) {
					yield* database.execute(effectId, asRequest([cancelStatement(taskId, command)]));
				}),
				stop: Effect.fn('TaskQueue.stop')(function* (effectId, taskId, command) {
					// A claim is `running` while its worker runs. Moving it to `paused` therefore
					// fences both queued and in-flight work in one atomic write. Every finish statement is
					// conditional on `running`, so a late success or failure cannot erase the stop.
					yield* database.execute(effectId, asRequest([stopStatement(taskId, command)]));
					yield* syncWake.announce(EffectId.make(`${effectId}:sync`), ['automation_run']);
				}),
				resume: Effect.fn('TaskQueue.resume')(function* (effectId, taskId, command) {
					// Announce before writing, exactly like enqueue: a crash may cause an empty tick, but
					// can never leave durable work with nobody scheduled to look for it. `resuming` is a
					// lease fence. If an old guest still owns the row, its claim-time run_at is preserved;
					// otherwise the same row is immediately due. Only `take` turns the fence into running.
					const nowEpochMs = yield* Clock.currentTimeMillis;
					yield* wake(EffectId.make(`${effectId}:wake`), nowEpochMs);
					yield* database.execute(effectId, asRequest([resumeStatement(taskId, command)]));
					yield* syncWake.announce(EffectId.make(`${effectId}:sync`), ['automation_run']);
				}),
				resumeDirect: Effect.fn('TaskQueue.resumeDirect')(function* (effectId, taskId, command) {
					yield* database.execute(effectId, asRequest([resumeStatement(taskId, command)]));
					yield* syncWake.announce(EffectId.make(`${effectId}:sync`), ['automation_run']);
				}),
				dequeue: Effect.fn('TaskQueue.dequeue')(function* (effectId, taskId, lane, command) {
					const response = yield* database.execute(
						effectId,
						asRequest([dequeueStatement(taskId, lane, command)])
					);
					yield* syncWake.announce(EffectId.make(`${effectId}:sync`), ['agent_run']);
					return decodeTaskIdRows(response.rows).length === 1;
				}),
				reorder: Effect.fn('TaskQueue.reorder')(
					function* (effectId, lane, command, orderedTaskIds) {
						if (orderedTaskIds.length === 0) return;
						yield* database.execute(
							effectId,
							asRequest(reorderStatements(lane, command, orderedTaskIds))
						);
						yield* syncWake.announce(EffectId.make(`${effectId}:sync`), ['agent_run']);
					}
				),
				stopLane: Effect.fn('TaskQueue.stopLane')(function* (effectId, lane, command) {
					const response = yield* database.execute(
						effectId,
						asRequest(stopLaneStatements(lane, command))
					);
					const rows = decodeTaskIdRows(response.rows);
					for (const { taskId } of rows) {
						yield* Effect.ignore(
							tasks.execute(EffectId.make(`${effectId}:interrupt:${taskId}`), {
								_tag: 'Interrupt',
								taskId
							})
						);
					}
					yield* syncWake.announce(EffectId.make(`${effectId}:sync`), [
						'agent_mailbox',
						'agent_run'
					]);
					return rows.map(({ taskId }) => taskId);
				}),
				resumeLane: Effect.fn('TaskQueue.resumeLane')(function* (effectId, lane, command) {
					const nowEpochMs = yield* Clock.currentTimeMillis;
					yield* wake(EffectId.make(`${effectId}:wake`), nowEpochMs);
					yield* database.execute(effectId, asRequest(resumeLaneStatements(lane, command)));
					yield* syncWake.announce(EffectId.make(`${effectId}:sync`), [
						'agent_mailbox',
						'agent_run'
					]);
				}),
				interruptLane: Effect.fn('TaskQueue.interruptLane')(function* (effectId, lane, command) {
					const response = yield* database.execute(
						effectId,
						asRequest([interruptLaneStatement(lane, command)])
					);
					const rows = decodeTaskIdRows(response.rows);
					for (const { taskId } of rows) {
						yield* Effect.ignore(
							tasks.execute(EffectId.make(`${effectId}:interrupt:${taskId}`), {
								_tag: 'Interrupt',
								taskId
							})
						);
					}
					yield* syncWake.announce(EffectId.make(`${effectId}:sync`), ['agent_run']);
					return rows.map(({ taskId }) => taskId);
				})
			});
		})
	);
