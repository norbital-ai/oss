import { Cause, Context, Effect, Exit, Layer, Schema } from 'effect';
import {
	EffectId,
	type EffectId as EffectIdType,
	type SyncChange
} from '@norbital-ai/bolt-protocol';
import { SYSTEM_MODEL_TABLES } from '#lib/authoring/system-models.js';
import type { AutomationProgression } from '#lib/authoring/automations-schema.js';
import * as Database from '#lib/runtime/facilities/database.js';
import { automationSubject } from '#lib/runtime/identity/static-identity.js';
import {
	composer,
	dbNow,
	executeBuilt,
	increment,
	transactionBuilt
} from '#lib/runtime/persistence.js';
import * as TenantScope from '#lib/runtime/tenant.js';
import * as TaskQueue from '#lib/runtime/tasks/tasks.js';
import * as Workspace from '#lib/runtime/workspace.js';
import * as InvocationBudget from '#lib/runtime/budget.js';
import { SyncCommit } from '#lib/runtime/facilities/services.js';
import { and, eq } from 'drizzle-orm';

const { automation_run: automationRun, bolt_task: boltTask } = SYSTEM_MODEL_TABLES;
const automationRunPublication = {
	id: automationRun.id,
	task_id: automationRun.task_id,
	name: automationRun.name,
	status: automationRun.status
} as const;
const StoppedTaskStatus = Schema.Struct({ status: Schema.Literal('stopped') });

export class AutomationStopped extends Schema.TaggedError<AutomationStopped>()(
	'Bolt.Automations.Stopped',
	{
		taskId: Schema.NonEmptyString,
		operation: Schema.NonEmptyString,
		message: Schema.NonEmptyString
	}
) {
	readonly category = 'automation-stopped' as const;

	static before(taskId: string, operation: string): AutomationStopped {
		return new AutomationStopped({
			taskId,
			operation,
			message: `Automation ${taskId} was stopped before ${operation}.`
		});
	}
}

/** Delayed work is not a cron declaration and therefore has no durable place to wait. */
class AutomationDeferredUnsupported extends Schema.TaggedError<AutomationDeferredUnsupported>()(
	'Bolt.Automations.DeferredUnsupported',
	{ name: Schema.NonEmptyString, delayMillis: Schema.Number }
) {}

type AutomationStartOptions = Readonly<{
	readonly afterMillis?: number | undefined;
	readonly scope?: Readonly<Record<string, Schema.Json>> | undefined;
	readonly taskId?: string | undefined;
	readonly parentDepth?: number | undefined;
}>;

type AutomationStartRequest = Readonly<{
	readonly effectId: EffectIdType;
	readonly name: string;
	readonly input: Schema.Json;
	readonly options?: AutomationStartOptions;
}>;

type StartFailure =
	| Database.FacilityError
	| Workspace.WorkspaceLookupError
	| InvocationBudget.NestingLimitExceeded
	| AutomationDeferredUnsupported;

