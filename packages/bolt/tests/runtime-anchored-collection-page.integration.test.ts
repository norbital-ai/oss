import { Effect } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import {
	EnvironmentName,
	FixedCommandCatalogue,
	Invocation,
	InvocationId,
	PROTOCOL_VERSION,
	ReleaseId,
	TenantId,
	type SyncQueryInput
} from '@norbital-ai/bolt-protocol';
import { collection, field, policy, workspace } from '../src/authoring/workspace-schema.js';
import { createBoltClient } from '../src/client.js';
import type { WorkspaceClientRuntime } from '../src/client/contracts.js';
import { stableKey } from '../src/client/live-query/stable-key.js';
import { createWorkspaceApiProxy } from '../src/client/runtime.js';
import { initialClientState } from '../src/client/sync/machine.js';
import type { SyncClient } from '../src/client/sync/client.js';
import { FixedCommandBindings } from '../src/runtime/commands.js';
import { dispatchInvocation } from '../src/runtime/dispatch.js';
import { makeBoltTestRuntime, recordId, type BoltTestRuntime } from './support/bolt-test-layer.js';
import { seedSession } from './support/fixture-identity.js';

const scope = {
	tenantId: TenantId.make('test-tenant'),
	environment: EnvironmentName.make('development'),
	releaseId: ReleaseId.make('local')
};

const peopleWorkspace = workspace({
	name: 'test-workspace',
	version: '1',
	collections: [collection({ name: 'people', fields: { name: field.string({ required: true }) } })],
	apps: [],
	policies: [
		policy({ name: 'admin', effect: 'allow', actions: ['*'], capabilities: { apps: ['*'] } })
	],
	teams: { admin: ['admin'] },
	automations: [],
	envoys: [],
	integrations: [],
	prompt: 'You are the test workspace agent.',
	tools: [],
	skills: [],
	requiredFacilities: []
});

const command = (name: string, input: unknown) =>
	Invocation.cases.Command.make({
		protocolVersion: PROTOCOL_VERSION,
		id: InvocationId.make(`command-${name}-${crypto.randomUUID()}`),
		scope,
		deadlineEpochMs: Date.now() + 30_000,
		command: name,
		input: input as never,
		headers: { authorization: ['Bearer admin-token'] }
	});

const inertSync = (): SyncClient => ({
	start: () => undefined,
	attach: () => () => undefined,
	shutdown: () => undefined,
	current: () => initialClientState(),
	subscribe: () => () => undefined,
	mount: (input: SyncQueryInput) => ({
		key: stableKey(input),
		extend: () => undefined,
		detach: () => undefined
	}),
	enqueue: () => undefined
});

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

describe('anchored collection page command', () => {
	it('pages a findMany after cursor through the declared command, not a live prefix', async () => {
		harness = await makeBoltTestRuntime(peopleWorkspace);
		await harness.database.query(
			'insert into people (id, name) values ($1, $2), ($3, $4), ($5, $6)',
			[recordId('person-ada'), 'Ada', recordId('person-bea'), 'Bea', recordId('person-cam'), 'Cam']
		);
		await seedSession(harness, { token: 'admin-token', user: 'user-admin-token', team: 'admin' });

		const posted: Array<string> = [];
		const mounted: Array<unknown> = [];
		const bolt = createBoltClient(scope, {
			command: async (name, input) => {
				posted.push(name);
				const response = await harness!.runtime.runPromise(
					dispatchInvocation(command(name, input))
				);
				return response.value;
			}
		});
		const baseSync = inertSync();
		const sync: SyncClient = {
			...baseSync,
			mount: (input) => {
				mounted.push(input);
				return baseSync.mount(input);
			}
		};
		const runtime: WorkspaceClientRuntime = {
			bolt,
			db: {},
			sync,
			mutation: { partitionKey: 'test-partition', schemaFingerprint: 'sha256:test' },
			syncStatus: initialClientState(),
			settlements: {
				create: (idempotencyKey) => ({
					idempotencyKey,
					settled: new Promise(() => undefined),
					status: async () => 'unknown',
					wait: () => new Promise(() => undefined)
				}),
				accept: () => undefined
			}
		};
		const proxy = createWorkspaceApiProxy(runtime);
		const people = Reflect.get(proxy.db, 'people') as {
			findMany: (input?: object) => PromiseLike<unknown> & { readonly nextCursor: unknown };
			findFirst: (input?: object) => PromiseLike<unknown>;
		};

		const first = await harness.runtime.runPromise(
			dispatchInvocation(
				command('collections.findMany', {
					collection: 'people',
					limit: 1,
					orderBy: { name: 'asc' }
				})
			)
		);
		expect(first.value).toMatchObject({
			rows: [{ name: 'Ada' }],
			nextCursor: expect.any(String)
		});
		const nextCursor = (first.value as { readonly nextCursor: string }).nextCursor;
		expect(FixedCommandCatalogue.some((contract) => contract.name === 'collections.findMany')).toBe(
			true
		);
		expect(FixedCommandBindings.has('collections.findMany')).toBe(true);

		const page = people.findMany({ limit: 1, after: nextCursor, orderBy: { name: 'asc' } });
		await expect(page).resolves.toMatchObject([{ name: 'Bea' }]);
		expect(page.nextCursor).toEqual(expect.any(String));
		expect(mounted).toHaveLength(0);
		expect(posted).toEqual(['collections.findMany']);

		await expect(
			people.findFirst({ after: nextCursor, orderBy: { name: 'asc' } })
		).resolves.toMatchObject({ name: 'Bea' });
		expect(posted).toEqual(['collections.findMany', 'collections.findFirst']);
		expect(FixedCommandBindings.has('collections.findFirst')).toBe(true);

		const unbound = await harness.runtime.runPromise(
			dispatchInvocation(
				command('collections.unboundFind', { collection: 'people', after: nextCursor })
			).pipe(Effect.result)
		);
		expect(unbound._tag).toBe('Failure');
		if (unbound._tag !== 'Failure') throw new Error('expected unknown_command');
		expect(unbound.failure).toMatchObject({
			code: 'unknown_command',
			message: expect.stringContaining('collections.unboundFind')
		});
	});
});
