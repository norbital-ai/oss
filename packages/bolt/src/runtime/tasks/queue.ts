import { and, asc, eq, inArray, like, lte, min, notInArray, or } from 'drizzle-orm';
import { Effect, Result, Schema } from 'effect';
import type {
	HostScheduleOccurrence,
	HostScheduleOutcome
} from '@norbital-ai/bolt-protocol';
import { SYSTEM_MODEL_TABLES } from '#lib/authoring/system-models.js';
import {
	aliased,
	always,
	composer,
	dbNow,
	dbNowMinusDays,
	excluded,
	excludedWhenDistinct,
	increment,
	toStatement,
	type Statement
} from '#lib/runtime/persistence.js';
import * as Cron from '#lib/runtime/tasks/cron.js';

const { bolt_schedule: boltSchedule, bolt_task: boltTask } = SYSTEM_MODEL_TABLES;

export type { Statement } from '#lib/runtime/persistence.js';

type Row = Readonly<Record<string, unknown>>;
export type ExecuteStatements<E = never> = (
	statements: ReadonlyArray<Statement>
) => Effect.Effect<ReadonlyArray<Row>, E>;

export type Declaration = Readonly<{
	readonly key: string;
	readonly command: string;
	readonly crontab: string;
	readonly input: Schema.Json;
}>;

export type Rejection = Readonly<{
	readonly key: string;
	readonly crontab: string;
	readonly reason: string;
}>;

type FireReport = Readonly<{
	readonly occurrences: ReadonlyArray<HostScheduleOccurrence>;
	readonly rejections: ReadonlyArray<Rejection>;
	readonly rolled: number;
	readonly nextDueAtEpochMs: number | undefined;
}>;

const DueScheduleRow = Schema.Struct({
	key: Schema.String,
	command: Schema.String,
	crontab: Schema.String,
	input: Schema.Json,
	next_run_at: Schema.String
});
const FiredTaskRow = Schema.Struct({
	command: Schema.String,
	input: Schema.Json,
	effect_id: Schema.String
});
const NextDueRow = Schema.Struct({ next_due_at: Schema.NullOr(Schema.String) });
const decodeDueScheduleRow = Schema.decodeUnknownResult(DueScheduleRow);
const decodeFiredTaskRow = Schema.decodeUnknownResult(FiredTaskRow);

const decodeTaskRow = (
	row: unknown,
	metadata: ReadonlyMap<
		string,
		Readonly<{ readonly scheduleKey: string; readonly scheduledForEpochMs: number }>
	>
): HostScheduleOccurrence | undefined => {
	const decoded = decodeFiredTaskRow(row);
	if (Result.isFailure(decoded)) return undefined;
	const occurrence = metadata.get(decoded.success.effect_id);
	return occurrence === undefined
		? undefined
		: {
				taskId: decoded.success.effect_id,
				scheduleKey: occurrence.scheduleKey,
				scheduledForEpochMs: occurrence.scheduledForEpochMs,
				command: decoded.success.command,
				input: decoded.success.input
			};
};

const epochMsOf = (value: string): number | undefined => {
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
};
const storedInstant = (epochMs: number): string => new Date(epochMs).toISOString();
const storedJson = (value: Schema.Json): string => JSON.stringify(value);
const instantLabel = storedInstant;

/** Stable identity of one declared occurrence, derived from stored schedule state. */
export const slotEffectId = (key: string, slotEpochMs: number): string =>
	`schedule:${key}@${instantLabel(slotEpochMs)}`;

/** Reads one cron run's observable lifecycle. */
export const statusStatement = (taskId: string): Statement =>
	toStatement(
		composer
			.select({
				status: boltTask.status,
				error: boltTask.error,
				result: boltTask.result,
				progress: boltTask.progress,
				progressSequence: aliased(boltTask.progress_sequence, 'progressSequence'),
				progressUpdatedAt: aliased(boltTask.progress_updated_at, 'progressUpdatedAt'),
				observedAt: aliased(dbNow(), 'observedAt')
			})
			.from(boltTask)
			.where(eq(boltTask.effect_id, taskId))
			.toSQL()
	);

/** Progress is an observation of the currently running occurrence, never queue state. */
export const progressStatement = (taskId: string, value: Schema.Json): Statement =>
	toStatement(
		composer
			.update(boltTask)
			.set({
				progress: storedJson(value),
				progress_sequence: increment(boltTask.progress_sequence),
				progress_updated_at: dbNow()
			})
			.where(
				and(
					eq(boltTask.effect_id, taskId),
					eq(boltTask.status, 'running'),
					like(boltTask.command, 'automations.%')
				)
			)
			.toSQL()
	);

