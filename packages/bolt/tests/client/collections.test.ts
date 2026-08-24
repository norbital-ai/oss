import { describe, expect, it } from 'vitest';
import { Schema } from 'effect';
import { EnvironmentName, ReleaseId, TenantId } from '@norbital-ai/bolt-protocol';
import { createBoltClient } from '../../src/client.js';
import { createWorkspaceApiProxy } from '../../src/client/runtime.js';

const scope = {
	tenantId: TenantId.make('tenant'),
	environment: EnvironmentName.make('test'),
	releaseId: ReleaseId.make('release')
};

describe('typed browser client', () => {
	it('preserves the actionable transport failure through both client boundaries', async () => {
		const failure = new Error('invalid_input: employees.created_at is managed by Bolt');
		const bolt = createBoltClient(scope, { command: () => Promise.reject(failure) });

		await expect(bolt.command('collections.mutate', {}, Schema.Json)).rejects.toBe(failure);

		const proxy = createWorkspaceApiProxy({ bolt, db: {} });
		const employees = Reflect.get(proxy.db, 'employees') as {
			mutate: (input: object) => Promise<void>;
		};
		await expect(employees.mutate({ id: 'employee-1', name: 'Updated' })).rejects.toBe(failure);
	});

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

	it('loads collection tables through collections.findMany', async () => {
		const commands: Array<{ readonly command: string; readonly input: unknown }> = [];
		const bolt = createBoltClient(scope, {
			command: (command, input) => {
				commands.push({ command, input });
				if (command === 'collections.findMany') {
					// The shape the command boundary actually answers: one keyset page, not a bare array.
					return Promise.resolve({ rows: [{ id: 'e1', name: 'Ada' }], nextCursor: null });
				}
				return Promise.resolve({ xid: 1, sequence: 1 });
			}
		});
		const runtime = { bolt, db: {} };
		const proxy = createWorkspaceApiProxy(runtime);
		const employees = Reflect.get(proxy.db, 'employees') as
			{ findMany: (input?: object) => PromiseLike<unknown> } | undefined;
		const query = employees?.findMany({ limit: 20, after: undefined });
		expect(proxy.collections['employees']?.name).toBe('employees');
		expect(await query).toEqual([{ id: 'e1', name: 'Ada' }]);
		expect(commands.map((entry) => entry.command)).toContain('collections.findMany');
		expect(commands.find((entry) => entry.command === 'collections.findMany')?.input).toMatchObject(
			{
				collection: 'employees',
				limit: 20
			}
		);
		expect(
			commands.find((entry) => entry.command === 'collections.findMany')?.input
		).not.toHaveProperty('after');
	});

	it('groups a board query through the canonical collection read', async () => {
		const commands: Array<{ readonly command: string; readonly input: unknown }> = [];
		const bolt = createBoltClient(scope, {
			command: (command, input) => {
				commands.push({ command, input });
				return Promise.resolve({
					rows: [
						{ id: 'e1', status: 'active' },
						{ id: 'e2', status: 'active' },
						{ id: 'e3', status: 'closed' }
					],
					nextCursor: null
				});
			}
		});
		const proxy = createWorkspaceApiProxy({ bolt, db: {} });
		const employees = Reflect.get(proxy.db, 'employees') as {
			findGrouped: (input: object) => PromiseLike<unknown>;
		};

		await expect(
			employees.findGrouped({
				where: { archived: { eq: false } },
				group: { by: 'status', lanes: ['active', 'pending', 'closed'] }
			})
		).resolves.toEqual({
			active: [
				{ id: 'e1', status: 'active' },
				{ id: 'e2', status: 'active' }
			],
			pending: [],
			closed: [{ id: 'e3', status: 'closed' }]
		});
		expect(commands).toEqual([
			{
				command: 'collections.findMany',
				input: {
					collection: 'employees',
					where: { archived: { eq: false } },
					limit: 500
				}
			}
		]);
	});

	it('loads an approval request by id instead of mistaking timeline events for request rows', async () => {
		const commands: Array<{ readonly command: string; readonly input: unknown }> = [];
		const bolt = createBoltClient(scope, {
			command: (command, input) => {
				commands.push({ command, input });
				return Promise.resolve([
					{
						id: 'request-1',
						status: 'ONGOING',
						canDecide: false,
						canSupersede: false,
						canWithdraw: true
					}
				]);
			}
		});
		const proxy = createWorkspaceApiProxy({ bolt, db: {} });

		expect(await proxy.approvals.findMany('request-1')).toEqual([
			{
				id: 'request-1',
				status: 'ONGOING',
				canDecide: false,
				canSupersede: false,
				canWithdraw: true
			}
		]);
		expect(commands).toEqual([
			{
				command: 'approvals.capabilities',
				input: { requestId: 'request-1' }
			}
		]);
	});

	it('sends request-for-change as a distinct approval decision', async () => {
		const commands: Array<{ readonly command: string; readonly input: unknown }> = [];
		const bolt = createBoltClient(scope, {
			command: (command, input) => {
				commands.push({ command, input });
				if (command === 'approvals.status') {
					return Promise.resolve({
						_tag: 'Pending',
						requestId: 'request-1',
						step: 0,
						operation: { collection: 'orders' }
					});
				}
				return Promise.resolve({});
			}
		});
		const proxy = createWorkspaceApiProxy({ bolt, db: {} });

		await proxy.approvals.process({
			approvalRequestId: 'request-1',
			action: 'REQUEST_FOR_CHANGE',
			comments: 'Attach the supporting document.'
		});

		expect(commands).toEqual([
			{ command: 'approvals.status', input: { requestId: 'request-1' } },
			{
				command: 'approvals.decide',
				input: {
					state: {
						_tag: 'Pending',
						requestId: 'request-1',
						step: 0,
						operation: { collection: 'orders' }
					},
					decision: 'request_changes',
					reason: 'Attach the supporting document.'
				}
			}
		]);
	});
});
