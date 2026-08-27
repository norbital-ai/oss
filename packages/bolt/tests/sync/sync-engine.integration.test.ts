import { createHash } from 'node:crypto';
import { Effect, Option, Redacted, Schema } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import {
	EffectId,
	EnvironmentName,
	Invocation,
	InvocationId,
	PROTOCOL_VERSION,
	ReleaseId,
	TenantId
} from '@norbital-ai/bolt-protocol';
import { policy } from '../../src/authoring/workspace-schema.js';
import { systemSignature } from '../../src/host.js';
import {
	GATEWAY_SECRET_VARIABLE,
	HostConfig,
	SYSTEM_SIGNATURE_HEADER,
	SYSTEM_TIMESTAMP_HEADER,
	systemSignaturePayload
} from '../../src/runtime/access/system-principal.js';
import * as Collections from '../../src/runtime/collections/collections.js';
import { dispatchInvocation } from '../../src/runtime/dispatch.js';
import * as Identity from '../../src/runtime/identity/identity.js';
import * as Sync from '../../src/runtime/sync/sync.js';
import { makeQueue, type ExecuteStatements } from '../../src/runtime/tasks/queue.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	testWorkspace,
	type BoltTestRuntime
} from '../support/bolt-test-layer.js';
import { fixtureUserId, seedSession, seedTeam } from '../support/fixture-identity.js';

/**
 * A valid record id for a readable fixture name.
 *
 * Records are keyed by `id uuid`. Names like `'person-1'` were only ever accepted by the
 * `id text` primary key Bolt used to invent, so these fixtures built rows a real database would have
 * rejected — and passed anyway.
 */
const rid = (name: string): string => {
	const digest = createHash('sha1').update(name).digest('hex').slice(0, 32);
	return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
};

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

/**
 * A narrow streamed predicate exercises before/after visibility without widening its partition.
 */
const SPARSE_TEAM = 'CoreOnly';
const sparseWorkspace = () =>
	testWorkspace({
		policies: [
			policy({ name: 'admin', effect: 'allow', actions: ['*'], capabilities: { apps: ['*'] } }),
			policy({
				name: 'core-only',
				effect: 'allow',
				actions: ['read'],
				capabilities: { apps: ['*'] },
				grants: [{ collection: 'people', action: 'read', where: { $sql: `"team" = 'core'` } }]
			})
		],
		teams: { admin: ['admin'], [SPARSE_TEAM]: ['core-only'] }
	});

const sparseSubject: Identity.Subject = {
	userId: 'sparse-1',
	tenantId: 'test-tenant',
	teamPath: [SPARSE_TEAM],
	policies: []
};

const compareCursors = (left: Sync.SyncCursor, right: Sync.SyncCursor): number =>
	left.xid === right.xid ? left.sequence - right.sequence : left.xid - right.xid;

