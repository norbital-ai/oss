import { Effect, Exit, Layer, Option } from 'effect';
import { describe, expect, it } from 'vitest';
import {
	EffectId,
	EnvironmentName,
	Invocation,
	InvocationId,
	PROTOCOL_VERSION,
	ReleaseId,
	TenantId,
	type SyncChange,
	type TaskRequest
} from '@norbital-ai/bolt-protocol';
import * as Automations from '../src/runtime/automations/automations.js';
import { SyncCommit, Tasks } from '../src/runtime/facilities/services.js';
import * as Database from '../src/runtime/facilities/database.js';
import * as TaskQueue from '../src/runtime/tasks/tasks.js';
import * as Workspace from '../src/runtime/workspace.js';
import * as InvocationBudget from '../src/runtime/budget.js';
import * as TenantScope from '../src/runtime/tenant.js';
import { collection, field, workspace } from '../src/authoring/workspace-schema.js';
import { automation } from '../src/authoring/automations-schema.js';
import { makeBoltTestRuntime, testCallContext } from './support/bolt-test-layer.js';
import {
	afterMillisOf,
	emptyAuthoredRuntime,
	type RuntimeAuthoringApi
} from '../src/runtime/collections/authored.js';
import { dispatchInvocation } from '../src/runtime/dispatch.js';
import * as Collections from '../src/runtime/collections/collections.js';
import { adminSubject } from './support/bolt-test-layer.js';
import { seedSession } from './support/fixture-identity.js';

const scope = {
	tenantId: TenantId.make('test-tenant'),
	environment: EnvironmentName.make('development'),
	releaseId: ReleaseId.make('local')
};

const manualStart = (id: string, name: string, input: Readonly<Record<string, never>> = {}) =>
	Invocation.cases.Command.make({
		protocolVersion: PROTOCOL_VERSION,
		id: InvocationId.make(id),
		scope,
		deadlineEpochMs: Date.now() + 30_000,
		command: 'automations.start',
		input: { name, input },
		headers: { authorization: ['Bearer automation-test-token'] }
	});

