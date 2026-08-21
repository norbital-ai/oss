import { Context, Effect, Layer, Schema } from 'effect';
import { EffectId, type EffectId as EffectIdType } from '@norbital-ai/bolt-protocol';
import { Database } from '../facilities/database.js';
import { automationSubject } from '../identity/static-identity.js';
import { TenantScope } from '../tenant.js';
import { TaskQueue } from '../tasks/tasks.js';
import { Workspace } from '../workspace.js';
import { InvocationBudget } from '../budget.js';

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
	 * same automation ran with whatever authority whoever tripped it happened to hold, and when an
	 * administrator tripped it, it ran as an administrator over every row in the workspace. An
	 * automation's authority is a property of the automation: the policies its declaration names,
	 * minted here, at the runtime's own enqueue point.
	 */
	readonly start: (
		effectId: EffectIdType,
		name: string,
		input: Schema.Json,
		/** How long to wait before it becomes due. Absent means as soon as a tick can take it. */
		options?: Readonly<{ readonly afterMillis?: number }>
	) => Effect.Effect<
		string,
		Database.FacilityError | Workspace.WorkspaceLookupError | InvocationBudget.NestingLimitExceeded
	>;
	readonly runStep: Interface['start'];
	readonly status: (
		effectId: EffectIdType,
		taskId: string
	) => Effect.Effect<Schema.Json | undefined, Database.FacilityError>;
	/** The recent runs of one automation, newest first — including runs nobody here started. */
	readonly history: (
		effectId: EffectIdType,
		name: string,
		limit: number
	) => Effect.Effect<ReadonlyArray<Schema.Json>, Database.FacilityError>;
	readonly cancel: (
		effectId: EffectIdType,
		taskId: string
	) => Effect.Effect<void, Database.FacilityError>;
}>;
/** Identifies the automations service in Effect's context so dependency wiring remains explicit and type checked. */
export const Service = Context.Service<Interface>('@norbital-ai/bolt/Automations');
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
			options?: Readonly<{ readonly afterMillis?: number }>
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
				typeof input === 'object' && input !== null && !Array.isArray(input)
					? { ...(input as Readonly<Record<string, Schema.Json>>), bolt_run_as: subject }
					: { args: {}, bolt_run_as: subject },
				depth
			);
			// The id the caller gets back is the task's effect id, which is also its idempotency key. A
			// replayed start therefore names the row the first one wrote, rather than minting a second
			// identity for a row that was never inserted.
			const taskId = `${effectId}:start`;
			const afterMillis = options?.afterMillis;
			yield* queue.enqueue(EffectId.make(taskId), [
				{
					command: `automations.${name}`,
					input: enqueued,
					effectId: taskId,
					// Absent rather than `now`, so the row takes the column default and a delay of zero and
					// no delay at all are the same row rather than two spellings of one.
					...(afterMillis === undefined || afterMillis <= 0
						? {}
						: { runAtEpochMs: Date.now() + afterMillis })
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
			/**
			 * What this automation has been doing, by the command name its runs are enqueued under.
			 *
			 * A caller names the automation; the queue is keyed by `automations.<name>`, which is an
			 * encoding detail and stays here rather than in a surface that would then have to know it.
			 */
			history: Effect.fn('Automations.history')(function* (effectId, name, limit) {
				return yield* queue.history(effectId, `automations.${name}`, limit);
			}),
			cancel: queue.cancel
		});
	})
);
export * as Automations from './automations.js';