export type Interface = Readonly<{
	/** Host startup hook. Conductor calls this once for each loaded environment after a restart. */
	readonly recover: (effectId: EffectIdType) => Effect.Effect<void, Database.FacilityError>;
	readonly register: (name: string) => Effect.Effect<void, Workspace.WorkspaceLookupError>;
	/** Records and returns one immediate run. The caller executes it in this same invocation. */
	readonly start: (
		effectId: EffectIdType,
		name: string,
		input: Schema.Json,
		options?: AutomationStartOptions
	) => Effect.Effect<string, StartFailure>;
	readonly startMany: (
		effectId: EffectIdType,
		runs: ReadonlyArray<AutomationStartRequest>
	) => Effect.Effect<
		ReadonlyArray<Readonly<{ readonly name: string; readonly taskId: string }>>,
		StartFailure
	>;
	readonly execute: <E, R>(
		effectId: EffectIdType,
		name: string,
		taskId: string,
		run: (input: Schema.Json, runEffectId: string) => Effect.Effect<Schema.Json, E, R>
	) => Effect.Effect<
		Schema.Json | undefined,
		E | Database.FacilityError | Workspace.WorkspaceLookupError,
		R
	>;
	readonly executeMany: <E, R>(
		effectId: EffectIdType,
		runs: ReadonlyArray<Readonly<{ readonly name: string; readonly taskId: string }>>,
		run: (
			name: string,
			taskId: string,
			input: Schema.Json,
			runEffectId: string
		) => Effect.Effect<Schema.Json, E, R>
	) => Effect.Effect<
		ReadonlyArray<
			Readonly<{
				readonly name: string;
				readonly taskId: string;
				readonly exit: Exit.Exit<
					Schema.Json,
					E | Workspace.WorkspaceLookupError | Database.FacilityError
				>;
			}>
		>,
		Database.FacilityError | Workspace.WorkspaceLookupError,
		R
	>;
	readonly status: (
		effectId: EffectIdType,
		taskId: string
	) => Effect.Effect<Schema.Json | undefined, Database.FacilityError>;
	/** Trigger projections await the central transaction-capture seam before they can publish. */
	readonly publishProjectedRuns: (
		effectId: EffectIdType,
		taskIds: ReadonlyArray<string>
	) => Effect.Effect<void, Database.FacilityError>;
	readonly progress: (
		effectId: EffectIdType,
		taskId: string,
		value: AutomationProgression
	) => Effect.Effect<void, Database.FacilityError>;
	readonly stop: (
		effectId: EffectIdType,
		name: string,
		taskId: string
	) => Effect.Effect<void, Database.FacilityError | Workspace.WorkspaceLookupError>;
}>;

export const Service = Context.Service<Interface>('@norbital-ai/bolt/Automations');

export const stoppageGuard = (
	automations: Interface,
	turnEffectId: EffectIdType,
	taskId: string
): ((operation: string) => Effect.Effect<void, AutomationStopped | Database.FacilityError>) => {
	let sequence = 0;
	return Effect.fn('Automations.stoppageGuard')(function* (operation: string) {
		sequence += 1;
		const status = yield* automations.status(
			EffectId.make(`${turnEffectId}:stoppage:${sequence}`),
			taskId
		);
		if (Schema.is(StoppedTaskStatus)(status)) {
			return yield* AutomationStopped.before(taskId, operation);
		}
	});
};

const DirectInputRow = Schema.Struct({ input: Schema.Json });
const decodeDirectInputRow = Schema.decodeUnknownOption(DirectInputRow);

/** What a finished direct run owes its ledger row. */
type DirectSettlement =
	| Readonly<{ readonly status: 'done'; readonly result: Schema.Json }>
	| Readonly<{ readonly status: 'failed'; readonly error: string }>;

