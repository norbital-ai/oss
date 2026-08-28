import { Clock, Context, Effect, Layer, Schema } from 'effect';
import { EffectId, type EffectId as EffectIdType } from '@norbital-ai/bolt-protocol';
import * as Database from '#lib/runtime/facilities/database.js';
import { automationSubject } from '#lib/runtime/identity/static-identity.js';
import * as TenantScope from '#lib/runtime/tenant.js';
import * as TaskQueue from '#lib/runtime/tasks/tasks.js';
import * as Workspace from '#lib/runtime/workspace.js';
import * as InvocationBudget from '#lib/runtime/budget.js';
import type { AutomationProgression } from '#lib/authoring/automations-schema.js';

/** Durable states in which an old guest must not cross another authored facility boundary. */
const StoppedTaskStatus = Schema.Struct({
	status: Schema.Literals(['paused', 'resuming'])
});

/**
 * Refuses an authored operation after its durable automation run has been stopped.
 *
 * Stopping cannot interrupt a remote guest fiber. This error is therefore raised at the next
 * authored facility boundary, before that fiber can write another row, call a model, read an asset,
 * or enqueue more work.
 */
export class AutomationStopped extends Schema.TaggedError<AutomationStopped>()(
	'Bolt.Automations.Stopped',
	{
		taskId: Schema.NonEmptyString,
		operation: Schema.NonEmptyString,
		message: Schema.NonEmptyString
	}
) {
	readonly category = 'automation-stopped' as const;
	readonly retryable = false;

	static before(taskId: string, operation: string): AutomationStopped {
		return new AutomationStopped({
			taskId,
			operation,
			message: `Automation ${taskId} was stopped before ${operation}.`
		});
	}
}

export type AutomationStartOptions = Readonly<{
	readonly afterMillis?: number | undefined;
	readonly scope?: Readonly<Record<string, Schema.Json>> | undefined;
	readonly taskId?: string | undefined;
	readonly parentDepth?: number | undefined;
}>;

export type AutomationStartRequest = Readonly<{
	readonly effectId: EffectIdType;
	readonly name: string;
	readonly input: Schema.Json;
	readonly options?: AutomationStartOptions;
}>;

/**
 * Starting an automation, and asking what became of one.
 *
 * There used to be a second table under this — `bolt_automation_runs`, with `effect_id`, `task_id`,
 * `state ∈ {queued, scheduled, resumed, cancelled}` and `input`. Every one of those columns shadowed
 * a column of `bolt_task`, and the shadow was written beside a facility call that nothing executed:
 * an automation run was recorded twice and performed zero times. Immediate runs now use the private
 * task row only as their durable input/lifecycle record and execute in the request that admitted
 * them. Only an explicit schedule or delay enters the timer queue.
 */

