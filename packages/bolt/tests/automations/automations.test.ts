import { Effect, Layer } from 'effect';
import { describe, expect, it } from 'vitest';
import { EffectId, InvocationId, type TaskRequest } from '@norbital-ai/bolt-protocol';
import { Automations } from '../../src/runtime/automations/automations.js';
import { Tasks } from '../../src/runtime/facilities/services.js';
import { Database } from '../../src/runtime/facilities/database.js';
import { Workspace } from '../../src/runtime/workspace.js';
import { automation, workspace } from '../../src/authoring/index.js';
import { adminSubject } from '../support/bolt-test-layer.js';

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
			{ invocationId: InvocationId.make('i1'), deadlineEpochMs: Date.now() + 1000 }
		);
		const database = Database.layer(
			{ call: () => Promise.resolve({ _tag: 'Success', value: { rows: [], affectedRows: 0 } }) },
			{ invocationId: InvocationId.make('i1'), deadlineEpochMs: Date.now() + 1000 }
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
		const layer = Automations.layer.pipe(Layer.provide(Layer.mergeAll(tasks, database, registry)));
		const taskId = await Effect.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Automations.Service).start(EffectId.make('e1'), adminSubject, 'daily', {});
			}).pipe(Effect.provide(layer))
		);
		expect(taskId).toBe('task-1');
		expect(requests[0]).toMatchObject({ _tag: 'Enqueue', command: 'automations.daily' });
	});
});