const ORIGIN: Sync.SyncCursor = { xid: 0, sequence: 0 };
describe('Partition-oriented sync pull', () => {
	it('emits full-row upserts and removes from before/after visibility transitions', async () => {
		harness = await makeBoltTestRuntime(sparseWorkspace());
		const { runtime, effectId, database } = harness;
		const start = await runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Sync.Service).positions(
					effectId('partition-start'),
					sparseSubject,
					['people']
				);
			})
		);
		await runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Collections.Service).create(
					effectId('partition-visible-create'),
					adminSubject,
					{
						collection: 'people',
						id: rid('partition-visible'),
						values: { name: 'Ada', team: 'core' }
					}
				);
			})
		);
		const created = await runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Sync.Service).pull(
					effectId('partition-created'),
					sparseSubject,
					{
						collections: ['people'],
						cursor: start.cursor,
						generations: start.generations
					}
				);
			})
		);
		expect(created.kind).toBe('delta');
		expect(created.deltas).toHaveLength(1);
		expect(created.deltas[0]).toMatchObject({
			collection: 'people',
			op: 'upsert',
			recordId: rid('partition-visible'),
			row: { id: rid('partition-visible'), name: 'Ada', team: 'core' }
		});
		if (created.deltas[0]?.op !== 'upsert') throw new Error('expected full-row upsert');
		expect(created.deltas[0].rowVersion).toBe(created.deltas[0].row['row_version']);

		await runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Collections.Service).update(
					effectId('partition-visible-leaves'),
					adminSubject,
					{
						collection: 'people',
						id: rid('partition-visible'),
						values: { team: 'other' }
					}
				);
			})
		);
		const removed = await runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Sync.Service).pull(
					effectId('partition-removed'),
					sparseSubject,
					{
						collections: ['people'],
						cursor: created.cursor,
						generations: created.generations
					}
				);
			})
		);
		expect(removed.deltas).toEqual([
			expect.objectContaining({
				collection: 'people',
				op: 'remove',
				recordId: rid('partition-visible')
			})
		]);
		expect(JSON.stringify(removed)).not.toContain('other');

		const images = await database.query(
			`select before_record, after_record
			 from bolt_sync_outbox
			 where record_id = $1 and operation = 'update'
			 order by sequence desc limit 1`,
			[rid('partition-visible')]
		);
		expect(images[0]?.['before_record']).toMatchObject({ team: 'core' });
		expect(images[0]?.['after_record']).toMatchObject({ team: 'other' });
	});

	it('keeps generations at the durable input position until a bounded replay reaches head', async () => {
		harness = await makeBoltTestRuntime();
		const { runtime, effectId } = harness;
		const start = await runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Sync.Service).positions(
					effectId('atomic-position'),
					adminSubject,
					['people']
				);
			})
		);
		await runtime.runPromise(
			Effect.gen(function* () {
				const collections = yield* Collections.Service;
				for (const index of [1, 2, 3]) {
					yield* collections.create(effectId(`atomic-${index}`), adminSubject, {
						collection: 'people',
						id: rid(`atomic-${index}`),
						values: { name: `Person ${index}`, team: 'core' }
					});
				}
			})
		);
		const partial = await runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Sync.Service).pull(effectId('atomic-partial'), adminSubject, {
					collections: ['people'],
					cursor: start.cursor,
					generations: start.generations,
					limit: 1
				});
			})
		);
		expect(partial.complete).toBe(false);
		expect(partial.generations).toEqual(start.generations);
		expect(compareCursors(partial.cursor, start.cursor)).toBeGreaterThan(0);
		expect(compareCursors(partial.cursor, partial.headCursor)).toBeLessThan(0);
	});

	it('keeps linking invalidation distinct when the same batch also has an own-row delta', async () => {
		const linked = testWorkspace({
			policies: [
				policy({ name: 'admin', effect: 'allow', actions: ['*'], capabilities: { apps: ['*'] } }),
				policy({
					name: 'linked-reader',
					effect: 'allow',
					actions: ['read'],
					grants: [
						{
							collection: 'people',
							action: 'read',
							dependencies: ['team']
						}
					]
				})
			],
			teams: { admin: ['admin'], reader: ['linked-reader'] }
		});
		harness = await makeBoltTestRuntime(linked);
		const { runtime, effectId, database } = harness;
		await database.query(
			'insert into people (id, name, team) values ($1, $2, $3), ($4, $5, $6)',
			[rid('generation-a'), 'A', 'core', rid('generation-b'), 'B', 'core']
		);
		expect(
			await database.query(
				`select generation from bolt_sync_generation where collection_name = 'people'`
			)
		).toEqual([{ generation: 1 }]);
		const reader: Identity.Subject = {
			userId: 'generation-reader',
			tenantId: 'test-tenant',
			teamPath: ['reader'],
			policies: []
		};
		const beforeLinkWrite = await runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Sync.Service).positions(
					effectId('linked-generation-position'),
					reader,
					['people']
				);
			})
		);
		await seedTeam(harness, 'reader');
		expect(
			await database.query(
				`select collection_name, generation
				 from bolt_sync_generation
				 where collection_name in ('people', 'team')
				 order by collection_name`
			)
		).toEqual([
			{ collection_name: 'people', generation: 2 },
			{ collection_name: 'team', generation: 1 }
		]);
		const linkEvent = await database.query(
			`select invalidated_collections from bolt_sync_outbox
			 where collection_name = 'team' order by sequence desc limit 1`
		);
		expect(linkEvent[0]?.['invalidated_collections']).toContain('people');
		await runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Collections.Service).create(
					effectId('linked-generation-direct-row'),
					adminSubject,
					{
						collection: 'people',
						id: rid('linked-generation-direct-row'),
						values: { name: 'Direct row', team: 'core' }
					}
				);
			})
		);

		// The direct row is M1 work, but it cannot explain away the independent team-driven visibility
		// bump. `refillCollections` remains an unconditional M2 instruction for the people proof.
		const invalidated = await runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Sync.Service).pull(
					effectId('linked-generation-invalidated'),
					reader,
					{
						collections: ['people'],
						cursor: beforeLinkWrite.cursor,
						generations: beforeLinkWrite.generations
					}
				);
			})
		);
		expect(invalidated).toMatchObject({
			kind: 'delta',
			deltas: [
				expect.objectContaining({
					collection: 'people',
					op: 'upsert',
					recordId: rid('linked-generation-direct-row')
				})
			],
			affectedCollections: ['people'],
			refillCollections: ['people'],
			complete: true,
			generations: { people: 3 }
		});
	});

	it('chooses replay or rehydration from bounded cost metadata and detects a backwards head', async () => {
		harness = await makeBoltTestRuntime();
		const { runtime, effectId, database } = harness;
		const position = await runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Sync.Service).positions(
					effectId('recovery-position'),
					adminSubject,
					['people']
				);
			})
		);
		await database.query(
			`insert into people (id, name)
			 select gen_random_uuid(), 'bulk-' || value::text
			 from generate_series(1, $1) value`,
			[20]
		);
		const advised = await runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Sync.Service).pull(effectId('rehydrate-advised'), adminSubject, {
					collections: ['people'],
					cursor: position.cursor,
					generations: position.generations,
					rehydration: {
						activeWindows: 1,
						rowsPerWindow: 1,
						estimatedBytesPerRow: 1
					}
				});
			})
		);
		expect(advised).toMatchObject({
			kind: 'rehydrateAdvised',
			deltas: [],
			complete: true,
			affectedCollections: ['people'],
			refillCollections: ['people'],
			cost: {
				replayEvents: 20,
				estimatedRehydrateBytes: 1
			}
		});
		expect(advised.cost.estimatedReplayBytes).toBeGreaterThan(
			advised.cost.estimatedRehydrateBytes ?? 0
		);
		expect(advised.cursor).toEqual(advised.headCursor);

		const replayed = await runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Sync.Service).pull(effectId('replay-cheaper'), adminSubject, {
					collections: ['people'],
					cursor: position.cursor,
					generations: position.generations,
					rehydration: {
						activeWindows: Sync.MAX_SYNC_ACTIVE_WINDOWS,
						rowsPerWindow: 500,
						estimatedBytesPerRow: Sync.MAX_SYNC_ESTIMATED_ROW_BYTES
					}
				});
			})
		);
		expect(replayed).toMatchObject({
			kind: 'delta',
			complete: true,
			cost: { replayEvents: 20 }
		});
		expect(replayed.deltas).toHaveLength(20);
		expect(replayed.cost.estimatedReplayBytes).toBeLessThan(
			replayed.cost.estimatedRehydrateBytes ?? 0
		);

		// A durable cursor ahead of the first authoritative head is a backwards-head replacement, not
		// an empty replay. The same explicit recovery shape preserves the overlay and rebuilds windows.
		const ahead = { xid: advised.headCursor.xid + 10_000, sequence: 0 };
		const expired = await runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Sync.Service).pull(effectId('cursor-expired'), adminSubject, {
					collections: ['people'],
					cursor: ahead,
					generations: advised.generations
				});
			})
		);
		expect(expired).toMatchObject({
			kind: 'cursorExpired',
			deltas: [],
			complete: true,
			affectedCollections: ['people'],
			refillCollections: ['people']
		});
		expect(expired.cursor).toEqual(expired.headCursor);
	});

	it('refuses unknown and unauthorized subscriptions indistinguishably', async () => {
		harness = await makeBoltTestRuntime(sparseWorkspace());
		const { runtime, effectId } = harness;
		const noAccess: Identity.Subject = {
			userId: 'no-access',
			tenantId: 'test-tenant',
			teamPath: [],
			policies: []
		};
		const attempt = (collection: string, name: string) =>
			runtime.runPromise(
				Effect.result(
					Effect.gen(function* () {
						return yield* (yield* Sync.Service).pull(effectId(name), noAccess, {
							collections: [collection],
							cursor: ORIGIN,
							generations: {}
						});
					})
				)
			);
		const unknown = await attempt('does_not_exist', 'subscription-unknown');
		const unauthorized = await attempt('people', 'subscription-unauthorized');
		expect(unknown._tag).toBe('Failure');
		expect(unauthorized._tag).toBe('Failure');
		if (unknown._tag !== 'Failure' || unauthorized._tag !== 'Failure') return;
		expect(unknown.failure).toMatchObject({
			action: 'read',
			resource: 'sync.subscription',
			reason: 'sync subscription unavailable'
		});
		expect(unauthorized.failure).toMatchObject({
			action: 'read',
			resource: 'sync.subscription',
			reason: 'sync subscription unavailable'
		});
	});

	it('reuses one partition evaluation while applying cost advice per member', async () => {
		harness = await makeBoltTestRuntime();
		const { runtime, effectId, database } = harness;
		const position = await runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Sync.Service).positions(
					effectId('fanout-position'),
					adminSubject,
					['people']
				);
			})
		);
		await runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Collections.Service).create(effectId('fanout-write'), adminSubject, {
					collection: 'people',
					id: rid('fanout-write'),
					values: { name: 'One computation', team: 'core' }
				});
			})
		);
		database.forget();
		const results = await runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Sync.Service).distribute(effectId('fanout'), [
					{
						requestId: 'member-a',
						subject: adminSubject,
						pull: {
							collections: ['people'],
							cursor: position.cursor,
							generations: position.generations,
							pendingMutationIds: ['member-a-mutation'],
							rehydration: {
								activeWindows: 1,
								rowsPerWindow: 1,
								estimatedBytesPerRow: 1
							}
						}
					},
					{
						requestId: 'member-b',
						subject: adminSubject,
						pull: {
							collections: ['people'],
							cursor: position.cursor,
							generations: position.generations,
							pendingMutationIds: ['member-b-mutation'],
							rehydration: {
								activeWindows: Sync.MAX_SYNC_ACTIVE_WINDOWS,
								rowsPerWindow: 500,
								estimatedBytesPerRow: Sync.MAX_SYNC_ESTIMATED_ROW_BYTES
							}
						}
					}
				]);
			})
		);
		expect(results).toHaveLength(2);
		const advised = results[0];
		const replayed = results[1];
		if (!advised || !('response' in advised) || !replayed || !('response' in replayed)) {
			throw new Error('expected two admitted partition members');
		}
		expect(advised.response).toMatchObject({
			kind: 'rehydrateAdvised',
			deltas: [],
			cost: { estimatedRehydrateBytes: 1 }
		});
		expect(replayed.response.kind).toBe('delta');
		expect(replayed.response.deltas).toHaveLength(1);
		expect(advised.response.cost.estimatedReplayBytes).toBe(
			replayed.response.cost.estimatedReplayBytes
		);
		expect(
			database.statements.filter((statement) => statement.includes('jsonb_populate_record'))
		).toHaveLength(1);
	});
});