export type Interface = Readonly<{
	readonly register: (name: string) => Effect.Effect<void, Workspace.WorkspaceLookupError>;
	/**
	 * Admits one run of a named automation.
	 *
	 * It takes no `Subject`, and that absence is the change. It used to take the caller's — so the
	 * same automation ran with whatever authority whoever tripped it happened to hold, so a highly
	 * privileged caller could accidentally lend all of its grants to the run. An
	 * automation's authority is a property of the automation: the policies its declaration names,
	 * minted here, at the runtime's own admission point.
	 */
	readonly start: (
		effectId: EffectIdType,
		name: string,
		input: Schema.Json,
		/** How long to wait before it becomes due. Absent means direct execution by this caller. */
		options?: AutomationStartOptions
	) => Effect.Effect<
		string,
		Database.FacilityError | Workspace.WorkspaceLookupError | InvocationBudget.NestingLimitExceeded
	>;
	/** Admits many independent starts in one database transaction and emits at most one timer wake. */
	readonly startMany: (
		effectId: EffectIdType,
		runs: ReadonlyArray<AutomationStartRequest>
	) => Effect.Effect<
		ReadonlyArray<Readonly<{ readonly name: string; readonly taskId: string }>>,
		Database.FacilityError | Workspace.WorkspaceLookupError | InvocationBudget.NestingLimitExceeded
	>;
	readonly runStep: Interface['start'];
	/** Runs one already-admitted immediate automation body without a scheduler or wake hop. */
	readonly execute: <E, R>(
		effectId: EffectIdType,
		name: string,
		taskId: string,
		run: (input: Schema.Json, attemptEffectId: string) => Effect.Effect<Schema.Json, E, R>
	) => Effect.Effect<
		Schema.Json | undefined,
		E | Database.FacilityError | Workspace.WorkspaceLookupError,
		R
	>;
	/** Executes already-admitted immediate automation bodies with batched claim and settlement. */
	readonly executeMany: <E, R>(
		effectId: EffectIdType,
		runs: ReadonlyArray<Readonly<{ readonly name: string; readonly taskId: string }>>,
		run: (
			name: string,
			taskId: string,
			input: Schema.Json,
			attemptEffectId: string
		) => Effect.Effect<Schema.Json, E, R>
	) => Effect.Effect<
		ReadonlyArray<
			Readonly<{
				readonly name: string;
				readonly taskId: string;
				readonly exit: import('effect').Exit.Exit<Schema.Json, E>;
			}>
		>,
		Database.FacilityError | Workspace.WorkspaceLookupError,
		R
	>;
	readonly status: (
		effectId: EffectIdType,
		taskId: string
	) => Effect.Effect<Schema.Json | undefined, Database.FacilityError>;
	/** Replaces the current snapshot of the automation task that is presently running. */
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
	readonly resume: Interface['stop'];
}>;
/** Identifies the automations service in Effect's context so dependency wiring remains explicit and type checked. */
export const Service = Context.Service<Interface>('@norbital-ai/bolt/Automations');

/**
 * Builds the guard for one running automation turn.
 *
 * Every observation carries a fresh effect id. Facility idempotency is keyed by effect id, so
 * reusing the turn's id would let the first `pending` answer be replayed forever and make a later
 * cancellation invisible to exactly the guard that is supposed to observe it.
 */
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