export const layer = Layer.effect(
	Service,
	Effect.gen(function* () {
		const database = yield* Database.Service;
		const queue = yield* TaskQueue.Service;
		const workspace = yield* Workspace.Service;
		const budget = yield* InvocationBudget.Service;
		const tenant = yield* TenantScope.Service;
		const syncCommit = yield* SyncCommit.Service;
		const AutomationRunPublicationRow = Schema.Struct({
			id: Schema.NonEmptyString,
			task_id: Schema.NonEmptyString,
			name: Schema.NonEmptyString,
			status: Schema.NonEmptyString
		});
		const decodeAutomationRunPublicationRow = Schema.decodeUnknownOption(
			AutomationRunPublicationRow
		);
		const runChanges = (
			rows: ReadonlyArray<unknown>,
			operation: 'insert' | 'update'
		): ReadonlyArray<SyncChange> =>
			rows.flatMap((row): ReadonlyArray<SyncChange> => {
				const decoded = decodeAutomationRunPublicationRow(row);
				if (decoded._tag === 'None') return [];
				const { id, ...after } = decoded.value;
				return operation === 'insert'
					? [{ collection: 'automation_run', id, operation, after }]
					: [
							{
								// Direct updates require the old status to be running and leave task/name intact.
								collection: 'automation_run',
								id,
								operation,
								before: { ...after, status: 'running' },
								after
							}
						];
			});
		const publishRuns = (
			effectId: EffectIdType,
			rows: ReadonlyArray<unknown>,
			operation: 'insert' | 'update'
		): Effect.Effect<void, Database.FacilityError> =>
			syncCommit.publish(EffectId.make(`${effectId}:publish`), {
				changes: runChanges(rows, operation)
			});
		const publishProjectedRuns = Effect.fn('Automations.publishProjectedRuns')(function* (
			_effectId: EffectIdType,
			taskIds: ReadonlyArray<string>
		) {
			if (taskIds.length === 0) return;
			// The trigger projection exposes only current rows: it cannot distinguish insert from update
			// or recover the old status route. Phase 5 must publish it from central transition capture.
		});
		/** Input for request-owned runs exists only as long as the invocation that admitted it. */
		const directInputs = new Map<
			string,
			Readonly<{ readonly name: string; readonly input: Schema.Json }>
		>();

		const prepareStart = Effect.fn('Automations.prepareStart')(function* (
			request: AutomationStartRequest
		) {
			const { effectId, name, input, options } = request;
			const declaration = yield* workspace.automation(name);
			const delayMillis = options?.afterMillis ?? 0;
			if (delayMillis > 0) {
				return yield* new AutomationDeferredUnsupported({ name, delayMillis });
			}
			const subject = automationSubject(declaration, tenant.tenantId);
			const depth = yield* InvocationBudget.make(
				options?.parentDepth ?? budget.depth,
				budget.limit
			).nest(`automation ${name}`);
			const prepared: Schema.Json = InvocationBudget.stampDepth(
				{
					args: input,
					scope: options?.scope ?? {},
					bolt_run_as: subject
				},
				depth
			);
			return { name, taskId: options?.taskId ?? `${effectId}:start`, input: prepared } as const;
		});

		const startMany = Effect.fn('Automations.startMany')(function* (
			effectId: EffectIdType,
			runs: ReadonlyArray<AutomationStartRequest>
		) {
			if (runs.length === 0) return [];
			const prepared = yield* Effect.forEach(runs, prepareStart);
			const inserted = yield* transactionBuilt(
				EffectId.make(`${effectId}:runs`),
				database,
				prepared.map(({ name, taskId }) =>
					composer
						.insert(automationRun)
						.values({ task_id: taskId, name, status: 'running' })
						.onConflictDoNothing({ target: automationRun.task_id })
						.returning(automationRunPublication)
				)
			);
			yield* publishRuns(EffectId.make(`${effectId}:runs`), inserted.rows, 'insert');
			for (const item of prepared) directInputs.set(item.taskId, item);
			return prepared.map(({ name, taskId }) => ({ name, taskId }));
		});

		const start = Effect.fn('Automations.start')(function* (
			effectId: EffectIdType,
			name: string,
			input: Schema.Json,
			options?: AutomationStartOptions
		) {
			const [admitted] = yield* startMany(effectId, [
				{ effectId, name, input, ...(options === undefined ? {} : { options }) }
			]);
			return admitted?.taskId ?? `${effectId}:start`;
		});

		const readCronInput = Effect.fn('Automations.readCronInput')(function* (
			effectId: EffectIdType,
			name: string,
			taskId: string
		) {
			const response = yield* executeBuilt(
				effectId,
				database,
				composer
					.select({ input: boltTask.input })
					.from(boltTask)
					.where(
						and(
							eq(boltTask.effect_id, taskId),
							eq(boltTask.command, `automations.${name}`),
							eq(boltTask.status, 'running')
						)
					)
					.limit(1)
			);
			const decoded = decodeDirectInputRow(response.rows[0]);
			return decoded._tag === 'Some' ? decoded.value.input : undefined;
		});

		const settleDirectMany = Effect.fn('Automations.settleDirectMany')(function* (
			effectId: EffectIdType,
			settlements: ReadonlyArray<
				Readonly<{ readonly taskId: string; readonly outcome: DirectSettlement }>
			>
		) {
			if (settlements.length === 0) return;
			const settled = yield* transactionBuilt(
				effectId,
				database,
				settlements.map(({ taskId, outcome }) =>
					composer
						.update(automationRun)
						.set(
							outcome.status === 'done'
								? {
										status: 'done',
										result: JSON.stringify(outcome.result),
										error: null,
										updated_at: dbNow(),
										row_version: increment(automationRun.row_version)
									}
								: {
										status: 'failed',
										result: null,
										error: outcome.error,
										updated_at: dbNow(),
										row_version: increment(automationRun.row_version)
									}
						)
						.where(and(eq(automationRun.task_id, taskId), eq(automationRun.status, 'running')))
						.returning(automationRunPublication)
				)
			);
			yield* publishRuns(effectId, settled.rows, 'update');
			for (const { taskId } of settlements) directInputs.delete(taskId);
		});

		const settleDirect = (
			effectId: EffectIdType,
			taskId: string,
			outcome: DirectSettlement
		): Effect.Effect<void, Database.FacilityError> =>
			settleDirectMany(effectId, [{ taskId, outcome }]);

		/**
		 * One run, settled through whatever the caller hands it.
		 *
		 * `execute` settles immediately; `executeMany` records the settlement and writes every run's
		 * in one statement. The ledger row per run is the point of settling — one round trip per run
		 * is not, and a change event batched over N written records used to pay N of them, which made
		 * the cost of a write scale with the number of rows it wrote.
		 */
		const executeSettlingWith = <E, R>(
			effectId: EffectIdType,
			name: string,
			taskId: string,
			run: (input: Schema.Json, runEffectId: string) => Effect.Effect<Schema.Json, E, R>,
			settle: (
				taskId: string,
				outcome: DirectSettlement
			) => Effect.Effect<void, Database.FacilityError>
		) =>
			Effect.gen(function* () {
				yield* workspace.automation(name);
				const direct = directInputs.get(taskId);
				const input =
					direct?.name === name
						? direct.input
						: yield* readCronInput(EffectId.make(`${effectId}:cron`), name, taskId);
				if (input === undefined) return undefined;
				const body = Effect.acquireUseRelease(
					queue.active(EffectId.make(`${effectId}:active`), taskId),
					() => run(input, taskId),
					() => queue.settled(EffectId.make(`${effectId}:settled`), taskId)
				);
				if (direct === undefined) return yield* body;
				return yield* Effect.matchCauseEffect(body, {
					onFailure: (cause) =>
						settle(taskId, { status: 'failed', error: Cause.pretty(cause) }).pipe(
							Effect.andThen(Effect.failCause(cause))
						),
					onSuccess: (result) => settle(taskId, { status: 'done', result }).pipe(Effect.as(result))
				});
			});

		const execute: Interface['execute'] = (effectId, name, taskId, run) =>
			executeSettlingWith(effectId, name, taskId, run, (settledTaskId, outcome) =>
				settleDirect(
					EffectId.make(`${effectId}:${outcome.status === 'done' ? 'done' : 'failed'}`),
					settledTaskId,
					outcome
				)
			);

		const executeMany: Interface['executeMany'] = (effectId, runs, run) =>
			Effect.gen(function* () {
				const settlements: Array<
					Readonly<{ readonly taskId: string; readonly outcome: DirectSettlement }>
				> = [];
				const results = yield* Effect.forEach(
					runs,
					({ name, taskId }, index) =>
						Effect.exit(
							executeSettlingWith(
								EffectId.make(`${effectId}:${index}`),
								name,
								taskId,
								(input, runEffectId) => run(name, taskId, input, runEffectId),
								(settledTaskId, outcome) =>
									Effect.sync(() => {
										settlements.push({ taskId: settledTaskId, outcome });
									})
							).pipe(
								Effect.flatMap((result) =>
									result === undefined
										? Effect.die(new Error(`Automation ${taskId} has no invocation input`))
										: Effect.succeed(result)
								)
							)
						).pipe(Effect.map((exit) => ({ name, taskId, exit }))),
					{ concurrency: 'unbounded' }
				);
				yield* settleDirectMany(EffectId.make(`${effectId}:settled`), settlements);
				return results;
			});

		return Service.of({
			recover: Effect.fn('Automations.recover')(function* (effectId) {
				const recovered = yield* transactionBuilt(effectId, database, [
					composer
						.update(automationRun)
						.set({
							status: 'failed',
							error: 'host restarted during run',
							result: null,
							updated_at: dbNow(),
							row_version: increment(automationRun.row_version)
						})
						.where(eq(automationRun.status, 'running'))
						.returning(automationRunPublication)
				]);
				yield* publishRuns(effectId, recovered.rows, 'update');
			}),
			register: Effect.fn('Automations.register')(function* (name) {
				yield* workspace.automation(name);
			}),
			start,
			startMany,
			execute,
			executeMany,
			status: Effect.fn('Automations.status')(function* (effectId, taskId) {
				const response = yield* executeBuilt(
					effectId,
					database,
					composer
						.select({
							status: automationRun.status,
							error: automationRun.error,
							result: automationRun.result,
							progress: automationRun.progress,
							progressSequence: automationRun.progress_sequence,
							progressUpdatedAt: automationRun.progress_updated_at
						})
						.from(automationRun)
						.where(eq(automationRun.task_id, taskId))
						.limit(1)
				);
				return response.rows[0];
			}),
			publishProjectedRuns,
			progress: Effect.fn('Automations.progress')(function* (effectId, taskId, value) {
				if (directInputs.has(taskId)) {
					const progressed = yield* executeBuilt(
						effectId,
						database,
						composer
							.update(automationRun)
							.set({
								progress: JSON.stringify(value),
								progress_sequence: increment(automationRun.progress_sequence),
								progress_updated_at: dbNow(),
								updated_at: dbNow(),
								row_version: increment(automationRun.row_version)
							})
							.where(and(eq(automationRun.task_id, taskId), eq(automationRun.status, 'running')))
							.returning(automationRunPublication)
					);
					yield* publishRuns(effectId, progressed.rows, 'update');
					return;
				}
				yield* queue.progress(effectId, taskId, value);
				yield* publishProjectedRuns(EffectId.make(`${effectId}:projected`), [taskId]);
			}),
			stop: Effect.fn('Automations.stop')(function* (effectId, name, taskId) {
				yield* workspace.automation(name);
				if (directInputs.has(taskId)) {
					const stopped = yield* executeBuilt(
						effectId,
						database,
						composer
							.update(automationRun)
							.set({
								status: 'stopped',
								error: 'stopped',
								updated_at: dbNow(),
								row_version: increment(automationRun.row_version)
							})
							.where(
								and(
									eq(automationRun.task_id, taskId),
									eq(automationRun.name, name),
									eq(automationRun.status, 'running')
								)
							)
							.returning(automationRunPublication)
					);
					yield* publishRuns(effectId, stopped.rows, 'update');
					yield* queue.interruptActive(EffectId.make(`${effectId}:interrupt`), taskId);
					return;
				}
				yield* queue.stop(effectId, taskId, `automations.${name}`);
				yield* publishProjectedRuns(EffectId.make(`${effectId}:projected`), [taskId]);
			})
		});
	})
);
