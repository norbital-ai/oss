import { and, asc, eq, gte, inArray, like, lt, lte, min, notInArray, or } from 'drizzle-orm';
import { Effect, Result, Schema } from 'effect';
import type { HostScheduleOccurrence, HostScheduleOutcome } from '@norbital-ai/bolt-protocol';
import { SYSTEM_MODEL_TABLES } from '#lib/authoring/system-models.js';
import {
	aliased,
	always,
	composer,
	dbNow,
	dbNowMinusDays,
	dbNowPlusSeconds,
	excluded,
	excludedWhenDistinct,
	increment,
	least,
	singleton,
	toStatement,
	type Statement
} from '#lib/runtime/persistence.js';
import * as Cron from '#lib/runtime/tasks/cron.js';

const { bolt_schedule: boltSchedule, bolt_task: boltTask } = SYSTEM_MODEL_TABLES;

export type { Statement } from '#lib/runtime/persistence.js';

type Row = { readonly [field: string]: unknown };
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

const RETRY = {
	baseSeconds: 10,
	capSeconds: 3_600,
	secondsAfter: (attempt: number, random: () => number): number => {
		const capped = Math.min(RETRY.capSeconds, RETRY.baseSeconds * 2 ** Math.max(0, attempt - 1));
		return capped / 2 + random() * (capped / 2);
	}
} as const;
const RETENTION_DAYS = { done: 7, failed: 30 } as const;
const PRUNE_LIMIT = 200;

const DatabaseNumber = Schema.Union([Schema.Number, Schema.NumberFromString]);
const DueScheduleRow = Schema.Struct({
	key: Schema.String,
	command: Schema.String,
	crontab: Schema.String,
	input: Schema.Json,
	next_run_at: Schema.String
});
const ClaimedTaskRow = Schema.Struct({
	command: Schema.String,
	input: Schema.Json,
	effect_id: Schema.String,
	run_at: Schema.String,
	attempts: DatabaseNumber
});
const NextDueRow = Schema.Struct({ next_due_at: Schema.NullOr(Schema.String) });
const decodeDueScheduleRow = Schema.decodeUnknownResult(DueScheduleRow);
const decodeClaimedTaskRow = Schema.decodeUnknownResult(ClaimedTaskRow);

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

const occurrenceMetadata = (
	effectId: string,
	runAt: string
): Readonly<{ readonly scheduleKey: string; readonly scheduledForEpochMs: number }> | undefined => {
	const directEpochMs = epochMsOf(runAt);
	if (!effectId.startsWith('schedule:'))
		return directEpochMs === undefined
			? undefined
			: { scheduleKey: `task:${effectId}`, scheduledForEpochMs: directEpochMs };
	const separator = effectId.lastIndexOf('@');
	const scheduleKey = effectId.slice('schedule:'.length, separator);
	const scheduledForEpochMs = epochMsOf(effectId.slice(separator + 1));
	return separator <= 'schedule:'.length || scheduleKey === '' || scheduledForEpochMs === undefined
		? undefined
		: { scheduleKey, scheduledForEpochMs };
};

const decodeTaskRow = (row: unknown): HostScheduleOccurrence | undefined => {
	const decoded = decodeClaimedTaskRow(row);
	if (Result.isFailure(decoded)) return undefined;
	const metadata = occurrenceMetadata(decoded.success.effect_id, decoded.success.run_at);
	return metadata === undefined
		? undefined
		: {
				taskId: decoded.success.effect_id,
				scheduleKey: metadata.scheduleKey,
				scheduledForEpochMs: metadata.scheduledForEpochMs,
				command: decoded.success.command,
				input: decoded.success.input,
				attempt: decoded.success.attempts
			};
};

/** Reads one task's observable lifecycle. */
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

/** Progress belongs only to the exact running automation attempt. */
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