export const layer = Layer.effect(
	Service,
	Effect.gen(function* () {
		const queue = yield* TaskQueue.Service;
		const workspace = yield* Workspace.Service;
		const budget = yield* InvocationBudget.Service;
		const tenant = yield* TenantScope.Service;
		const prepareStart = Effect.fn('Automations.prepareStart')(function* (
			request: AutomationStartRequest,
			nowEpochMs: number
		) {
			const { effectId, name, input, options } = request;
			const declaration = yield* workspace.automation(name);
			const subject = automationSubject(declaration, tenant.tenantId);
			// Checked before anything is written, so a chain that has gone too deep leaves no queued row
			// behind that nothing will ever move off `pending`.
			//
			// This is the bound on automation recursion, and it has to be a counter rather than a
			// deadline: an automation is durable, so it runs on a fresh invocation with a fresh deadline,
			// and "inherit the parent's remaining time" has no meaning for work that starts after the
			// parent has already returned. The other half of the cycle break is that an automation does
			// not re-trigger on its own writes.
			const depth = yield* InvocationBudget.make(
				options?.parentDepth ?? budget.depth,
				budget.limit
			).nest(`automation ${name}`);
			// `bolt_run_as` is stamped here, at the runtime's own admission point, so the handler
			// later sees was written by this service — a caller's own `bolt_run_as` claim is overwritten,
			// never forwarded, and what it is overwritten *with* is the automation's own declared
			// authority rather than whoever's finger was on the trigger. `bolt_depth` rides the same payload, which is why the queue needs no depth
			// column: the bound travels with the work rather than with the row.
			const enqueued: Schema.Json = InvocationBudget.stampDepth(
				{
					// The task boundary has one envelope for every trigger: generated client input is the
					// handler's `context.args`, while collection events and schedules additionally carry
					// `scope`. Spreading a struct input here put `project_id` beside `bolt_run_as`; the
					// queued turn then decoded `args` and failed before the automation could emit progress.
					args: input,
					scope: options?.scope ?? {},
					bolt_run_as: subject
				},
				depth
			);
			// The id the caller gets back is the task's effect id, which is also its idempotency key. A
			// replayed start therefore names the row the first one wrote, rather than minting a second
			// identity for a row that was never inserted.
			const taskId = options?.taskId ?? `${effectId}:start`;
			const afterMillis = options?.afterMillis;
			const runAtEpochMs =
				afterMillis === undefined || afterMillis <= 0 ? undefined : nowEpochMs + afterMillis;
			return {
				name,
				taskId,
				immediate: runAtEpochMs === undefined,
				enqueue: {
					command: `automations.${name}`,
					input: enqueued,
					effectId: taskId,
					// Absent rather than `now`, so the row takes the column default and a delay of zero and
					// no delay at all are the same row rather than two spellings of one.
					...(runAtEpochMs === undefined ? {} : { runAtEpochMs })
				}
			} as const;
		});
		const startMany = Effect.fn('Automations.startMany')(function* (
			effectId: EffectIdType,
			runs: ReadonlyArray<AutomationStartRequest>
		) {
			if (runs.length === 0) return [];
			const nowEpochMs = yield* Clock.currentTimeMillis;
			const prepared = yield* Effect.forEach(runs, (run) => prepareStart(run, nowEpochMs));
			const immediate = prepared.filter((run) => run.immediate).map((run) => run.enqueue);
			const delayed = prepared.filter((run) => !run.immediate).map((run) => run.enqueue);
			if (immediate.length > 0) {
				yield* queue.admit(EffectId.make(`${effectId}:immediate`), immediate);
			}
			if (delayed.length > 0) {
				// A real delay is the one case in which a timer owns waiting. Once due, the task runner
				// invokes the authored body directly; it does not schedule another body step.
				yield* queue.enqueue(EffectId.make(`${effectId}:delayed`), delayed);
			}
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
			if (admitted === undefined) return `${effectId}:start`;
			return admitted.taskId;
		});
		const executeMany: Interface['executeMany'] = (effectId, runs, run) =>
			Effect.gen(function* () {
				for (const { name } of runs) yield* workspace.automation(name);
				const nameByTaskId = new Map(runs.map(({ name, taskId }) => [taskId, name]));
				const outcomes = yield* queue.runDirectMany(
					effectId,
					runs.map(({ name, taskId }) => ({ taskId, command: `automations.${name}` })),
					(task, attemptEffectId) => {
						const name = nameByTaskId.get(task.effectId);
						if (name === undefined)
							return Effect.die(new Error(`Unknown direct task ${task.effectId}`));
						return run(name, task.effectId, task.input, attemptEffectId);
					}
				);
				return outcomes.flatMap(({ task, exit }) => {
					const name = nameByTaskId.get(task.effectId);
					return name === undefined ? [] : [{ name, taskId: task.effectId, exit }];
				});
			});
		return Service.of({
			register: Effect.fn('Automations.register')(function* (name) {
				yield* workspace.automation(name);
			}),
			start,
			startMany,
			runStep: start,
			execute: Effect.fn('Automations.execute')(function* (effectId, name, taskId, run) {
				yield* workspace.automation(name);
				return yield* queue.runDirect(
					effectId,
					taskId,
					`automations.${name}`,
					(task, attemptEffectId) => run(task.input, attemptEffectId)
				);
			}),
			executeMany,
			status: queue.status,
			progress: queue.progress,
			stop: Effect.fn('Automations.stop')(function* (effectId, name, taskId) {
				// The declaration check rejects invented names before a caller-controlled string reaches
				// the queue predicate. The exact command then scopes the id to this automation only.
				yield* workspace.automation(name);
				yield* queue.stop(effectId, taskId, `automations.${name}`);
				yield* queue.interruptActive(EffectId.make(`${effectId}:interrupt`), taskId);
			}),
			resume: Effect.fn('Automations.resume')(function* (effectId, name, taskId) {
				yield* workspace.automation(name);
				yield* queue.resumeDirect(effectId, taskId, `automations.${name}`);
			})
		});
	})
);