const directDefinition = workspace({
	name: 'direct-automations',
	version: '1',
	collections: [],
	apps: [],
	policies: [],
	automations: ['parent', 'child', 'failure'].map((name) =>
		automation({
			name,
			trigger: { _tag: 'Manual' },
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

describe('Automations owner', () => {
	it('treats an omitted authored delay as immediately due', () => {
		expect(afterMillisOf(undefined)).toBe(0);
		expect(afterMillisOf('not a duration')).toBeUndefined();
	});

	it('admits an immediate command without waking the scheduler and rejects deferred work', async () => {
		const wakes: Array<TaskRequest> = [];
		const commits: Array<ReadonlyArray<SyncChange>> = [];
		const statements: Array<{ readonly sql: string; readonly parameters: ReadonlyArray<unknown> }> =
			[];
		const callContext = testCallContext('i1');
		const tasks = Tasks.layer(
			{
				call: (_metadata, input) => {
					wakes.push(input);
					return Promise.resolve({ _tag: 'Success', value: {} });
				}
			},
			callContext
		);
		const database = Database.layer(
			{
				call: (_metadata, request) => {
					const requests = request._tag === 'Query' ? [request] : request.statements;
					for (const statement of requests) {
						statements.push({ sql: statement.sql, parameters: statement.parameters });
					}
					return Promise.resolve({
						_tag: 'Success',
						value: {
							rows: requests.some(({ sql }) => sql.includes('returning "id"'))
								? [
										{
											id: '019f6f10-3000-7000-8000-000000000099',
											task_id: 'e1:start',
											name: 'daily',
											status: 'running'
										}
									]
								: [],
							affectedRows: 0
						}
					});
				}
			},
			callContext
		);
		const syncCommit = SyncCommit.layer(
			{
				call: (_metadata, request) => {
					commits.push(request.changes);
					return Promise.resolve({ _tag: 'Success', value: {} });
				}
			},
			callContext
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
		const taskQueue = TaskQueue.layer(callContext).pipe(
			Layer.provide(Layer.mergeAll(database, tasks))
		);
		const layer = Automations.layer.pipe(
			Layer.provide(
				Layer.mergeAll(
					taskQueue,
					database,
					registry,
					syncCommit,
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
				// Admission persists the lifecycle row, but the current request owns execution. There is
				// no timer hand-off to wait for and therefore no Wake for the immediate run.
				expect(wakes).toEqual([]);
				const deferred = yield* Effect.result(
					automations.start(
						EffectId.make('e2'),
						'daily',
						{ project_id: 'project-2', force: true },
						{ afterMillis: 5_000 }
					)
				);
				expect(deferred._tag).toBe('Failure');
				yield* automations.progress(EffectId.make('e1:progress'), taskId, {
					progress: 0.5,
					text: 'Halfway'
				});
				// Cron progress is projected from bolt_task by a trigger. That current-row projection cannot
				// prove an operation or old route, so it waits for Phase 5 central transition capture.
				yield* automations.progress(EffectId.make('cron:progress'), 'scheduled-task', {
					progress: 0.25,
					text: 'Scheduled progress'
				});
				return taskId;
			}).pipe(Effect.provide(layer))
		);
		// The id a caller gets back is the task's effect id, which is also its idempotency key — a
		// replayed start names the row the first one wrote rather than minting a second identity.
		expect(taskId).toBe('e1:start');
		expect(wakes).toEqual([]);
		expect(commits).toEqual([
			[
				{
					collection: 'automation_run',
					id: '019f6f10-3000-7000-8000-000000000099',
					operation: 'insert',
					after: { task_id: 'e1:start', name: 'daily', status: 'running' }
				}
			],
			[
				{
					collection: 'automation_run',
					id: '019f6f10-3000-7000-8000-000000000099',
					operation: 'update',
					before: { task_id: 'e1:start', name: 'daily', status: 'running' },
					after: { task_id: 'e1:start', name: 'daily', status: 'running' }
				}
			]
		]);
		const insert = statements.find(
			(statement) =>
				statement.sql.includes('insert into "automation_run"') ||
				statement.sql.includes('insert into automation_run')
		);
		expect(insert).toBeDefined();
		expect(insert?.parameters).toContain('e1:start');
		expect(insert?.parameters).toContain('daily');
		const progress = statements.find(
			(statement) =>
				statement.sql.startsWith('update "automation_run" set') &&
				statement.sql.includes('"progress_sequence"')
		);
		expect(progress?.parameters).toEqual([
			1,
			JSON.stringify({ progress: 0.5, text: 'Halfway' }),
			1,
			'e1:start',
			'running'
		]);
		expect(progress?.sql).toContain('"updated_at" = now()');
		expect(progress?.sql).toContain('"row_version" = "automation_run"."row_version" +');
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
		const taskQueue = TaskQueue.layer(testCallContext('i1')).pipe(
			Layer.provide(Layer.mergeAll(database, tasks))
		);
		const layer = Automations.layer.pipe(
			Layer.provide(
				Layer.mergeAll(
					taskQueue,
					database,
					registry,
					SyncCommit.layer(undefined, testCallContext('i1')),
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
		// The check runs before anything is written, so a chain that has gone too deep leaves no
		// observable automation row behind.
		expect(statements.filter((sql) => sql.includes('automation_run'))).toHaveLength(0);
	});

	it('runs a manual automation and its immediate child in the admitting request', async () => {
		const observedChildContexts: Array<unknown> = [];
		const authored = {
			...emptyAuthoredRuntime,
			automations: {
				parent: {
					name: 'parent',
					policies: [],
					trigger: { _tag: 'Manual' as const },
					handler: (api: unknown) =>
						Effect.gen(function* () {
							const child = yield* (api as RuntimeAuthoringApi).automations.run('child', {
								from: 'parent'
							});
							return { parent: true, childTaskId: child.taskId };
						})
				},
				child: {
					name: 'child',
					policies: [],
					trigger: { _tag: 'Manual' as const },
					handler: (_api: unknown, context: unknown) => {
						observedChildContexts.push(context);
						return { child: true };
					}
				}
			}
		};
		const harness = await makeBoltTestRuntime(directDefinition, { authored });
		try {
			await seedSession(harness, {
				token: 'automation-test-token',
				user: 'automation-runner'
			});
			harness.tasks.forget();

			const response = await harness.runtime.runPromise(
				dispatchInvocation(manualStart('manual-parent', 'parent'))
			);

			expect(response.value).toMatchObject({
				taskId: 'manual-parent:start',
				result: { parent: true, childTaskId: expect.any(String) }
			});
			expect(observedChildContexts).toEqual([{ args: { from: 'parent' }, scope: {} }]);
			// The request owns both bodies. The host only receives in-memory interruption handles for
			// them; handing either run to the timer would add a Wake to this sequence.
			expect(harness.tasks.requests.map((request) => request._tag)).toEqual([
				'Active',
				'Active',
				'Settled',
				'Settled'
			]);
			expect(harness.tasks.requests.some((request) => request._tag === 'Wake')).toBe(false);

			const runs = await harness.database.query(
				`select name, status, result, error, row_version
				 from automation_run where name in ('parent', 'child')
				 order by name`
			);
			expect(runs).toHaveLength(2);
			expect(
				runs.map((run) => ({
					name: run['name'],
					status: run['status'],
					error: run['error'],
					rowVersion: run['row_version']
				}))
			).toEqual([
				{ name: 'child', status: 'done', error: null, rowVersion: 2 },
				{ name: 'parent', status: 'done', error: null, rowVersion: 2 }
			]);
		} finally {
			await harness.dispose();
		}
	}, 60_000);

	it('settles a direct automation failure without retrying or waking a scheduler', async () => {
		const authored = {
			...emptyAuthoredRuntime,
			automations: {
				failure: {
					name: 'failure',
					policies: [],
					trigger: { _tag: 'Manual' as const },
					handler: () => Effect.fail(new Error('manual automation failed'))
				}
			}
		};
		const harness = await makeBoltTestRuntime(directDefinition, { authored });
		try {
			await seedSession(harness, {
				token: 'automation-test-token',
				user: 'automation-runner'
			});
			harness.tasks.forget();

			const outcome = await harness.runtime.runPromise(
				dispatchInvocation(manualStart('manual-failure', 'failure')).pipe(Effect.result)
			);
			expect(outcome._tag).toBe('Failure');
			expect(harness.tasks.requests.map((request) => request._tag)).toEqual(['Active', 'Settled']);
			expect(harness.tasks.requests.some((request) => request._tag === 'Wake')).toBe(false);

			const [run] = await harness.database.query(
				`select status, error from automation_run
				 where name = 'failure'`
			);
			expect(run).toMatchObject({ status: 'failed' });
			expect(String(run?.['error'])).toContain('manual automation failed');
		} finally {
			await harness.dispose();
		}
	}, 60_000);

	it('executes a change-triggered automation directly after the triggering write', async () => {
		const definition = workspace({
			name: 'change-automation',
			version: '1',
			collections: [
				collection({ name: 'notes', fields: { body: field.string({ required: true }) } })
			],
			apps: [],
			policies: [],
			automations: [
				automation({
					name: 'on_note',
					trigger: { _tag: 'Change', collection: 'notes', event: 'created' },
					command: 'on_note',
					policies: []
				})
			],
			integrations: [],
			prompt: 'You are the test workspace agent.',
			tools: [],
			skills: [],
			envoys: [],
			requiredFacilities: []
		});
		const observed: Array<unknown> = [];
		const authored = {
			...emptyAuthoredRuntime,
			automations: {
				on_note: {
					name: 'on_note',
					policies: [],
					trigger: { _tag: 'Change' as const, collection: 'notes', event: 'created' as const },
					handler: (_api: unknown, context: unknown) => {
						observed.push(context);
						return { observed: true };
					}
				}
			}
		};
		const harness = await makeBoltTestRuntime(definition, { authored });
		try {
			harness.tasks.forget();
			await harness.runtime.runPromise(
				Effect.gen(function* () {
					yield* (yield* Collections.Service).mutate(
						EffectId.make('create-note'),
						adminSubject,
						'notes',
						[{ id: '10000000-0000-4000-8000-000000000001', body: 'direct trigger' }],
						false,
						0,
						{
							root: { id: '10000000-0000-4000-8000-000000000001', action: 'create' }
						}
					);
				})
			);

			expect(observed).toEqual([
				{
					args: {},
					scope: { incoming_record: expect.objectContaining({ body: 'direct trigger' }) }
				}
			]);
			expect(harness.tasks.requests.map((request) => request._tag)).toEqual(['Active', 'Settled']);
			expect(harness.tasks.requests.some((request) => request._tag === 'Wake')).toBe(false);
			expect(
				await harness.database.query(`select status from automation_run where name = 'on_note'`)
			).toEqual([{ status: 'done' }]);
		} finally {
			await harness.dispose();
		}
	}, 60_000);

	it('fails direct runs but recovers an expired durable cron claim at the environment-load gate', async () => {
		const harness = await makeBoltTestRuntime(directDefinition);
		try {
			await harness.database.query(
				`insert into automation_run (task_id, name, status) values
					('direct-running', 'parent', 'running')`
			);
			await harness.database.query(
				`insert into bolt_task
					(command, input, effect_id, status, attempts, lease_expires_at) values
					('automations.child', '{}', 'cron-running', 'running', 1, now() - interval '1 second')`
			);
			await harness.runtime.runPromise(
				Effect.gen(function* () {
					yield* (yield* TaskQueue.Service).recover(EffectId.make('cron-recovery'));
					yield* (yield* Automations.Service).recover(EffectId.make('environment-recovery'));
				})
			);
			expect(
				await harness.database.query(
					`select task_id, status, error from automation_run
					 where task_id in ('direct-running', 'cron-running') order by task_id`
				)
			).toEqual([
				{
					task_id: 'cron-running',
					status: 'pending',
					error: 'host interrupted previous attempt'
				},
				{ task_id: 'direct-running', status: 'failed', error: 'host restarted during run' }
			]);
		} finally {
			await harness.dispose();
		}
	}, 60_000);

	it('stops only the exact pending occurrence owned by the named automation', async () => {
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
					('automations.weekly', '{}', 'weekly-run')`
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
				{ effect_id: 'daily-run', status: 'stopped', error: 'stopped' },
				{ effect_id: 'weekly-run', status: 'pending', error: null }
			]);
			expect(
				await harness.database.query(
					"select task_id, status from automation_run where task_id = 'daily-run'"
				)
			).toEqual([{ task_id: 'daily-run', status: 'stopped' }]);
		} finally {
			await harness.dispose();
		}
	}, 60_000);
});