const HOST_SECRET = 'a-test-gateway-secret';

/** Supplies the host signing secret explicitly so these boundary tests never depend on machine env. */
const withHostSecret = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	effect.pipe(
		Effect.provideService(HostConfig, {
			read: (key: string) =>
				Effect.succeed(
					key === GATEWAY_SECRET_VARIABLE
						? Option.some(Redacted.make(HOST_SECRET))
						: Option.none<Redacted.Redacted<string>>()
				)
		})
	);

const compactScope = {
	tenantId: TenantId.make('test-tenant'),
	environment: EnvironmentName.make('test'),
	releaseId: ReleaseId.make('local')
};

let invocationSequence = 0;
const signedHostCommand = (
	command: 'sync.compact' | 'sync.distribute',
	input: Record<string, unknown>
) => {
	const timestamp = Date.now();
	return Invocation.cases.Command.make({
		protocolVersion: PROTOCOL_VERSION,
		id: InvocationId.make(`host-signed-${(invocationSequence += 1)}`),
		scope: compactScope,
		deadlineEpochMs: Date.now() + 30_000,
		command,
		input: input as never,
		headers: {
			[SYSTEM_SIGNATURE_HEADER]: [
				systemSignature(
					HOST_SECRET,
					systemSignaturePayload({
						timestamp,
						command,
						tenantId: String(compactScope.tenantId),
						input
					})
				)
			],
			[SYSTEM_TIMESTAMP_HEADER]: [String(timestamp)]
		}
	});
};

