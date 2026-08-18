import { describe, expect, it } from 'vitest';
import { EnvironmentName, ReleaseId, TenantId } from '@norbital-ai/bolt-protocol';
import { createBoltClient } from '../../src/client.js';
import { createWorkspaceApiProxy, startBrowserReplica } from '../../src/client/runtime.js';

const scope = {
	tenantId: TenantId.make('tenant'),
	environment: EnvironmentName.make('test'),
	releaseId: ReleaseId.make('release')
};

describe('typed browser client', () => {
	it('makes reactive remote invocations awaitable while preserving the live handle', async () => {
		const commands: Array<string> = [];
		const bolt = createBoltClient(scope, {
			command: (command) => {
				commands.push(command);
				return Promise.resolve({ answer: 42 });
			}
		});
		const runtime = { bolt, db: {} };
		const proxy = createWorkspaceApiProxy(runtime);
		const query = proxy.invoke['forecast']?.({});
		expect(query?.loading).toBe(true);
		expect(await query).toEqual({ answer: 42 });
		expect(commands).toEqual(['invoke.forecast']);
	});

	it('loads collection tables through collections.findMany and starts the replica', async () => {
		const commands: Array<{ readonly command: string; readonly input: unknown }> = [];
		const bolt = createBoltClient(scope, {
			command: (command, input) => {
				commands.push({ command, input });
				if (command === 'collections.findMany') {
					// The shape the command boundary actually answers: one keyset page, not a bare array.
					return Promise.resolve({ rows: [{ norbital_id: 'e1', name: 'Ada' }], nextCursor: null });
				}
				return Promise.resolve({ xid: 1, sequence: 1 });
			}
		});
		const runtime = { bolt, db: {} };
		const proxy = createWorkspaceApiProxy(runtime);
		const employees = Reflect.get(proxy.db, 'employees') as
			{ findMany: (input?: object) => PromiseLike<unknown> } | undefined;
		const query = employees?.findMany({ limit: 20 });
		expect(proxy.collections['employees']?.name).toBe('employees');
		expect(await query).toEqual([{ norbital_id: 'e1', name: 'Ada' }]);
		// Starting the replica drains the outbox from the origin cursor; it no longer just reads head.
		const replica = await startBrowserReplica(runtime);
		expect(commands.map((entry) => entry.command)).toContain('collections.findMany');
		expect(commands.map((entry) => entry.command)).toContain('sync.diff');
		expect(commands.find((entry) => entry.command === 'sync.diff')?.input).toMatchObject({
			cursor: { xid: 0, sequence: 0 }
		});
		replica.stop();
		expect(commands.find((entry) => entry.command === 'collections.findMany')?.input).toMatchObject(
			{
				collection: 'employees',
				limit: 20
			}
		);
	});
});