/** Stop is terminal. There is no durable resume or retry transition. */
export const stopStatement = (taskId: string, command: string): Statement =>
	toStatement(
		composer
			.update(boltTask)
			.set({ status: 'stopped', error: 'stopped', updated_at: dbNow() })
			.where(
				and(
					eq(boltTask.effect_id, taskId),
					eq(boltTask.command, command),
					eq(boltTask.status, 'running')
				)
			)
			.toSQL()
	);

/** A host restart terminates every in-flight cron occurrence, regardless of its command kind. */
export const recoverStatement = (): Statement =>
	toStatement(
		composer
			.update(boltTask)
			.set({
				status: 'failed',
				error: 'host restarted during run',
				result: null,
				updated_at: dbNow()
			})
			.where(eq(boltTask.status, 'running'))
			.toSQL()
	);

const RETENTION_DAYS = { done: 7, failed: 30 } as const;
const PRUNE_LIMIT = 200;

/**
 * The earliest instant any schedule is due, as one row.
 *
 * An aggregate with no GROUP BY answers exactly one row whether or not `bolt_schedule` holds any,
 * which is the whole reason `readWhen` can read the last row of a batch and expect a value there.
 * This used to select the aggregate as a scalar subquery over a `(values (1))` singleton, but
 * `aliased` takes `getSQL()` off the builder and that loses the parentheses a subquery needs — so
 * every batch ending in this statement rendered `select select min(...) ...` and failed, which
 * `TaskQueue` then reported as a non-row response rather than as the syntax error it was.
 */
const whenStatement = (): Statement =>
	toStatement(
		composer
			.select({ next_due_at: aliased(min(boltSchedule.next_run_at), 'next_due_at') })
			.from(boltSchedule)
			.toSQL()
	);

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
									lte(boltTask.updated_at, dbNowMinusDays(RETENTION_DAYS.done))
								),
								and(
									eq(boltTask.status, 'failed'),
									lte(boltTask.updated_at, dbNowMinusDays(RETENTION_DAYS.failed))
								),
								and(
									eq(boltTask.status, 'stopped'),
									lte(boltTask.updated_at, dbNowMinusDays(RETENTION_DAYS.failed))
								),
								and(
									eq(boltTask.status, 'skipped'),
									lte(boltTask.updated_at, dbNowMinusDays(RETENTION_DAYS.failed))
								)
							)
						)
						.limit(PRUNE_LIMIT)
				)
			)
			.toSQL()
	);