const signedCompact = (input: Record<string, unknown>) =>
	signedHostCommand('sync.compact', input);

const signedDistribute = (input: Record<string, unknown>) =>
	signedHostCommand('sync.distribute', input);

const compactAsPerson = (credential: string) =>
	Invocation.cases.Command.make({
		protocolVersion: PROTOCOL_VERSION,
		id: InvocationId.make(`compact-person-${(invocationSequence += 1)}`),
		scope: compactScope,
		deadlineEpochMs: Date.now() + 30_000,
		command: 'sync.compact',
		input: {} as never,
		headers: { authorization: [`Bearer ${credential}`] }
	});

describe('sync.pull dispatch boundary', () => {
	const pullCommand = (token: string, input: Record<string, unknown>) =>
		Invocation.cases.Command.make({
			protocolVersion: PROTOCOL_VERSION,
			id: InvocationId.make(`pull-command-${(invocationSequence += 1)}`),
			scope: compactScope,
			deadlineEpochMs: Date.now() + 30_000,
			command: 'sync.pull',
			input: input as never,
			headers: { authorization: [`Bearer ${token}`] }
		});

	it('injects authority and returns the partition recovery wire shape', async () => {
		harness = await makeBoltTestRuntime();
		await seedSession(harness, { token: 'pull-admin', user: 'pull-admin', team: 'admin' });
		const response = await harness.runtime.runPromise(
			dispatchInvocation(
				pullCommand('pull-admin', {
					collections: ['people'],
					cursor: null,
					generations: {}
				})
			)
		);
		expect(response.status).toBe(200);
		const value = Schema.decodeUnknownSync(Sync.SyncPullResponse)(response.value);
		expect(value).toMatchObject({
			kind: 'rehydrateAdvised',
			deltas: [],
			affectedCollections: ['people'],
			complete: true,
			partition: {
				tenantId: 'test-tenant',
				environment: 'test',
				effectivePolicyHolder: `actor:${fixtureUserId('pull-admin')}`
			}
		});
		expect(value.cursor).toEqual(value.headCursor);
	});

	it('refuses a payload subject and cannot use it to widen a bearer', async () => {
		harness = await makeBoltTestRuntime();
		await seedSession(harness, { token: 'pull-outsider', user: 'pull-outsider' });
		const outcome = await harness.runtime.runPromise(
			dispatchInvocation(
				pullCommand('pull-outsider', {
					subject: adminSubject,
					collections: ['people'],
					cursor: ORIGIN,
					generations: {}
				})
			).pipe(Effect.result)
		);
		expect(outcome._tag).toBe('Failure');
	});
});

