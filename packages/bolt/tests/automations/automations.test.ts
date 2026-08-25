import { Effect, Exit, Layer, Option } from 'effect';
import { describe, expect, it } from 'vitest';
import { EffectId, type TaskRequest } from '@norbital-ai/bolt-protocol';
import * as Automations from '../../src/runtime/automations/automations.js';
import { Tasks, Transport } from '../../src/runtime/facilities/services.js';
import * as Database from '../../src/runtime/facilities/database.js';
import * as TaskQueue from '../../src/runtime/tasks/tasks.js';
import * as SyncWake from '../../src/runtime/sync/wake.js';
import * as Workspace from '../../src/runtime/workspace.js';
import * as InvocationBudget from '../../src/runtime/budget.js';
import * as TenantScope from '../../src/runtime/tenant.js';
import { workspace } from '../../src/authoring/workspace-schema.js';
import { automation } from '../../src/authoring/automations-schema.js';
import { makeBoltTestRuntime, testCallContext } from '../support/bolt-test-layer.js';
import { afterMillisOf } from '../../src/runtime/collections/authored.js';

describe('Automations owner', () => {
	it('treats an omitted authored delay as immediately due', () => {
		expect(afterMillisOf(undefined)).toBe(0);
		expect(afterMillisOf('not a duration')).toBeUndefined();
	});

	it('enqueues a stable authored command', async () => {
		const wakes: Array<TaskRequest> = [];
		const statements: Array<{ readonly sql: string; readonly parameters: ReadonlyArray<unknown> }> =
			[];
		const tasks = Tasks.layer(
			{
				call: (_metadata, input) => {
					wakes.push(input);
					return Promise.resolve({ _tag: 'Success', value: {} });
				}
			},
			testCallContext('i1')
		);
		const database = Database.layer(
			{
				call: (_metadata, request) => {
					if (request._tag === 'Query')
						statements.push({ sql: request.sql, parameters: request.parameters });
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
				automations: [
					automation({
						name: 'daily',
						trigger: { _tag: 'Schedule', cron: '* * * * *' },
						command: 'daily',
						policies: ['admin']
					})
				],
				integrations: [],
				prompt: 'You are the test workspace agent.',
				tools: [],
				skills: [],
				envoys: [],
				requiredFacilities: []
			})
		);
		// Depth zero: this suite drives `start` directly, which is what a person or a schedule does.
		// Provided explicitly rather than defaulted, because the depth is the thing that decides
		// whether an enqueue is admitted at all — a service that silently read a stand-in would let
		// the case below pass against a limiter that was never consulted.
		const wake = SyncWake.layer.pipe(
			Layer.provide(Transport.layer(undefined, testCallContext('i1')))
		);
		const taskQueue = TaskQueue.layer(testCallContext('i1')).pipe(
			Layer.provide(Layer.mergeAll(database, tasks, wake))
		);
		const layer = Automations.layer.pipe(
			Layer.provide(
				Layer.mergeAll(
					taskQueue,
					registry,
					InvocationBudget.layer(0),
					TenantScope.layer('test-tenant')
				)
			)
		);
		const taskId = await Effect.runPromise(
			Effect.gen(function* () {
				const automations = yield* Automations.Service;
				const taskId = yield* automations.start(EffectId.make('e1'), 'daily', {
					project_id: 'project-1',
					force: false
				});
				yield* automations.progress(EffectId.make('e1:progress'), taskId, {
					progress: 0.5,
					text: 'Halfway'
				});
				return taskId;
			}).pipe(Effect.provide(layer))
		);
		// The id a caller gets back is the task's effect id, which is also its idempotency key — a
		// replayed start names the row the first one wrote rather than minting a second identity.
		expect(taskId).toBe('e1:start');
		// The host is told to come back before the row is committed, so a crash between the two costs
		// a false alarm rather than a job nobody ever wakes.
		expect(wakes).toEqual([{ _tag: 'Wake', notLaterThanEpochMs: expect.any(Number) }]);
		const insert = statements.find((statement) => statement.sql.includes('bolt_task'));
		expect(insert).toBeDefined();
		expect(insert?.parameters[0]).toBe('automations.daily');
		// The depth the child will run at rides the payload beside `bolt_run_as`, stamped by this
		// service and never read from what the caller passed. Without it a chain of automations that
		// each write has nothing counting it: every link is a fresh invocation with a fresh
		// deadline, so no wall-clock bound can see the chain at all.
		//
		// `bolt_run_as` is the *automation's own* subject, minted here from what it declares. It is not
		// the caller's, and there is no longer a caller's to be: `start` takes no subject at all. The
		// same automation used to run as an administrator whenever an administrator happened to trip
		// it, over every row in the workspace, on a schedule.
		expect(JSON.parse(String(insert?.parameters[1]))).toMatchObject({
			args: { project_id: 'project-1', force: false },
			bolt_run_as: {
				userId: 'automation:daily',
				tenantId: 'test-tenant',
				teamPath: [],
				policies: ['admin'],
				admin: false
			},
			bolt_depth: 1
		});
		const progress = statements.find(
			(statement) =>
				statement.sql.startsWith('update "bolt_task" set') &&
				statement.sql.includes('"progress_sequence"')
		);
		expect(progress?.parameters).toEqual([
			JSON.stringify({ progress: 0.5, text: 'Halfway' }),
			1,
			'e1:start',
			'running',
			'automations.%'
		]);
	});

	it('refuses to enqueue past the nesting limit, before it writes a run row', async () => {
		const wakes: Array<TaskRequest> = [];
		const statements: Array<string> = [];
		const tasks = Tasks.layer(
			{
				call: (_metadata, input) => {
					wakes.push(input);
					return Promise.resolve({ _tag: 'Success', value: {} });
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
				automations: [
					automation({
						name: 'daily',
						trigger: { _tag: 'Schedule', cron: '* * * * *' },
						command: 'daily',
						policies: ['admin']
					})
				],
				integrations: [],
				prompt: 'You are the test workspace agent.',
				tools: [],
				skills: [],
				envoys: [],
				requiredFacilities: []
			})
		);
		// Already at the limit, which is the state a chain of automations reaches by writing.
		const wake = SyncWake.layer.pipe(
			Layer.provide(Transport.layer(undefined, testCallContext('i1')))
		);
		const taskQueue = TaskQueue.layer(testCallContext('i1')).pipe(
			Layer.provide(Layer.mergeAll(database, tasks, wake))
		);
		const layer = Automations.layer.pipe(
			Layer.provide(
				Layer.mergeAll(
					taskQueue,
					registry,
					InvocationBudget.layer(InvocationBudget.DEFAULT_NESTING_LIMIT),
					TenantScope.layer('test-tenant')
				)
			)
		);
		const outcome = await Effect.runPromiseExit(
			Effect.gen(function* () {
				return yield* (yield* Automations.Service).start(EffectId.make('e1'), 'daily', {});
			}).pipe(Effect.provide(layer))
		);
		const failure = Option.getOrUndefined(Exit.findErrorOption(outcome));
		expect(failure).toBeInstanceOf(InvocationBudget.NestingLimitExceeded);
		expect(wakes).toHaveLength(0);
		// The half that makes the refusal worth having. The check runs before anything is written,
		// so a chain that has gone too deep leaves no `bolt_task` row behind that nothing will ever
		// move off `pending` — a queued automation that can never run is exactly the orphan this
		// whole pass exists to stop producing.
		expect(statements.filter((sql) => sql.includes('bolt_task'))).toHaveLength(0);
	});

	it('stops and resumes only the same task owned by the named automation', async () => {
		const definition = workspace({
			name: 'cancellation-scope',
			version: '1',
			collections: [],
			apps: [],
			policies: [],
			automations: ['daily', 'weekly'].map((name) =>
				automation({
					name,
					trigger: { _tag: 'Schedule', cron: '* * * * *' },
					command: name,
					policies: []
				})
			),
			integrations: [],
			prompt: 'You are the test workspace agent.',
			tools: [],
			skills: [],
			envoys: [],
			requiredFacilities: []
		});
		const harness = await makeBoltTestRuntime(definition);
		try {
			await harness.database.query(
				`insert into bolt_task (command, input, effect_id) values
					('automations.daily', '{}', 'daily-run'),
					('automations.weekly', '{}', 'weekly-run'),
					('integrations.flush', '{}', 'integration-run')`
			);
			expect(
				await harness.database.query(
					'select task_id, name, status from automation_run order by task_id'
				)
			).toEqual([
				{ task_id: 'daily-run', name: 'daily', status: 'pending' },
				{ task_id: 'weekly-run', name: 'weekly', status: 'pending' }
			]);

			const outcome = await harness.runtime.runPromise(
				Effect.gen(function* () {
					const automations = yield* Automations.Service;
					// A valid but different automation name cannot stop this id.
					yield* automations.stop(EffectId.make('cross-stop'), 'daily', 'weekly-run');
					// Nor can an automation lifecycle action reach a task outside its exact command.
					yield* automations.stop(EffectId.make('foreign-stop'), 'daily', 'integration-run');
					const unknown = yield* Effect.result(
						automations.stop(EffectId.make('unknown-stop'), 'unknown', 'daily-run')
					);
					yield* automations.stop(EffectId.make('daily-stop'), 'daily', 'daily-run');
					return unknown;
				})
			);

			expect(outcome._tag).toBe('Failure');
			expect(
				await harness.database.query(
					'select effect_id, status, error from bolt_task order by effect_id'
				)
			).toEqual([
				{ effect_id: 'daily-run', status: 'paused', error: null },
				{ effect_id: 'integration-run', status: 'pending', error: null },
				{ effect_id: 'weekly-run', status: 'pending', error: null }
			]);
			expect(
				await harness.database.query(
					"select task_id, status from automation_run where task_id = 'daily-run'"
				)
			).toEqual([{ task_id: 'daily-run', status: 'paused' }]);

			await harness.runtime.runPromise(
				Effect.gen(function* () {
					yield* (yield* Automations.Service).resume(
						EffectId.make('daily-resume'),
						'daily',
						'daily-run'
					);
				})
			);
			expect(
				await harness.database.query(
					"select effect_id, status from bolt_task where effect_id = 'daily-run'"
				)
			).toEqual([{ effect_id: 'daily-run', status: 'resuming' }]);
			expect(
				await harness.database.query(
					"select task_id, status from automation_run where task_id = 'daily-run'"
				)
			).toEqual([{ task_id: 'daily-run', status: 'resuming' }]);
		} finally {
			await harness.dispose();
		}
	}, 60_000);
});