/** Stop fences pending or active work terminally; a late settle cannot rewrite it. */
export const stopStatement = (taskId: string, command: string): Statement =>
	toStatement(
		composer
			.update(boltTask)
			.set({
				status: 'stopped',
				error: 'stopped',
				lease_expires_at: null,
				updated_at: dbNow()
			})
			.where(
				and(
					eq(boltTask.effect_id, taskId),
					eq(boltTask.command, command),
					inArray(boltTask.status, ['pending', 'running'])
				)
			)
			.toSQL()
	);

/** Host recovery only releases expired claims; a live lease still fences another host. */
export const recoverStatements = (): ReadonlyArray<Statement> => [
	toStatement(
		composer
			.update(boltTask)
			.set({
				status: 'failed',
				error: 'attempt budget exhausted after interrupted run',
				lease_expires_at: null,
				result: null,
				updated_at: dbNow()
			})
			.where(
				and(
					eq(boltTask.status, 'running'),
					lte(boltTask.lease_expires_at, dbNow()),
					gte(boltTask.attempts, boltTask.max_attempts)
				)
			)
			.toSQL()
	),
	toStatement(
		composer
			.update(boltTask)
			.set({
				status: 'pending',
				error: 'host interrupted previous attempt',
				lease_expires_at: null,
				updated_at: dbNow()
			})
			.where(
				and(
					eq(boltTask.status, 'running'),
					lte(boltTask.lease_expires_at, dbNow()),
					lt(boltTask.attempts, boltTask.max_attempts)
				)
			)
			.toSQL()
	)
];

const pendingDue = () => and(eq(boltTask.status, 'pending'), lte(boltTask.run_at, dbNow()));
const expiredClaim = () =>
	and(eq(boltTask.status, 'running'), lte(boltTask.lease_expires_at, dbNow()));
const dueWork = () => or(pendingDue(), expiredClaim());

const failExhaustedDueStatement = (): Statement =>
	toStatement(
		composer
			.update(boltTask)
			.set({
				status: 'failed',
				error: 'attempt budget exhausted',
				lease_expires_at: null,
				updated_at: dbNow()
			})
			.where(and(dueWork(), gte(boltTask.attempts, boltTask.max_attempts)))
			.toSQL()
	);

/** Atomically claims one due row and fences it for the host's complete invocation deadline. */
const claimStatement = (leaseForMillis: number): Statement => {
	const claimed = composer
		.select({ id: boltTask.id })
		.from(boltTask)
		.where(and(dueWork(), lt(boltTask.attempts, boltTask.max_attempts)))
		.orderBy(asc(boltTask.run_at), asc(boltTask.created_at), asc(boltTask.id))
		.limit(1)
		.for('update', { skipLocked: true });
	return toStatement(
		composer
			.update(boltTask)
			.set({
				status: 'running',
				attempts: increment(boltTask.attempts),
				error: null,
				lease_expires_at: dbNowPlusSeconds(leaseForMillis / 1_000),
				updated_at: dbNow()
			})
			.where(inArray(boltTask.id, claimed))
			.returning({
				command: boltTask.command,
				input: boltTask.input,
				effect_id: boltTask.effect_id,
				run_at: boltTask.run_at,
				attempts: boltTask.attempts
			})
			.toSQL()
	);
};