describe('host sync distribution', () => {
	it('authenticates opaque credentials and reuses an identical partition pull', async () => {
		harness = await makeBoltTestRuntime(sparseWorkspace());
		const { runtime, effectId, database } = harness;
		await seedSession(harness, { token: 'distribute-admin', user: 'distribution-admin', team: 'admin' });
		await seedSession(harness, {
			token: 'distribute-core',
			user: 'distribution-core',
			team: SPARSE_TEAM
		});
		const positions = await runtime.runPromise(
			Effect.gen(function* () {
				const identity = yield* Identity.Service;
				const sync = yield* Sync.Service;
				const admin = yield* identity.authenticate(
					effectId('distribute-admin-position-auth'),
					'distribute-admin'
				);
				const core = yield* identity.authenticate(
					effectId('distribute-core-position-auth'),
					'distribute-core'
				);
				return {
					admin: yield* sync.positions(effectId('distribute-admin-position'), admin, ['people']),
					core: yield* sync.positions(effectId('distribute-core-position'), core, ['people'])
				};
			})
		);
		await runtime.runPromise(
			Effect.gen(function* () {
				const collections = yield* Collections.Service;
				yield* collections.create(effectId('distribute-visible'), adminSubject, {
					collection: 'people',
					id: rid('distribute-visible'),
					values: { name: 'Core row', team: 'core' }
				});
				yield* collections.create(effectId('distribute-hidden'), adminSubject, {
					collection: 'people',
					id: rid('distribute-hidden'),
					values: { name: 'Other row', team: 'other' }
				});
			})
		);
		database.forget();
		const adminPull = {
			collections: ['people'],
			cursor: positions.admin.cursor,
			generations: positions.admin.generations
		};
		const corePull = {
			collections: ['people'],
			cursor: positions.core.cursor,
			generations: positions.core.generations
		};
		const response = await runtime.runPromise(
			withHostSecret(
				dispatchInvocation(
					signedDistribute({
						entries: [
							{
								requestId: 'admin-request',
								credential: 'distribute-admin',
								pull: adminPull
							},
							{
								requestId: 'core-request-a',
								credential: 'distribute-core',
								pull: corePull
							},
							{
								requestId: 'core-request-b',
								credential: 'distribute-core',
								pull: corePull
							},
							{
								requestId: 'revoked-request',
								credential: 'not-a-session',
								pull: adminPull
							},
							{
								requestId: 'denied-request',
								credential: 'distribute-core',
								pull: {
									collections: ['not-a-collection'],
									cursor: ORIGIN,
									generations: {}
								}
							}
						]
					})
				)
			)
		);
		const distributed = Schema.decodeUnknownSync(Sync.SyncDistributeResponse)(response.value);
		expect(distributed.results.map(({ requestId, status }) => ({ requestId, status }))).toEqual([
			{ requestId: 'admin-request', status: 200 },
			{ requestId: 'core-request-a', status: 200 },
			{ requestId: 'core-request-b', status: 200 },
			{ requestId: 'revoked-request', status: 401 },
			{ requestId: 'denied-request', status: 403 }
		]);
		const admin = distributed.results[0];
		const coreA = distributed.results[1];
		const coreB = distributed.results[2];
		if (admin?.status !== 200 || coreA?.status !== 200 || coreB?.status !== 200) {
			throw new Error('expected admitted distribution members');
		}
		expect(admin.value.deltas.map(({ recordId }) => recordId)).toEqual([
			rid('distribute-visible'),
			rid('distribute-hidden')
		]);
		expect(coreA.value.deltas.map(({ recordId }) => recordId)).toEqual([
			rid('distribute-visible')
		]);
		expect(coreB.value).toEqual(coreA.value);
		expect(compareCursors(admin.value.cursor, positions.admin.cursor)).toBeGreaterThanOrEqual(0);
		expect(compareCursors(coreA.value.cursor, positions.core.cursor)).toBeGreaterThanOrEqual(0);
		expect(admin.value.generations['people']).toBeGreaterThanOrEqual(
			positions.admin.generations['people'] ?? 0
		);
		expect(coreA.value.generations['people']).toBeGreaterThanOrEqual(
			positions.core.generations['people'] ?? 0
		);
		expect(admin.value.partition.effectivePolicyHolder).toBe(
			`actor:${fixtureUserId('distribution-admin')}`
		);
		expect(coreA.value.partition.effectivePolicyHolder).toBe(
			`actor:${fixtureUserId('distribution-core')}`
		);
		expect(coreA.value.partition.key).not.toBe(admin.value.partition.key);
		expect(JSON.stringify(response.value)).not.toContain('distribute-admin');
		expect(JSON.stringify(response.value)).not.toContain('distribute-core');
		// One visibility evaluation for the admin partition and one shared by both core members.
		expect(
			database.statements.filter((statement) => statement.includes('jsonb_populate_record'))
		).toHaveLength(2);
	});

	it('refuses an ordinary administrator without a host signature', async () => {
		harness = await makeBoltTestRuntime();
		await seedSession(harness, {
			token: 'distribute-person',
			user: 'distribution-person',
			team: 'admin',
			status: 'admin'
		});
		const invocation = Invocation.cases.Command.make({
			protocolVersion: PROTOCOL_VERSION,
			id: InvocationId.make(`distribute-person-${(invocationSequence += 1)}`),
			scope: compactScope,
			deadlineEpochMs: Date.now() + 30_000,
			command: 'sync.distribute',
			input: { entries: [] } as never,
			headers: { authorization: ['Bearer distribute-person'] }
		});
		const outcome = await harness.runtime.runPromise(
			withHostSecret(dispatchInvocation(invocation)).pipe(Effect.result)
		);
		expect(outcome._tag).toBe('Failure');
	});
});

