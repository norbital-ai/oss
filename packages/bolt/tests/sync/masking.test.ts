import { createHash } from 'node:crypto';
import { Effect } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import {
	EnvironmentName,
	Invocation,
	InvocationId,
	PROTOCOL_VERSION,
	ReleaseId,
	TenantId
} from '@norbital-ai/bolt-protocol';
import { collection, field, policy, workspace } from '../../src/authoring/workspace-schema.js';
import * as Collections from '../../src/runtime/collections/collections.js';
import * as Sync from '../../src/runtime/sync/sync.js';
import type * as Identity from '../../src/runtime/identity/identity.js';
import { dispatchInvocation } from '../../src/runtime/dispatch.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	type BoltTestRuntime
} from '../support/bolt-test-layer.js';
import { seedSession } from '../support/fixture-identity.js';

/**
 * Column masking on the way into the replica.
 *
 * A field-restricted policy is enforced on every server read, and the replica used to undo it: the
 * outbox ships `to_jsonb(r)`, so the whole row travelled to the browser and was persisted there. The
 * page never displayed the column, which is exactly what made it invisible — the data was in
 * IndexedDB and in the response either way.
 *
 * Both halves of delivery are checked, because they are separate code paths: `snapshot` is the bulk
 * load a fresh replica starts from, and `diff` is the stream that follows.
 */

const rid = (name: string): string => {
	const digest = createHash('sha1').update(name).digest('hex').slice(0, 32);
	return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
};

/** Sees `people`, but only the name — `team` and `salary` are outside the grant. */
const restrictedWorkspace = () =>
	workspace({
		name: 'masking-workspace',
		version: '1',
		collections: [
			collection({
				name: 'people',
				fields: {
					name: field.string({ required: true }),
					team: field.string(),
					salary: field.string()
				}
			})
		],
		apps: [],
		policies: [
			policy({ name: 'admin', effect: 'allow', actions: ['*'], capabilities: { apps: ['*'] } }),
			policy({
				name: 'viewer',
				effect: 'allow',
				actions: ['read'],
				capabilities: { apps: ['*'] },
				grants: [{ collection: 'people', action: 'read', fields: ['id', 'name'] }]
			})
		],
		// `admin` holds the unrestricted policy ALONE, deliberately. Field grants are collected from
		// every policy the team holds and a policy declaring no grants contributes none, so a team
		// holding `admin` *and* `viewer` is masked to `viewer`'s two fields — the unrestricted policy
		// cannot widen what a restricting one narrowed. That is the shape this file exists to pin.
		teams: {
			admin: ['admin'],
			viewer: ['viewer']
		},
		automations: [],
		integrations: [],
		prompt: 'You are the test workspace agent.',
		tools: [],
		skills: [],
		envoys: [],
		requiredFacilities: []
	});

const viewerSubject: Identity.Subject = {
	userId: 'viewer-1',
	tenantId: 'test-tenant',
	teamPath: ['viewer'],
	policies: []
};

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

describe('what the sync engine hands a field-restricted subject', () => {
	it('reports the same field projection to the local query planner', async () => {
		harness = await makeBoltTestRuntime(restrictedWorkspace());
		await seedSession(harness, { token: 'viewer-token', user: 'viewer-1', team: 'viewer' });
		const answer = await harness.runtime.runPromise(
			dispatchInvocation(
				Invocation.cases.Command.make({
					protocolVersion: PROTOCOL_VERSION,
					id: InvocationId.make('sync-provisioning-projection'),
					scope: {
						tenantId: TenantId.make('test-tenant'),
						environment: EnvironmentName.make('development'),
						releaseId: ReleaseId.make('local')
					},
					deadlineEpochMs: Date.now() + 30_000,
					command: 'sync.provisioning',
					input: null,
					headers: { authorization: ['Bearer viewer-token'] }
				})
			)
		);
		const collections = Reflect.get(answer.value as object, 'collections');
		expect(Array.isArray(collections)).toBe(true);
		const people = (collections as ReadonlyArray<Record<string, unknown>>).find(
			(entry) => entry['name'] === 'people'
		);
		expect(people).toMatchObject({ readableFields: ['id', 'name'] });
	});

	it('omits masked columns from a snapshot', async () => {
		harness = await makeBoltTestRuntime(restrictedWorkspace());
		const { runtime, effectId } = harness;

		await runtime.runPromise(
			Effect.gen(function* () {
				yield* (yield* Collections.Service).create(effectId('create'), adminSubject, {
					collection: 'people',
					id: rid('p1'),
					values: { name: 'Ada', team: 'core', salary: '100000' }
				});
			})
		);

		const page = await runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Sync.Service).snapshot(
					effectId('snapshot'),
					viewerSubject,
					'people',
					undefined,
					100
				);
			})
		);

		expect(page.rows).toHaveLength(1);
		const row = page.rows[0] as Record<string, unknown>;
		expect(row['name']).toBe('Ada');
		// The whole point: these are in the table and must not be in the browser.
		expect(row).not.toHaveProperty('team');
		expect(row).not.toHaveProperty('salary');
	});

	it('omits masked columns from the streamed diff', async () => {
		harness = await makeBoltTestRuntime(restrictedWorkspace());
		const { runtime, effectId } = harness;

		await runtime.runPromise(
			Effect.gen(function* () {
				yield* (yield* Collections.Service).create(effectId('create'), adminSubject, {
					collection: 'people',
					id: rid('p1'),
					values: { name: 'Grace', team: 'flight', salary: '120000' }
				});
			})
		);

		const changes = await runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Sync.Service).diff(
					effectId('diff'),
					viewerSubject,
					{ xid: 0, sequence: 0 },
					100
				);
			})
		);

		expect(changes.length).toBeGreaterThan(0);
		for (const change of changes) {
			if (change.record === null || typeof change.record !== 'object') continue;
			const record = change.record as Record<string, unknown>;
			expect(record).not.toHaveProperty('team');
			expect(record).not.toHaveProperty('salary');
		}
		// And the column it may read still arrives — masking that removed everything would "pass" this
		// test while making the replica useless.
		expect(
			changes.some(
				(change) =>
					change.record !== null &&
					typeof change.record === 'object' &&
					(change.record as Record<string, unknown>)['name'] === 'Grace'
			)
		).toBe(true);
	});

	it('still gives an unrestricted subject the whole row', async () => {
		harness = await makeBoltTestRuntime(restrictedWorkspace());
		const { runtime, effectId } = harness;

		await runtime.runPromise(
			Effect.gen(function* () {
				yield* (yield* Collections.Service).create(effectId('create'), adminSubject, {
					collection: 'people',
					id: rid('p1'),
					values: { name: 'Ada', team: 'core', salary: '100000' }
				});
			})
		);

		const page = await runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Sync.Service).snapshot(
					effectId('snapshot'),
					adminSubject,
					'people',
					undefined,
					100
				);
			})
		);

		const row = page.rows[0] as Record<string, unknown>;
		// Masking must be the policy's doing, not something the sync path applies to everyone.
		expect(row['team']).toBe('core');
		expect(row['salary']).toBe('100000');
	});
});