export const makeQueue = <E>(execute: ExecuteStatements<E>) => {
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
		Effect.suspend(() => {
			const rejections: Array<Rejection> = [];
			const accepted: Array<Declaration & { readonly nextRunAt: string }> = [];
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
				accepted.push({ ...declaration, nextRunAt: storedInstant(next.epochMs) });
			}
			const upserts = accepted.map((declaration) =>
				toStatement(
					composer
						.insert(boltSchedule)
						.values({
							key: declaration.key,
							command: declaration.command,
							crontab: declaration.crontab,
							input: storedJson(declaration.input),
							next_run_at: declaration.nextRunAt
						})
						.onConflictDoUpdate({
							target: boltSchedule.key,
							set: {
								command: excluded(boltSchedule.command),
								input: excluded(boltSchedule.input),
								crontab: excluded(boltSchedule.crontab),
								next_run_at: excludedWhenDistinct(
									boltSchedule.crontab,
									boltSchedule.next_run_at
								)
							}
						})
						.toSQL()
				)
			);
			const declaredKeys = accepted.map(({ key }) => key);
			const retire = toStatement(
				composer
					.delete(boltSchedule)
					.where(declaredKeys.length === 0 ? always() : notInArray(boltSchedule.key, declaredKeys))
					.toSQL()
			);
			return Effect.map(execute([...upserts, retire, whenStatement()]), (rows) => ({
				rejections,
				nextDueAtEpochMs: readWhen(rows)
			}));
		});

	/** Advances due schedules and records each occurrence before returning it to the runner. */
	const fire = (nowEpochMs: number): Effect.Effect<FireReport, E> =>
		Effect.gen(function* () {
			const due = yield* execute([
				toStatement(
					composer
						.select()
						.from(boltSchedule)
						.where(lte(boltSchedule.next_run_at, dbNow()))
						.orderBy(asc(boltSchedule.next_run_at))
						.toSQL()
				)
			]);
			const advances: Array<Statement> = [];
			const retired: Array<string> = [];
			const runs: Array<{
				readonly scheduleKey: string;
				readonly scheduledForEpochMs: number;
				readonly command: string;
				readonly input: string;
				readonly effect_id: string;
				readonly run_at: string;
				readonly status: string;
			}> = [];
			const rejections: Array<Rejection> = [];
			for (const row of due.flatMap((entry) => {
				const decoded = decodeDueScheduleRow(entry);
				return Result.isSuccess(decoded) ? [decoded.success] : [];
			})) {
				const slotEpochMs = epochMsOf(row.next_run_at);
				if (row.key === '' || slotEpochMs === undefined) continue;
				const next = Cron.nextRunAfter(row.crontab, Math.max(nowEpochMs, slotEpochMs));
				if (next._tag === 'Rejected' || next.epochMs <= slotEpochMs) {
					rejections.push({
						key: row.key,
						crontab: row.crontab,
						reason:
							next._tag === 'Rejected'
								? next.reason
								: `names no instant after ${instantLabel(slotEpochMs)}, which it already stands at`
					});
					retired.push(row.key);
					continue;
				}
				advances.push(
					toStatement(
						composer
							.update(boltSchedule)
							.set({ next_run_at: storedInstant(next.epochMs), last_fired_at: dbNow() })
							.where(eq(boltSchedule.key, row.key))
							.toSQL()
					)
				);
				runs.push({
					scheduleKey: row.key,
					scheduledForEpochMs: slotEpochMs,
					command: row.command,
					input: storedJson(row.input),
					effect_id: slotEffectId(row.key, slotEpochMs),
					run_at: storedInstant(slotEpochMs),
					status: 'running'
				});
			}
			const retirement =
				retired.length === 0
					? []
					: [
							toStatement(
								composer.delete(boltSchedule).where(inArray(boltSchedule.key, retired)).toSQL()
							)
						];
			if (runs.length === 0) {
				const rows = yield* execute([...advances, ...retirement, whenStatement()]);
				return {
					occurrences: [],
					rejections,
					rolled: 0,
					nextDueAtEpochMs: readWhen(rows)
				};
			}
			const metadata = new Map(
				runs.map((run) => [
					run.effect_id,
					{ scheduleKey: run.scheduleKey, scheduledForEpochMs: run.scheduledForEpochMs }
				])
			);
			const inserted = yield* execute([
				...advances,
				...retirement,
				toStatement(
					composer
						.insert(boltTask)
						.values(
							runs.map((run) => ({
								command: run.command,
								input: run.input,
								effect_id: run.effect_id,
								run_at: run.run_at,
								status: run.status
							}))
						)
						.onConflictDoNothing({ target: boltTask.effect_id })
						.returning({
							command: boltTask.command,
							input: boltTask.input,
							effect_id: boltTask.effect_id
						})
						.toSQL()
				),
				whenStatement()
			]);
			const occurrences = inserted.flatMap((row) => {
				const decoded = decodeTaskRow(row, metadata);
				return decoded === undefined ? [] : [decoded];
			});
			return {
				occurrences,
				rejections,
				rolled: occurrences.length,
				nextDueAtEpochMs: readWhen(inserted)
			};
		});

	const settle = (
		taskId: string,
		outcome: HostScheduleOutcome
	): Effect.Effect<number | undefined, E> =>
		execute([
			toStatement(
				composer
					.update(boltTask)
					.set(
						outcome._tag === 'Done'
							? {
									status: 'done',
									result: storedJson(outcome.result),
									error: null,
									updated_at: dbNow()
								}
							: outcome._tag === 'Skipped'
								? {
										status: 'skipped',
										result: null,
										error: outcome.reason,
										updated_at: dbNow()
									}
								: {
										status: 'failed',
										result: null,
										error: outcome.error,
										updated_at: dbNow()
									}
					)
					.where(and(eq(boltTask.effect_id, taskId), eq(boltTask.status, 'running')))
					.toSQL()
			),
			pruneStatement(),
			whenStatement()
		]).pipe(Effect.map(readWhen));

	const when = (): Effect.Effect<number | undefined, E> =>
		execute([whenStatement()]).pipe(Effect.map(readWhen));

	return { declare, fire, settle, when };
};