/**
 * Compaction deletes another tenant's history, so it is the host's to run and nobody else's.
 *
 * It used to decode no subject at all and appear in neither authorization table, which made it
 * reachable by any credential the boundary accepted: an ordinary member could prune the outbox and
 * strand every replica in the workspace behind a rebuild.
 */
describe('who may compact the outbox', () => {
	it('refuses an administrator and admits the signed host', async () => {
		harness = await makeBoltTestRuntime();
		// Administrative status *and* the team holding the workspace's `*` policy: whatever authority a
		// person can hold in this workspace, this one holds it.
		await seedSession(harness, {
			token: 'admin-token',
			user: 'admin',
			team: 'admin',
			status: 'admin'
		});

		const refused = await harness.runtime.runPromise(
			withHostSecret(dispatchInvocation(compactAsPerson('admin-token'))).pipe(Effect.result)
		);
		expect(refused._tag).toBe('Failure');

		const admitted = await harness.runtime.runPromise(
			withHostSecret(dispatchInvocation(signedCompact({})))
		);
		expect(admitted.status).toBe(200);
		expect(admitted.value).toMatchObject({ collapsed: 0, pruned: 0 });
	});
});

/**
 * The tick that already exists is where maintenance belongs.
 *
 * `finish` prunes terminal task rows for exactly this reason — a maintenance cron would wake every
 * tenant daily whether or not it had work. Outbox compaction is the same shape of chore, so it rides
 * the same batch and is bounded the same way.
 */
