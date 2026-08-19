import { Effect, Exit, Layer, Option } from 'effect';
import { describe, expect, it } from 'vitest';
import { EffectId, type TaskRequest } from '@norbital-ai/bolt-protocol';
import { Automations } from '../../src/runtime/automations/automations.js';
import { Tasks } from '../../src/runtime/facilities/services.js';
import { Database } from '../../src/runtime/facilities/database.js';
import { Workspace } from '../../src/runtime/workspace.js';
import { InvocationBudget } from '../../src/runtime/budget.js';
import { automation, workspace } from '../../src/authoring/index.js';
import { adminSubject, testCallContext } from '../support/bolt-test-layer.js';

describe('Automations owner', () => {
	it('enqueues a stable authored command', async () => {
		const requests: Array<TaskRequest> = [];
		const tasks = Tasks.layer(
			{
				call: (_metadata, input) => {
					requests.push(input);
					return Promise.resolve({ _tag: 'Success', value: { taskId: 'task-1' } });
				}
			},
			testCallContext('i1')
		);
		const database = Database.layer(
			{ call: () => Promise.resolve({ _tag: 'Success', value: { rows: [], affectedRows: 0 } }) },
			testCallContext('i1')
		);
		const registry = Workspace.layer(
			workspace({
				name: 'x',
				version: '1',
				collections: [],
				apps: [],
				policies: [],
				agents: [],
				automations: [
					automation({
						name: 'daily',
						trigger: { _tag: 'Schedule', cron: '* * * * *' },
						command: 'daily'
					})
				],
				channels: [],
				integrations: [],
				requiredFacilities: []
			})
		);
		// Depth zero: this suite drives `start` directly, which is what a person or a schedule does.
		// Provided explicitly rather than defaulted, because the depth is the thing that decides
		// whether an enqueue is admitted at all — a service that silently read a stand-in would let
		// the case below pass against a limiter that was never consulted.
		const layer = Automations.layer.pipe(
			Layer.provide(Layer.mergeAll(tasks, database, registry, InvocationBudget.layer(0)))
		);
		const taskId = await Effect.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Automations.Service).start(
					EffectId.make('e1'),
					adminSubject,
					'daily',
					{}
				);
			}).pipe(Effect.provide(layer))
		);
		expect(taskId).toBe('task-1');
		expect(requests[0]).toMatchObject({ _tag: 'Enqueue', command: 'automations.daily' });
		// The depth the child will run at rides the payload beside `bolt_run_as`, stamped by this
		// service and never read from what the caller passed. Without it a chain of automations that
		// each write has nothing counting it: every link is a fresh invocation with a fresh
		// deadline, so no wall-clock bound can see the chain at all.
		expect(requests[0]).toMatchObject({ input: { bolt_depth: 1 } });
	});

	it('refuses to enqueue past the nesting limit, before it writes a run row', async () => {
		const requests: Array<TaskRequest> = [];
		const statements: Array<string> = [];
		const tasks = Tasks.layer(
			{
				call: (_metadata, input) => {
					requests.push(input);
					return Promise.resolve({ _tag: 'Success', value: { taskId: 'task-1' } });
				}
			},
			testCallContext('i1')
		);
		const database = Database.layer(
			{
				call: (_metadata, request) => {
					if (request._tag === 'Query') statements.push(request.sql);
					return Promise.resolve({ _tag: 'Success', value: { rows: [], affectedRows: 0 } });
				}
			},
			testCallContext('i1')
		);
		const registry = Workspace.layer(
			workspace({
				name: 'x',
				version: '1',
				collections: [],
				apps: [],
				policies: [],
				agents: [],
				automations: [
					automation({
						name: 'daily',
						trigger: { _tag: 'Schedule', cron: '* * * * *' },
						command: 'daily'
					})
				],
				channels: [],
				integrations: [],
				requiredFacilities: []
			})
		);
		// Already at the limit, which is the state a chain of automations reaches by writing.
		const layer = Automations.layer.pipe(
			Layer.provide(
				Layer.mergeAll(
					tasks,
					database,
					registry,
					InvocationBudget.layer(InvocationBudget.DEFAULT_NESTING_LIMIT)
				)
			)
		);
		const outcome = await Effect.runPromiseExit(
			Effect.gen(function* () {
				return yield* (yield* Automations.Service).start(
					EffectId.make('e1'),
					adminSubject,
					'daily',
					{}
				);
			}).pipe(Effect.provide(layer))
		);
		const failure = Option.getOrUndefined(Exit.findErrorOption(outcome));
		expect(failure).toBeInstanceOf(InvocationBudget.NestingLimitExceeded);
		expect(requests).toHaveLength(0);
		// The half that makes the refusal worth having. The check runs before the run row is
		// written, so a chain that has gone too deep leaves nothing behind — a `queued`
		// `bolt_automation_runs` row that nothing will ever move off `queued` is exactly the
		// orphan this whole pass exists to stop producing.
		expect(statements.filter((sql) => sql.includes('bolt_automation_runs'))).toHaveLength(0);
	});
});
