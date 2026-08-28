import { describe, expect, it, vi } from 'vitest';
import { EnvironmentName, ReleaseId, TenantId } from '@norbital-ai/bolt-protocol';
import { createBoltClient } from '../../src/client.js';
import {
	createWorkspaceApiProxy,
	type AutomationRun,
	type AutomationTaskSnapshot
} from '../../src/client/runtime.js';
import { createQueryCache } from '../../src/client/replica/query-cache.js';
import { createLiveQueryRegistry } from '../../src/client/replica/live-queries.js';

const scope = {
	tenantId: TenantId.make('tenant'),
	environment: EnvironmentName.make('test'),
	releaseId: ReleaseId.make('release')
};

type AutomationSurface = Readonly<{
	readonly run: (input: Record<string, unknown>) => Promise<AutomationRun>;
	readonly stop: (taskId: string) => Promise<void>;
	readonly resume: (taskId: string) => Promise<AutomationRun>;
	readonly pending: number;
	readonly latest: AutomationRun | undefined;
}>;

type AutomationRunRow = Readonly<{
	readonly task_id: string;
	readonly status: AutomationTaskSnapshot['status'];
	readonly attempts: number;
	readonly max_attempts: number;
	readonly error: string | null;
	readonly result: unknown;
	readonly progress: AutomationTaskSnapshot['progress'];
	readonly progress_sequence: number;
	readonly progress_updated_at: string | null;
	readonly next_run_at: string | null;
}>;

const runRow = (
	taskId: string,
	status: AutomationTaskSnapshot['status'] = 'pending'
): AutomationRunRow => ({
	task_id: taskId,
	status,
	attempts: 1,
	max_attempts: 12,
	error: null,
	result: status === 'done' ? { outcome: 'stitched' } : null,
	progress:
		status === 'done'
			? { progress: 1, text: 'Complete' }
			: { progress: 0.25, text: `Reading ${taskId}` },
	progress_sequence: status === 'done' ? 2 : 1,
	progress_updated_at: '2026-08-23T06:00:00.000Z',
	next_run_at: status === 'pending' || status === 'resuming' ? '2026-08-23T06:01:00.000Z' : null
});

const taskIdFrom = (input: unknown): string | undefined => {
	if (typeof input !== 'object' || input === null) return undefined;
	const where = Reflect.get(input, 'where');
	if (typeof where !== 'object' || where === null) return undefined;
	const task = Reflect.get(where, 'task_id');
	if (typeof task !== 'object' || task === null) return undefined;
	const id = Reflect.get(task, 'eq');
	return typeof id === 'string' ? id : undefined;
};

const pageFor = (row: AutomationRunRow | undefined) => ({
	rows: row === undefined ? [] : [row],
	lookahead: 0,
	nextCursor: null
});

describe('generated automation client state', () => {
	it('refreshes the authenticated automation_run query without a status command', async () => {
		let starts = 0;
		let reads = 0;
		const commands: Array<string> = [];
		const rows = new Map<string, AutomationRunRow>();
		const cache = createQueryCache('automation-client::live');
		const queries = createLiveQueryRegistry();
		const bolt = createBoltClient(scope, {
			command: (command, input) => {
				commands.push(command);
				if (command === 'automations.start') {
					const taskId = `run-${(starts += 1)}`;
					rows.set(taskId, runRow(taskId));
					return Promise.resolve({ taskId } as never);
				}
				if (command === 'collections.findMany') {
					reads += 1;
					const taskId = taskIdFrom(input);
					return Promise.resolve(
						pageFor(taskId === undefined ? undefined : rows.get(taskId)) as never
					);
				}
				throw new Error(`unexpected command ${command}`);
			}
		});
		const proxy = createWorkspaceApiProxy({ bolt, db: {}, cache, queries });
		const automation = Reflect.get(proxy.automations, 'rebuild') as AutomationSurface;

		const run = await automation.run({ project_id: 'project-1' });
		await vi.waitFor(() => expect(run.current?.progress?.text).toBe('Reading run-1'));
		expect(automation.pending).toBe(1);
		const readsBeforeChange = reads;

		rows.set('run-1', runRow('run-1', 'done'));
		// Force the same cache turn the active-run refresher schedules, without making this unit test
		// wait for wall-clock time.
		cache.invalidate(['automation_run']);
		queries.reexecuteAffected(['automation_run']);
		await vi.waitFor(() => expect(run.current?.status).toBe('done'));

		expect(reads).toBe(readsBeforeChange + 1);
		expect(automation.pending).toBe(0);
		expect(commands).not.toContain('automations.status');
		expect(Reflect.has(run, 'refresh')).toBe(false);
		expect(Reflect.has(run, 'settled')).toBe(false);
	});

	it('decodes the running queue state while an automation attempt is active', async () => {
		const taskId = 'run-active';
		const rows = new Map([[taskId, runRow(taskId, 'running')]]);
		const bolt = createBoltClient(scope, {
			command: (command, input) => {
				if (command === 'automations.resume') return Promise.resolve({ resumed: true } as never);
				if (command !== 'collections.findMany') throw new Error(`unexpected command ${command}`);
				const id = taskIdFrom(input);
				return Promise.resolve(
					pageFor(id === undefined ? undefined : rows.get(id)) as never
				);
			}
		});
		const proxy = createWorkspaceApiProxy({ bolt, db: {} });
		const automation = Reflect.get(proxy.automations, 'rebuild') as AutomationSurface;

		const run = await automation.resume(taskId);
		await vi.waitFor(() => expect(run.current?.status).toBe('running'));
		expect(run.error).toBeUndefined();
		expect(automation.pending).toBe(1);
	});

	it('stops and resumes the same durable row through its server-only query', async () => {
		const taskId = 'historical-task:start';
		const rows = new Map([[taskId, runRow(taskId, 'paused')]]);
		const cache = createQueryCache('automation-client::lifecycle');
		const queries = createLiveQueryRegistry();
		const lifecycle: Array<Readonly<{ command: string; input: unknown }>> = [];
		const bolt = createBoltClient(scope, {
			command: (command, input) => {
				if (command === 'collections.findMany') {
					const id = taskIdFrom(input);
					return Promise.resolve(
						pageFor(id === undefined ? undefined : rows.get(id)) as never
					);
				}
				if (command === 'automations.stop' || command === 'automations.resume') {
					lifecycle.push({ command, input });
					rows.set(taskId, runRow(taskId, command === 'automations.stop' ? 'paused' : 'resuming'));
					return Promise.resolve(
						(command === 'automations.stop' ? { stopped: true } : { resumed: true }) as never
					);
				}
				throw new Error(`unexpected command ${command}`);
			}
		});
		const proxy = createWorkspaceApiProxy({ bolt, db: {}, cache, queries });
		const automation = Reflect.get(proxy.automations, 'rebuild') as AutomationSurface;

		const run = await automation.resume(taskId);
		await vi.waitFor(() => expect(run.current?.status).toBe('resuming'));
		await run.stop();
		// The command mutates server state but does not imperatively rewrite or refresh client state.
		expect(run.current?.status).toBe('resuming');
		cache.invalidate(['automation_run']);
		queries.reexecuteAffected(['automation_run']);
		await vi.waitFor(() => expect(run.current?.status).toBe('paused'));

		expect(lifecycle).toEqual([
			{ command: 'automations.resume', input: { name: 'rebuild', taskId } },
			{ command: 'automations.stop', input: { name: 'rebuild', taskId } }
		]);
		expect(automation.latest).toBe(run);
	});
});