describe('outbox compaction on the task tick', () => {
	/** The batch seam a host binds: the tick's statements, in order, answering with what they read. */
	const executeOver =
		(database: BoltTestRuntime['database']): ExecuteStatements =>
		(statements) =>
			Effect.promise(async () => {
				const rows: Array<Record<string, unknown>> = [];
				for (const statement of statements) {
					rows.push(...(await database.query(statement.sql, statement.parameters)));
				}
				return rows;
			});

	it('collapses superseded rows and prunes expired ones without a separate schedule', async () => {
		harness = await makeBoltTestRuntime();
		const { runtime, effectId, database } = harness;
		await runtime.runPromise(
			Effect.gen(function* () {
				const collections = yield* Collections.Service;
				yield* collections.create(effectId('c1'), adminSubject, {
					collection: 'people',
					id: rid('p1'),
					values: { name: 'Ada' }
				});
				yield* collections.update(effectId('u1'), adminSubject, {
					collection: 'people',
					id: rid('p1'),
					values: { name: 'Ada L' }
				});
				yield* collections.update(effectId('u2'), adminSubject, {
					collection: 'people',
					id: rid('p1'),
					values: { name: 'Ada Lovelace' }
				});
				yield* collections.create(effectId('c2'), adminSubject, {
					collection: 'people',
					id: rid('p2'),
					values: { name: 'Grace' }
				});
			})
		);
		await database.query(
			`update bolt_sync_outbox set created_at = now() - interval '40 days' where record_id = $1`,
			[rid('p2')]
		);
		expect(await database.query('select count(*)::int as count from bolt_sync_outbox', [])).toEqual(
			[{ count: 4 }]
		);

		// One ordinary tick with nothing to run. Compaction is not something a caller asks for.
		await Effect.runPromise(makeQueue(executeOver(database)).finish([]));

		expect(
			await database.query(
				'select collection_name, record_id from bolt_sync_outbox order by xid, sequence',
				[]
			)
		).toEqual([{ collection_name: 'people', record_id: rid('p1') }]);
		const mark = await database.query(
			'select xid, sequence from bolt_sync_horizon where singleton',
			[]
		);
		expect(Number(mark[0]?.['xid'] ?? 0)).toBeGreaterThan(0);
	});
});

describe('the compaction horizon', () => {
	it('returns one partition recovery move when its durable cursor is below the horizon', async () => {
		harness = await makeBoltTestRuntime();
		const { runtime, effectId, database } = harness;
		await runtime.runPromise(
			Effect.gen(function* () {
				const collections = yield* Collections.Service;
				yield* collections.create(effectId('pull-compact-old'), adminSubject, {
					collection: 'people',
					id: rid('pull-compact-old'),
					values: { name: 'Old' }
				});
				yield* collections.create(effectId('pull-compact-fresh'), adminSubject, {
					collection: 'people',
					id: rid('pull-compact-fresh'),
					values: { name: 'Fresh' }
				});
			})
		);
		await database.query(
			`update bolt_sync_outbox set created_at = now() - interval '40 days' where record_id = $1`,
			[rid('pull-compact-old')]
		);
		await runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Sync.Service).compact(effectId('pull-compact'), 30);
			})
		);
		const result = await runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Sync.Service).pull(effectId('pull-after-compact'), adminSubject, {
					collections: ['people'],
					cursor: { xid: 1, sequence: 1 },
					generations: { people: 0 }
				});
			})
		);

		expect(result).toMatchObject({
			kind: 'cursorExpired',
			deltas: [],
			affectedCollections: ['people'],
			complete: true
		});
		expect(result.cursor).toEqual(result.headCursor);
	});
});
