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
 * The one partition pull path is checked directly: its full-row delta must already be the complete
 * permitted field set for that partition before anything reaches the browser base store.
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

	it('emits each partition\'s complete permitted row through the one pull path', async () => {
		harness = await makeBoltTestRuntime(restrictedWorkspace());
		const { runtime, effectId } = harness;
		const [viewerPosition, adminPosition] = await Promise.all([
			runtime.runPromise(
				Effect.gen(function* () {
					return yield* (yield* Sync.Service).positions(
						effectId('viewer-position'),
						viewerSubject,
						['people']
					);
				})
			),
			runtime.runPromise(
				Effect.gen(function* () {
					return yield* (yield* Sync.Service).positions(
						effectId('admin-position'),
						adminSubject,
						['people']
					);
				})
			)
		]);
		await runtime.runPromise(
			Effect.gen(function* () {
				yield* (yield* Collections.Service).create(effectId('create'), adminSubject, {
					collection: 'people',
					id: rid('p1'),
					values: { name: 'Ada', team: 'core', salary: '100000' }
				});
			})
		);
		const pull = (name: string, subject: Identity.Subject, position: Sync.SyncPartitionPosition) =>
			runtime.runPromise(
				Effect.gen(function* () {
					return yield* (yield* Sync.Service).pull(effectId(name), subject, {
						collections: ['people'],
						cursor: position.cursor,
						generations: position.generations
					});
				})
			);
		const [viewer, admin] = await Promise.all([
			pull('viewer-pull', viewerSubject, viewerPosition),
			pull('admin-pull', adminSubject, adminPosition)
		]);
		const viewerDelta = viewer.deltas[0];
		const adminDelta = admin.deltas[0];
		if (viewerDelta?.op !== 'upsert' || adminDelta?.op !== 'upsert') {
			throw new Error('expected full-row partition upserts');
		}
		expect(viewerDelta.row).toMatchObject({ id: rid('p1'), name: 'Ada' });
		expect(viewerDelta.row).not.toHaveProperty('team');
		expect(viewerDelta.row).not.toHaveProperty('salary');
		expect(adminDelta.row).toMatchObject({ team: 'core', salary: '100000' });
	});

});
