import { Context, Effect, Layer, Schema } from 'effect';
import { EffectId, type EffectId as EffectIdType } from '@norbital-ai/bolt-protocol';
import { Database } from '../facilities/database.js';
import { Tasks } from '../facilities/services.js';
import type { Subject } from '../identity/identity.js';
import { Workspace } from '../workspace.js';

export type Interface = Readonly<{
	readonly register: (name: string) => Effect.Effect<void, Workspace.WorkspaceLookupError>;
	readonly start: (effectId: EffectIdType, subject: Subject, name: string, input: Schema.Json) => Effect.Effect<string, Database.FacilityError | Workspace.WorkspaceLookupError>;
	readonly runStep: Interface['start'];
	readonly resume: (effectId: EffectIdType, taskId: string, input: Schema.Json) => Effect.Effect<void, Database.FacilityError>;
	readonly status: (effectId: EffectIdType, taskId: string) => Effect.Effect<Schema.Json | undefined, Database.FacilityError>;
	readonly cancel: (effectId: EffectIdType, taskId: string) => Effect.Effect<void, Database.FacilityError>;
}>;
/** Identifies the automations service in Effect's context so dependency wiring remains explicit and type checked. */
export const Service = Context.Service<Interface>('@norbital-ai/bolt/Automations');
export const layer = Layer.effect(Service, Effect.gen(function* () {
	const tasks = yield* Tasks.Service;
	const workspace = yield* Workspace.Service;
	const database = yield* Database.Service;
	const start = Effect.fn('Automations.start')(function* (effectId: EffectIdType, subject: Subject, name: string, input: Schema.Json) {
		yield* workspace.automation(name);
		yield* database.execute(effectId, {
			_tag: 'Query',
			sql: 'insert into bolt_automation_runs (effect_id, automation_name, state, input) values ($1, $2, $3, $4) on conflict (effect_id) do nothing',
			parameters: [effectId, name, 'queued', input]
		});
		// `bolt_run_as` is written here, at the runtime's own enqueue point, so the task the handler
		// later sees was stamped by this service — a caller's own `bolt_run_as` claim is overwritten,
		// never forwarded.
		const enqueued: Schema.Json = typeof input === 'object' && input !== null && !Array.isArray(input)
			? { ...(input as Readonly<Record<string, Schema.Json>>), bolt_run_as: subject }
			: { args: {}, bolt_run_as: subject };
		const response = yield* tasks.execute(EffectId.make(`${effectId}:start`), { _tag: 'Enqueue', command: `automations.${name}`, input: enqueued });
		const taskId = response.taskId ?? `${effectId}`;
		yield* database.execute(effectId, {
			_tag: 'Query',
			sql: 'update bolt_automation_runs set task_id = $2, state = $3 where effect_id = $1',
			parameters: [effectId, taskId, 'scheduled']
		});
		return taskId;
	});
	return Service.of({
		register: Effect.fn('Automations.register')(function* (name) {
			yield* workspace.automation(name);
		}),
		start,
		runStep: start,
		resume: Effect.fn('Automations.resume')(function* (effectId, taskId, input) {
			yield* tasks.execute(effectId, { _tag: 'Signal', taskId, signal: 'resume', input });
			yield* database.execute(effectId, { _tag: 'Query', sql: 'update bolt_automation_runs set state = $2 where task_id = $1', parameters: [taskId, 'resumed'] });
		}),
		status: Effect.fn('Automations.status')(function* (effectId, taskId) {
			return (yield* database.execute(effectId, { _tag: 'Query', sql: 'select state from bolt_automation_runs where task_id = $1', parameters: [taskId] })).rows[0];
		}),
		cancel: Effect.fn('Automations.cancel')(function* (effectId, taskId) {
			yield* tasks.execute(effectId, { _tag: 'Cancel', taskId });
			yield* database.execute(effectId, { _tag: 'Query', sql: 'update bolt_automation_runs set state = $2 where task_id = $1', parameters: [taskId, 'cancelled'] });
		})
	});
}));
export * as Automations from './automations.js';
