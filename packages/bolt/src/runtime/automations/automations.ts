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

/**
 * Starting an automation, and asking what became of one.
 *
 * There used to be a second table under this — `bolt_automation_runs`, with `effect_id`, `task_id`,
 * `state ∈ {queued, scheduled, resumed, cancelled}` and `input`. Every one of those columns shadowed
 * a column of `bolt_task`, and the shadow was written beside a facility call that nothing executed:
 * an automation run was recorded twice and performed zero times. The run *is* the task, so the
 * bookkeeping is gone and this service is now a thin naming layer over the queue.
 */

export type Interface = Readonly<{
	readonly register: (name: string) => Effect.Effect<void, Workspace.WorkspaceLookupError>;
	/**
	 * Queue one run of a named automation.
	 *
	 * It takes no `Subject`, and that absence is the change. It used to take the caller's — so the
	 * same automation ran with whatever authority whoever tripped it happened to hold, so a highly
	 * privileged caller could accidentally lend all of its grants to the run. An
	 * automation's authority is a property of the automation: the policies its declaration names,
	 * minted here, at the runtime's own enqueue point.
	 */
	readonly start: (
		effectId: EffectIdType,
		name: string,
		input: Schema.Json,
		/** How long to wait before it becomes due. Absent means as soon as a tick can take it. */
		options?: Readonly<{ readonly afterMillis?: number | undefined }>
	) => Effect.Effect<
		string,
		Database.FacilityError | Workspace.WorkspaceLookupError | InvocationBudget.NestingLimitExceeded
	>;
	readonly runStep: Interface['start'];
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
		const start = Effect.fn('Automations.start')(function* (
			effectId: EffectIdType,
			name: string,
			input: Schema.Json,
			options?: Readonly<{ readonly afterMillis?: number | undefined }>
		) {
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
			const depth = yield* budget.nest(`automation ${name}`);
			// `bolt_run_as` is stamped here, at the runtime's own enqueue point, so the task the handler
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
					bolt_run_as: subject
				},
				depth
			);
			// The id the caller gets back is the task's effect id, which is also its idempotency key. A
			// replayed start therefore names the row the first one wrote, rather than minting a second
			// identity for a row that was never inserted.
			const taskId = `${effectId}:start`;
			const afterMillis = options?.afterMillis;
			const runAtEpochMs =
				afterMillis === undefined || afterMillis <= 0
					? undefined
					: (yield* Clock.currentTimeMillis) + afterMillis;
			yield* queue.enqueue(EffectId.make(taskId), [
				{
					command: `automations.${name}`,
					input: enqueued,
					effectId: taskId,
					// Absent rather than `now`, so the row takes the column default and a delay of zero and
					// no delay at all are the same row rather than two spellings of one.
					...(runAtEpochMs === undefined ? {} : { runAtEpochMs })
				}
			]);
			return taskId;
		});
		return Service.of({
			register: Effect.fn('Automations.register')(function* (name) {
				yield* workspace.automation(name);
			}),
			start,
			runStep: start,
			status: queue.status,
			progress: queue.progress,
			stop: Effect.fn('Automations.stop')(function* (effectId, name, taskId) {
				// The declaration check rejects invented names before a caller-controlled string reaches
				// the queue predicate. The exact command then scopes the id to this automation only.
				yield* workspace.automation(name);
				yield* queue.stop(effectId, taskId, `automations.${name}`);
			}),
			resume: Effect.fn('Automations.resume')(function* (effectId, name, taskId) {
				yield* workspace.automation(name);
				yield* queue.resume(effectId, taskId, `automations.${name}`);
			})
		});
	})
);
