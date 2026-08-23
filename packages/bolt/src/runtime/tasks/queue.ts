import { and, asc, eq, inArray, lte, notInArray, or, sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pg-proxy';
import { Effect, Result, Schema } from 'effect';
import { SYSTEM_MODEL_TABLES } from '#lib/authoring/system-models.js';
import * as Cron from '#lib/runtime/tasks/cron.js';

const { bolt_schedule: boltSchedule, bolt_task: boltTask } = SYSTEM_MODEL_TABLES;

/**
 * The four operations scheduled and background work is made of, over two tables.
 *
 * `roll` turns due schedules into task rows, `take` hands out due tasks and hides them while they
 * run, `finish` records what happened, and `when` says the next instant anything is due. Nothing
 * here knows what a command *does*, what a host is, or that Effect exists — the whole module is a
 * function of `execute`, which is why it can be driven to completion by a test with no database, no
 * isolate and no host.
 *
 * **Statements are composed by Drizzle and executed by the caller's facility.** That split is not
 * decoration. `DatabaseRequest` is `Query | Transaction { statements[] }` — a batch fixed *before*
 * it is sent — so there is no interactive transaction to hold a cursor open across a decision, and
 * anything that must be atomic has to arrive as one list. Drizzle composes; the facility commits.
 * The alternative, a hand-written SQL string per operation, is the arrangement `identity/auth-store.ts`
 * was moved off after a hand-rolled adapter got its parameter encoding wrong twice in one afternoon.
 *
 * Two disciplines the seam imposes, both of them silent when broken:
 *
 * 1. **A batch holds exactly one row-returning statement, and it is last.** `Transaction` answers
 *    with `results.flatMap((r) => r.rows)`, so two returning statements come back as one anonymous
 *    concatenation with nothing to tell them apart.
 * 2. **Time comes from the database, not from the guest.** Every due comparison and every future
 *    instant is `now()` or `now() + make_interval(...)` evaluated server-side. The one exception is
 *    cron arithmetic, which cannot be done in SQL and is done in the guest against the *stored*
 *    `next_run_at` rather than against a local clock — see `roll`.
 */

/** One statement, in the shape the database facility takes them. */
export type Statement = Readonly<{
	readonly sql: string;
	readonly parameters: ReadonlyArray<Schema.Json>;
}>;

/** A row as the executor answers it; operation-specific schemas decode it before any field is read. */
type Row = Readonly<Record<string, unknown>>;

/**
 * The one capability this module needs from its host, and the reason it takes a *list*.
 *
 * A single statement is a list of one. Everything above that is a unit of atomicity the caller asked
 * for, and it has to be declared up front because the facility cannot be asked to decide mid-flight.
 */
export type ExecuteStatements<E = never> = (
	statements: ReadonlyArray<Statement>
) => Effect.Effect<ReadonlyArray<Row>, E>;

/** A task as `take` hands it back — what the runner needs to run it and to decide its fate. */
export type TaskRow = Readonly<{
	readonly id: string;
	readonly command: string;
	readonly input: Schema.Json;
	readonly attempts: number;
	readonly maxAttempts: number;
	readonly effectId: string;
}>;

/** What a run came to, as `finish` is told it. */
export type Outcome =
	| Readonly<{ readonly _tag: 'Done'; readonly task: TaskRow; readonly result: Schema.Json }>
	| Readonly<{ readonly _tag: 'Failed'; readonly task: TaskRow; readonly error: string }>;

/** One thing a release says should happen on a cron. */
export type Declaration = Readonly<{
	readonly key: string;
	readonly command: string;
	readonly crontab: string;
	readonly input: Schema.Json;
}>;

/** A schedule that could not be read, named so the report says which one and why. */
export type Rejection = Readonly<{
	readonly key: string;
	readonly crontab: string;
	readonly reason: string;
}>;

/** One thing to run once, as a caller asks for it. */
export type Enqueue = Readonly<{
	readonly command: string;
	readonly input: Schema.Json;
	/**
	 * The idempotency key, and the only one. Two enqueues that share it are one enqueue — which is
	 * what makes an enqueue safe to write into a transaction that may be retried, and what gives cron
	 * exactly-once delivery across hosts with no leader election.
	 */
	readonly effectId: string;
	/** When it becomes due. Absent means now. */
	readonly runAtEpochMs?: number;
}>;

/** What one `roll` found, kept apart from what it will write so the write can ride another batch. */
type Roll = Readonly<{
	readonly statements: ReadonlyArray<Statement>;
	readonly rejections: ReadonlyArray<Rejection>;
	readonly rolled: number;
}>;

/**
 * How a failed attempt is spaced, and for how long the queue keeps trying.
 *
 * `min(10s · 2ⁿ⁻¹, 1h)` per wait. Twelve attempts is *eleven* waits — the count is attempts, not
 * waits, and it is easy to bill oneself one too many — summing to about 3.4 hours un-jittered and
 * 2.6 expected. The span is the number that was chosen; the attempt count follows from it.
 *
 * **Equal jitter, not full jitter.** Full jitter — uniform over `[0, capped]` — exists to break up a
 * thundering herd, and there is no herd here: tasks are per-tenant and already staggered by their own
 * schedules. What it would do instead is halve the span, because its expectation is `capped / 2`.
 * `capped/2 + rand(0, capped/2)` still separates two runs that failed together and keeps about
 * three-quarters of the interval that was asked for.
 *
 * `max_attempts` is a column defaulting to `MAX_ATTEMPTS` rather than a constant read here, so a
 * command that wants a different budget carries it on its own row.
 */
const RetrySchedule = {
	baseSeconds: 10,
	capSeconds: 3600,
	/** The delay after an attempt that just failed. `attempts` has already been incremented by `take`. */
	secondsAfter: (attempts: number, random: () => number): number => {
		const capped = Math.min(
			RetrySchedule.capSeconds,
			RetrySchedule.baseSeconds * 2 ** Math.max(0, attempts - 1)
		);
		return capped / 2 + random() * (capped / 2);
	}
};

/** The default a row carries when nobody says otherwise. Mirrored by `bolt:task` in the schema plan. */
const MAX_ATTEMPTS = 12;

/** `done` is pruned after this many days, `failed` after the second — the row is the audit trail. */
const RETENTION_DAYS = { done: 7, failed: 30 } as const;

/** At most this many rows are pruned per tick, so retention never becomes the tick's whole budget. */
const PRUNE_LIMIT = 200;

/**
 * Composes SQL; never executes it.
 *
 * Drizzle's proxy driver wants a transport callback, and this one refuses. Every statement leaves
 * through `.toSQL()` and is committed by the caller's facility in a batch the caller chose, so a
 * query that reached the database through *this* object would be one that escaped the batching
 * rules above — better a thrown error at the first test than a statement that silently commits
 * alone.
 */
const composer = drizzle(() =>
	Effect.runPromise(
		Effect.die(new Error('bolt tasks: statements are composed here and executed by the caller'))
	)
);

/** Renders a bare `sql` fragment, for the two statements no builder expresses. */
const dialect = new PgDialect();

const jsonParameter = (value: unknown): Schema.Json =>
	value instanceof Date ? value.toISOString() : Schema.decodeUnknownSync(Schema.Json)(value);

const toStatement = (query: { readonly sql: string; readonly params: ReadonlyArray<unknown> }) => ({
	sql: query.sql,
	parameters: query.params.map(jsonParameter)
});

const DatabaseNumber = Schema.Union([Schema.Number, Schema.NumberFromString]);
const DueScheduleRow = Schema.Struct({
	key: Schema.String,
	command: Schema.String,
	crontab: Schema.String,
	input: Schema.Json,
	next_run_at: Schema.String
});
const ClaimedTaskRow = Schema.Struct({
	id: Schema.String,
	command: Schema.String,
	input: Schema.Json,
	attempts: DatabaseNumber,
	max_attempts: DatabaseNumber,
	effect_id: Schema.String
});
const NextDueRow = Schema.Struct({ next_due_at: Schema.NullOr(Schema.String) });
const decodeDueScheduleRow = Schema.decodeUnknownResult(DueScheduleRow);
const decodeClaimedTaskRow = Schema.decodeUnknownResult(ClaimedTaskRow);

/** Reads a timestamp the facility answered with. Every value crossing that seam is JSON-safe. */
const epochMsOf = (value: string): number | undefined => {
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
};

/**
 * The `effect_id` a cron occurrence is inserted under.
 *
 * Derived from **stored** state — the schedule's key and the `next_run_at` the row already holds —
 * and never from a local clock. Two hosts rolling the same schedule either side of a minute boundary
 * would compute different labels from their own clocks and both inserts would land; reading the
 * stored slot means both compute the same string and the unique index picks one. It is also the
 * honest label: `@06:00` says *the six o'clock run, late*, not *the run that happened at 08:31*.
 */
export const slotEffectId = (key: string, slotEpochMs: number): string =>
	`schedule:${key}@${new Date(slotEpochMs).toISOString()}`;

/**
 * The inserts that put work on the queue — a pure function, and deliberately not a method.
 *
 * Most enqueues belong in somebody else's transaction: the task row that sends an integration
 * delivery rides the same batch as the record change that caused it, so the job cannot exist without
 * the write that asked for it and there is nothing to reconcile. A caller in that position has no
 * use for an `execute`, and requiring one would be asking it to hold a queue it will never run.
 */
export const enqueueStatements = (enqueues: ReadonlyArray<Enqueue>): ReadonlyArray<Statement> =>
	enqueues.map((enqueue) =>
		toStatement(
			composer
				.insert(boltTask)
				.values({
					command: enqueue.command,
					input: enqueue.input,
					effect_id: enqueue.effectId,
					...(enqueue.runAtEpochMs === undefined ? {} : { run_at: new Date(enqueue.runAtEpochMs) })
				})
				.onConflictDoNothing({ target: boltTask.effect_id })
				.toSQL()
		)
	);

/**
 * Embeds one canonical queue insert in a data-modifying CTE owned by another transaction.
 *
 * The source CTE makes the enqueue conditional on the caller's successful state transition. Keeping
 * the SQL here preserves one writer for `bolt_task`, while returning a fragment lets approval state,
 * its projection, and the follow-up task commit atomically in one statement.
 */
export const enqueueFromCte = (
	cteName: string,
	sourceCte: string,
	enqueue: Enqueue,
	parameterOffset: number
): Readonly<{ readonly sql: string; readonly parameters: ReadonlyArray<Schema.Json> }> => {
	if (!/^[a-z][a-z0-9_]*$/u.test(cteName) || !/^[a-z][a-z0-9_]*$/u.test(sourceCte))
		throw new TypeError('Task queue CTE names must be lowercase SQL identifiers.');
	return {
		sql: `, ${cteName} as (
			insert into bolt_task (command, input, effect_id)
			select $${parameterOffset}, $${parameterOffset + 1}::jsonb, $${parameterOffset + 2} from ${sourceCte}
			on conflict (effect_id) do nothing
			returning id
		)`,
		parameters: [enqueue.command, enqueue.input, enqueue.effectId]
	};
};

/** Owns the two tables, and nothing else in the runtime touches them. */
export const makeQueue = <E>(execute: ExecuteStatements<E>) => {
	/**
	 * Brings the schedule table into line with what this release declares, and says when next.
	 *
	 * Upsert the declared keys, delete the ones no longer declared. There is no `active` flag,
	 * because a flag lets "not declared" and "not active" disagree and then somebody has to decide
	 * which is true.
	 *
	 * `next_run_at` survives a redeploy *unless the crontab changed*. A deploy is not an event a
	 * schedule should observe: re-arming a nightly digest on every deploy is how a schedule quietly
	 * stops firing on a day with enough deploys in it. When the expression itself changed, the stored
	 * instant is an answer to a question nobody asked any more, and it is replaced.
	 */
	const declare = (
		declarations: ReadonlyArray<Declaration>,
		nowEpochMs: number
	): Effect.Effect<
		{
			readonly rejections: ReadonlyArray<Rejection>;
			readonly nextDueAtEpochMs: number | undefined;
		},
		E
	> =>
		Effect.gen(function* () {
			const rejections: Array<Rejection> = [];
			const accepted: Array<Declaration & { readonly nextRunAt: Date }> = [];
			for (const declaration of declarations) {
				const next = Cron.nextRunAfter(declaration.crontab, nowEpochMs);
				if (next._tag === 'Rejected') {
					rejections.push({
						key: declaration.key,
						crontab: declaration.crontab,
						reason: next.reason
					});
					continue;
				}
				accepted.push({ ...declaration, nextRunAt: new Date(next.epochMs) });
			}
			const upserts = accepted.map((declaration) =>
				toStatement(
					composer
						.insert(boltSchedule)
						.values({
							key: declaration.key,
							command: declaration.command,
							crontab: declaration.crontab,
							input: declaration.input,
							next_run_at: declaration.nextRunAt
						})
						.onConflictDoUpdate({
							target: boltSchedule.key,
							set: {
								command: sql`excluded.command`,
								input: sql`excluded.input`,
								crontab: sql`excluded.crontab`,
								next_run_at: sql`case when ${boltSchedule.crontab} is distinct from excluded.crontab then excluded.next_run_at else ${boltSchedule.next_run_at} end`
							}
						})
						.toSQL()
				)
			);
			// A key this release does not declare is a key that no longer exists. Deleting rather than
			// disabling is what keeps the table readable as "everything this workspace runs".
			const declaredKeys = accepted.map(({ key }) => key);
			const retire = toStatement(
				composer
					.delete(boltSchedule)
					.where(declaredKeys.length === 0 ? sql`true` : notInArray(boltSchedule.key, declaredKeys))
					.toSQL()
			);
			const rows = yield* execute([...upserts, retire, whenStatement()]);
			return { rejections, nextDueAtEpochMs: readWhen(rows) };
		});

	/**
	 * Due schedules become task rows — read now, written with whatever batch comes next.
	 *
	 * The write is handed back rather than committed because it belongs in the same transaction as
	 * `take`: a schedule that comes due this instant should be *run* this tick, and that is only true
	 * if the insert and the take see each other.
	 *
	 * **The advance rule, which is where catch-up lives.** The occurrence that just came due is
	 * enqueued once, keyed at the stored slot. Then `next_run_at` moves to the first occurrence
	 * strictly after `max(now, next_run_at)` — the `max` is the whole of the catch-up policy. Without
	 * it, a host that was down from 06:00 to 08:30 would advance an hourly schedule to 07:00, find
	 * that still due, and fire three times; with it, the missed slot fires exactly once and the
	 * schedule rejoins its own rhythm. A missed occurrence is late, not multiplied.
	 */
	const roll = (nowEpochMs: number): Effect.Effect<Roll, E> =>
		Effect.gen(function* () {
			const due = yield* execute([
				toStatement(
					composer
						.select()
						.from(boltSchedule)
						.where(lte(boltSchedule.next_run_at, sql`now()`))
						.orderBy(asc(boltSchedule.next_run_at))
						.toSQL()
				)
			]);
			const statements: Array<Statement> = [];
			const rejections: Array<Rejection> = [];
			const retired: Array<string> = [];
			let rolled = 0;
			for (const row of due.flatMap((entry) => {
				const decoded = decodeDueScheduleRow(entry);
				return Result.isSuccess(decoded) ? [decoded.success] : [];
			})) {
				const { key, command, crontab, input } = row;
				const slotEpochMs = epochMsOf(row.next_run_at);
				if (key === '' || slotEpochMs === undefined) continue;
				const next = Cron.nextRunAfter(crontab, Math.max(nowEpochMs, slotEpochMs));
				// Two ways to reach one state, and the state is the expensive one. A schedule that cannot
				// advance — because its expression will not parse, or because the instant it names is not
				// later than the one already stored — goes on satisfying `next_run_at <= now()`, so `when`
				// goes on answering "due now", so the host re-arms immediately and ticks forever against a
				// row that does nothing. That is the exact cost this design exists to avoid, reached from
				// the inside.
				//
				// Retiring costs nothing that is not recovered: activation re-declares every key this
				// release names and rejects a bad one *there*, where a person is watching a deploy. The
				// second condition guards against a future cron edge case rather than against anything
				// reachable today — the point of it is that such a case degrades to a retired schedule
				// rather than to a bill.
				if (next._tag === 'Rejected' || next.epochMs <= slotEpochMs) {
					rejections.push({
						key,
						crontab,
						reason:
							next._tag === 'Rejected'
								? next.reason
								: `names no instant after ${new Date(slotEpochMs).toISOString()}, which it already stands at`
					});
					retired.push(key);
					continue;
				}
				rolled += 1;
				statements.push(
					...enqueueStatements([
						{
							command,
							input,
							effectId: slotEffectId(key, slotEpochMs),
							runAtEpochMs: slotEpochMs
						}
					]),
					toStatement(
						composer
							.update(boltSchedule)
							.set({ next_run_at: new Date(next.epochMs), last_fired_at: sql`now()` })
							.where(eq(boltSchedule.key, key))
							.toSQL()
					)
				);
			}
			if (retired.length > 0) {
				statements.push(
					toStatement(
						composer.delete(boltSchedule).where(inArray(boltSchedule.key, retired)).toSQL()
					)
				);
			}
			return { statements, rejections, rolled };
		});

	/**
	 * Hands out due tasks, hiding them while they run — one statement, and it has to be one.
	 *
	 * A `select … for update skip locked` sent as its own facility call commits and drops its locks
	 * before the follow-up update has even been composed, so the select lives inside the update as a
	 * subquery and the two are indivisible by construction.
	 *
	 * Three things happen at once, and each is here for a reason:
	 *
	 * - **It hides.** `run_at` moves into the future by the invocation's own remaining time, so no
	 *   other tick sees the row while this one works, and no run can outlive the hide that covers it.
	 * - **It counts.** `attempts` is incremented at take-time rather than at failure-time, so a run
	 *   that dies without reporting anything still spends an attempt. A crash loop is bounded.
	 * - **It recovers.** If this tick dies now, nothing further is written and the row simply becomes
	 *   due again when the hide expires. No reaper, no operator, no second mechanism.
	 *
	 * `before` is committed in the same transaction — in practice `roll`'s inserts, so a schedule that
	 * came due this instant is taken by this same call.
	 *
	 * One thing the shape does *not* promise: `order by run_at` decides which rows are claimed, not
	 * the order they come back in. `returning` reports rows in the order the update touched them,
	 * which for a batch above one is the scan's order and not the queue's. The runner asks for one at
	 * a time, so the oldest due row is the one it gets; a caller that batches must not read the
	 * returned order as priority.
	 */
	const take = (
		before: ReadonlyArray<Statement>,
		options: Readonly<{ readonly hideForMillis: number; readonly batchSize: number }>
	): Effect.Effect<ReadonlyArray<TaskRow>, E> =>
		Effect.gen(function* () {
			if (options.batchSize <= 0) {
				// Nothing may be handed out, but `roll`'s writes still have to land: a schedule that has
				// advanced in memory and not on disk fires twice.
				if (before.length > 0) yield* execute(before);
				return [];
			}
			const claimed = composer
				.select({ id: boltTask.id })
				.from(boltTask)
				.where(and(eq(boltTask.status, 'pending'), lte(boltTask.run_at, sql`now()`)))
				.orderBy(asc(boltTask.run_at))
				.limit(options.batchSize)
				.for('update', { skipLocked: true });
			const rows = yield* execute([
				...before,
				toStatement(
					composer
						.update(boltTask)
						.set({
							attempts: sql`${boltTask.attempts} + 1`,
							run_at: sql`now() + make_interval(secs => ${options.hideForMillis / 1000})`,
							updated_at: sql`now()`
						})
						.where(inArray(boltTask.id, claimed))
						.returning({
							id: boltTask.id,
							command: boltTask.command,
							input: boltTask.input,
							attempts: boltTask.attempts,
							maxAttempts: boltTask.max_attempts,
							effectId: boltTask.effect_id
						})
						.toSQL()
				)
			]);
			return rows
				.flatMap((entry) => {
					const decoded = decodeClaimedTaskRow(entry);
					return Result.isSuccess(decoded) ? [decoded.success] : [];
				})
				.map((row) => ({
					id: row.id,
					command: row.command,
					input: row.input,
					attempts: row.attempts,
					maxAttempts: row.max_attempts,
					effectId: row.effect_id
				}));
		});

	/**
	 * Records what happened, prunes what nobody will read again, and reports when to come back.
	 *
	 * Retry is a timestamp on the row, never a sleep inside an invocation: a delivery backing off for
	 * an hour holds no isolate, no connection and no row lock. That is also why there is no
	 * dead-letter table — the row *is* the audit trail, and re-driving one is
	 * `update bolt_task set status = 'pending', attempts = 0`.
	 *
	 * Pruning rides here rather than on a schedule of its own. A maintenance cron would wake every
	 * tenant daily whether or not it had any work, which is the one thing this design exists to avoid;
	 * folded into a tick that was already happening it costs nothing.
	 *
	 * `when` rides the same batch for the same reason: the connection is open and the transaction is
	 * happening anyway, so the number the host arms its timer to is free.
	 */
	const finish = (
		outcomes: ReadonlyArray<Outcome>,
		random: () => number = Math.random
	): Effect.Effect<number | undefined, E> =>
		Effect.gen(function* () {
			const statements = outcomes.map((outcome) => {
				if (outcome._tag === 'Done') {
					return toStatement(
						composer
							.update(boltTask)
							.set({ status: 'done', result: outcome.result, error: null, updated_at: sql`now()` })
							.where(eq(boltTask.id, outcome.task.id))
							.toSQL()
					);
				}
				const exhausted = outcome.task.attempts >= outcome.task.maxAttempts;
				return toStatement(
					composer
						.update(boltTask)
						.set({
							error: outcome.error,
							updated_at: sql`now()`,
							...(exhausted
								? { status: 'failed' as const }
								: {
										run_at: sql`now() + make_interval(secs => ${RetrySchedule.secondsAfter(outcome.task.attempts, random)})`
									})
						})
						.where(eq(boltTask.id, outcome.task.id))
						.toSQL()
				);
			});
			const rows = yield* execute([...statements, pruneStatement(), whenStatement()]);
			return readWhen(rows);
		});

	const when = (): Effect.Effect<number | undefined, E> =>
		execute([whenStatement()]).pipe(Effect.map(readWhen));

	return { declare, enqueueStatements, roll, take, finish, when };
};

/** What every tick ends by asking, and the only thing the host is ever told. */
const whenStatement = (): Statement =>
	toStatement(
		dialect.sqlToQuery(
			// `least` ignores nulls, so an empty queue with a schedule, a schedule-free queue with work,
			// and a workspace with neither all answer correctly without three cases.
			sql`select least((select min(${boltTask.run_at}) from ${boltTask} where ${boltTask.status} = 'pending'), (select min(${boltSchedule.next_run_at}) from ${boltSchedule})) as next_due_at`
		)
	);

/** The last row of a tick's final batch, which is the only row that batch returns. */
const readWhen = (rows: ReadonlyArray<Row>): number | undefined => {
	const last = rows[rows.length - 1];
	if (last === undefined) return undefined;
	const decoded = Schema.decodeUnknownResult(NextDueRow)(last);
	return Result.isFailure(decoded) || decoded.success.next_due_at === null
		? undefined
		: epochMsOf(decoded.success.next_due_at);
};

const pruneStatement = (): Statement =>
	toStatement(
		composer
			.delete(boltTask)
			.where(
				inArray(
					boltTask.id,
					composer
						.select({ id: boltTask.id })
						.from(boltTask)
						.where(
							or(
								and(
									eq(boltTask.status, 'done'),
									lte(
										boltTask.updated_at,
										sql`now() - make_interval(days => ${RETENTION_DAYS.done})`
									)
								),
								and(
									eq(boltTask.status, 'failed'),
									lte(
										boltTask.updated_at,
										sql`now() - make_interval(days => ${RETENTION_DAYS.failed})`
									)
								)
							)
						)
						.limit(PRUNE_LIMIT)
				)
			)
			.toSQL()
	);