/** Earliest pending availability, running lease expiry, or cron declaration. */
const whenStatement = (): Statement =>
	toStatement(
		composer
			.select({
				next_due_at: aliased(
					least(
						least(
							composer
								.select({ value: min(boltTask.run_at) })
								.from(boltTask)
								.where(eq(boltTask.status, 'pending')),
							composer
								.select({ value: min(boltTask.lease_expires_at) })
								.from(boltTask)
								.where(eq(boltTask.status, 'running'))
						),
						composer.select({ value: min(boltSchedule.next_run_at) }).from(boltSchedule)
					),
					'next_due_at'
				)
			})
			.from(singleton())
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
									inArray(boltTask.status, ['failed', 'stopped', 'skipped']),
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
								next_run_at: excludedWhenDistinct(boltSchedule.crontab, boltSchedule.next_run_at)
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

	/** Rolls cron declarations, then atomically claims one due cron or direct task. */
	const fire = (nowEpochMs: number, leaseForMillis: number): Effect.Effect<FireReport, E> =>
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
				readonly command: string;
				readonly input: string;
				readonly effect_id: string;
				readonly run_at: string;
				readonly status: 'pending';
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
					command: row.command,
					input: storedJson(row.input),
					effect_id: slotEffectId(row.key, slotEpochMs),
					run_at: storedInstant(slotEpochMs),
					status: 'pending'
				});
			}
			const writes: Array<Statement> = [...advances];
			if (retired.length > 0)
				writes.push(
					toStatement(
						composer.delete(boltSchedule).where(inArray(boltSchedule.key, retired)).toSQL()
					)
				);
			if (runs.length > 0)
				writes.push(
					toStatement(
						composer
							.insert(boltTask)
							.values(runs)
							.onConflictDoNothing({ target: boltTask.effect_id })
							.toSQL()
					)
				);
			const claimed = yield* execute([
				...writes,
				failExhaustedDueStatement(),
				claimStatement(leaseForMillis)
			]);
			const occurrences = claimed.flatMap((row) => {
				const decoded = decodeTaskRow(row);
				return decoded === undefined ? [] : [decoded];
			});
			const nextDueAtEpochMs = yield* execute([whenStatement()]).pipe(Effect.map(readWhen));
			return {
				occurrences,
				rejections,
				rolled: runs.length,
				nextDueAtEpochMs
			};
		});

	const settle = (
		taskId: string,
		attempt: number,
		outcome: HostScheduleOutcome,
		random: () => number = Math.random
	): Effect.Effect<number | undefined, E> => {
		const fence = and(
			eq(boltTask.effect_id, taskId),
			eq(boltTask.status, 'running'),
			eq(boltTask.attempts, attempt)
		);
		let statements: ReadonlyArray<Statement>;
		if (outcome._tag === 'Done') {
			statements = [
				toStatement(
					composer
						.update(boltTask)
						.set({
							status: 'done',
							result: storedJson(outcome.result),
							error: null,
							lease_expires_at: null,
							updated_at: dbNow()
						})
						.where(fence)
						.toSQL()
				)
			];
		} else if (outcome._tag === 'Skipped') {
			statements = [
				toStatement(
					composer
						.update(boltTask)
						.set({
							status: 'skipped',
							result: null,
							error: outcome.reason,
							lease_expires_at: null,
							updated_at: dbNow()
						})
						.where(fence)
						.toSQL()
				)
			];
		} else if (outcome.retryable === false) {
			statements = [
				toStatement(
					composer
						.update(boltTask)
						.set({
							status: 'failed',
							result: null,
							error: outcome.error,
							lease_expires_at: null,
							updated_at: dbNow()
						})
						.where(fence)
						.toSQL()
				)
			];
		} else {
			statements = [
				toStatement(
					composer
						.update(boltTask)
						.set({
							status: 'pending',
							result: null,
							error: outcome.error,
							lease_expires_at: null,
							run_at: dbNowPlusSeconds(RETRY.secondsAfter(attempt, random)),
							updated_at: dbNow()
						})
						.where(and(fence, lt(boltTask.attempts, boltTask.max_attempts)))
						.toSQL()
				),
				toStatement(
					composer
						.update(boltTask)
						.set({
							status: 'failed',
							result: null,
							error: outcome.error,
							lease_expires_at: null,
							updated_at: dbNow()
						})
						.where(fence)
						.toSQL()
				)
			];
		}
		return execute([...statements, pruneStatement(), whenStatement()]).pipe(Effect.map(readWhen));
	};

	const when = (): Effect.Effect<number | undefined, E> =>
		execute([whenStatement()]).pipe(Effect.map(readWhen));

	return { declare, fire, settle, when };
};
