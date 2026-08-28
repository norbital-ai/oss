import { afterEach, describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import {
	EnvironmentName,
	EffectId,
	Invocation,
	InvocationId,
	PROTOCOL_VERSION,
	ReleaseId,
	TenantId
} from '@norbital-ai/bolt-protocol';
import {
	app,
	collection,
	field,
	policy,
	workspace,
	type WorkspaceDefinition
} from '../../src/authoring/workspace-schema.js';
import {
	emptyAuthoredRuntime,
	type AuthoredRuntime
} from '../../src/runtime/collections/authored.js';
import { refuse } from '../../src/authoring/refusal.js';
import { approveBy } from '../../src/authoring/approval-flow.js';
import {
	describePolicy,
	policyRuntimeFunctionsFor
} from '../../src/authoring/policy-introspection.js';
import * as AccessControl from '../../src/runtime/access/access-control.js';
import * as Approvals from '../../src/runtime/approvals/approvals.js';
import * as Collections from '../../src/runtime/collections/collections.js';
import { dispatchInvocation } from '../../src/runtime/dispatch.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	TEST_ENVIRONMENT,
	type BoltTestRuntime
} from '../support/bolt-test-layer.js';
import { fixtureUserId, seedSession } from '../support/fixture-identity.js';

/**
 * The declarative mutation as a browser actually reaches it: over `dispatchInvocation`, with a
 * bearer token, through the boundary that mints the subject.
 *
 * Reached this way rather than by calling the collections service, because the three things under
 * test are properties of the *command*, not of the service beneath it. Where an identity is carried,
 * what shape a graph may have, and what the response is entitled to say are all decisions the
 * boundary makes.
 */
const definition = workspace({
	name: 'wire',
	version: '1.0.0',
	collections: [
		collection({
			name: 'orders',
			fields: {
				reference: field.string({ required: true }),
				status: field.string({ required: false }),
				occurred_at: field.instant({ required: false })
			}
		}),
		collection({
			name: 'order_lines',
			fields: {
				order_id: field.string({ required: true }),
				sku: field.string({ required: true }),
				/**
				 * Declared as a raw field rather than through `field.*`, which has no spelling for a
				 * generated column. It is here so a graph has a child the caller must not write to.
				 */
				label: { type: 'string', required: false, indexed: false, generated: "'line'" }
			}
		})
	],
	relations: [
		{
			name: 'order_line_order',
			source: 'orders',
			target: 'order_lines',
			cardinality: 'many',
			from: { collection: 'order_lines', column: 'order_id' },
			to: { collection: 'orders', column: 'id' }
		}
	],
	apps: [app({ name: 'wire', label: 'Wire' })],
	teams: { admin: ['admin-data'] },
	automations: [],
	integrations: [],
	prompt: 'You are the test workspace agent.',
	tools: [],
	skills: [],
	envoys: [],
	requiredFacilities: [],
	policies: [
		policy({
			name: 'admin-data',
			effect: 'allow',
			grants: [
				{ collection: 'orders', action: 'create' },
				{ collection: 'orders', action: 'read' },
				{ collection: 'orders', action: 'update' },
				{ collection: 'orders', action: 'delete' },
				{ collection: 'order_lines', action: 'create' },
				{ collection: 'order_lines', action: 'read' },
				{ collection: 'order_lines', action: 'update' },
				{ collection: 'order_lines', action: 'delete' }
			]
		})
	]
});

/**
 * A hook that changes the record on its way in, which is the cheap stand-in for every reason a
 * stored row differs from the submission — a default, a generated column, a derived field.
 */
const authored = {
	...emptyAuthoredRuntime,
	hooks: {
		orders: {
			mutate: {
				perRecord: {
					before: {
						description: 'Stamps the status the workspace, not the caller, decides.',
						handler: (context: unknown) => {
							const mutation = context as {
								readonly input: Record<string, unknown>;
								readonly existing?: Record<string, unknown>;
							};
							if (mutation.existing !== undefined) return mutation.input;
							return {
								...mutation.input,
								status: 'accepted',
								occurred_at: new Date('2026-08-23T05:00:00.000Z')
							};
						}
					}
				}
			}
		}
	}
};

const scope = {
	tenantId: TenantId.make('test-tenant'),
	environment: EnvironmentName.make(TEST_ENVIRONMENT),
	releaseId: ReleaseId.make('local')
};

let sequence = 0;
const command = (name: string, input: unknown) => {
	const invocationSequence = (sequence += 1);
	return Invocation.cases.Command.make({
		protocolVersion: PROTOCOL_VERSION,
		id: InvocationId.make(`command-${name}-${invocationSequence}`),
		scope,
		deadlineEpochMs: Date.now() + 30_000,
		command: name,
		input: input as never,
		headers: { authorization: ['Bearer admin-token'] }
	});
};

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
	issuedMutationPartitionKey = '';
});

const open = async (
	runtimeAuthored: AuthoredRuntime = authored,
	runtimeDefinition: WorkspaceDefinition = definition
): Promise<BoltTestRuntime> => {
	const runtime = await makeBoltTestRuntime(runtimeDefinition, { authored: runtimeAuthored });
	await seedSession(runtime, { token: 'admin-token', user: 'user-admin', team: 'admin' });
	return runtime;
};

let issuedMutationPartitionKey = '';

const schemaFingerprint = async (runtime: BoltTestRuntime): Promise<string> => {
	const response = await post(runtime, 'sync.schema', {});
	const value = response.value;
	if (typeof value !== 'object' || value === null || Array.isArray(value))
		throw new TypeError('sync.schema did not return an object');
	const fingerprint = Reflect.get(value, 'fingerprint');
	if (typeof fingerprint !== 'string') throw new TypeError('sync.schema returned no fingerprint');
	const partitionResponse = await post(runtime, 'sync.partition', {});
	const partitionEnvelope = partitionResponse.value;
	if (
		typeof partitionEnvelope !== 'object' ||
		partitionEnvelope === null ||
		Array.isArray(partitionEnvelope)
	)
		throw new TypeError('sync.partition did not return an object');
	const partition = Reflect.get(partitionEnvelope, 'partition');
	if (typeof partition !== 'object' || partition === null || Array.isArray(partition))
		throw new TypeError('sync.partition did not return a partition');
	const partitionKey = Reflect.get(partition, 'key');
	const partitionFingerprint = Reflect.get(partition, 'schemaFingerprint');
	if (typeof partitionKey !== 'string' || partitionKey.length === 0)
		throw new TypeError('sync.partition returned no key');
	if (partitionFingerprint !== fingerprint)
		throw new TypeError('sync.partition returned a different schema fingerprint');
	issuedMutationPartitionKey = partitionKey;
	return fingerprint;
};

const registerHistoricalPartition = async (
	runtime: BoltTestRuntime,
	schemaFingerprint: string,
	key: string
): Promise<string> => {
	const [current] = await runtime.database.query(
		`select actor_id, effective_subject_id, impersonation_binding
		 from bolt_sync_partition_registry where partition_key = $1`,
		[issuedMutationPartitionKey]
	);
	if (
		current === undefined ||
		typeof current['actor_id'] !== 'string' ||
		typeof current['effective_subject_id'] !== 'string' ||
		typeof current['impersonation_binding'] !== 'string'
	)
		throw new TypeError('The current physical partition has no authenticated registry binding.');
	const binding = {
		tenantId: scope.tenantId,
		environment: scope.environment,
		actorId: current['actor_id'],
		effectiveSubjectId: current['effective_subject_id'],
		impersonationBinding: current['impersonation_binding']
	};
	await runtime.runtime.runPromise(
		Effect.gen(function* () {
			const collections = yield* Collections.Service;
			yield* collections.registerBrowserMutationPartition(
				EffectId.make(`historical-partition:${key}`),
				binding,
				{
					key,
					tenantId: scope.tenantId,
					environment: scope.environment,
					effectivePolicyHolder: 'administrator',
					impersonationTarget: null,
					authorityGeneration: 0,
					schemaFingerprint
				}
			);
			const registered = yield* collections.browserMutationPartition(
				EffectId.make(`historical-partition:${key}:verify`),
				binding,
				key
			);
			if (registered?.schemaFingerprint !== schemaFingerprint)
				throw new TypeError('The historical physical partition was not registered exactly.');
		})
	);
	return key;
};

const mutationPush = (
	fingerprint: string,
	input: Readonly<{
		readonly idempotencyKey: string;
		readonly deviceSequence: number;
		readonly graph: Readonly<Record<string, unknown>>;
		readonly baseVersions?: ReadonlyArray<Readonly<Record<string, unknown>>>;
		readonly issuedAtEpochMs?: number;
		readonly partitionKey?: string;
	}>
) => {
	const action = input.graph['action'];
	const values = input.graph['values'];
	const graph =
		action === 'create' && typeof values === 'object' && values !== null && !Array.isArray(values)
			? {
					...input.graph,
					values: {
						id: `00000000-0000-4000-8000-${String(input.deviceSequence).padStart(12, '0')}`,
						...values
					}
				}
			: input.graph;
	return {
		protocolVersion: 2,
		idempotencyKey: input.idempotencyKey,
		issuedAtEpochMs: input.issuedAtEpochMs ?? Date.now(),
		deviceSequence: input.deviceSequence,
		partitionKey: input.partitionKey ?? issuedMutationPartitionKey,
		schemaFingerprint: fingerprint,
		graph,
		baseVersions: input.baseVersions ?? []
	};
};

const post = async (runtime: BoltTestRuntime, name: string, input: unknown) =>
	runtime.runtime.runPromise(dispatchInvocation(command(name, input)));

const storedRecordsOf = (value: unknown): ReadonlyArray<Readonly<Record<string, unknown>>> => {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
	const records = Reflect.get(value, 'records');
	return Array.isArray(records)
		? records.filter(
				(record): record is Readonly<Record<string, unknown>> =>
					typeof record === 'object' && record !== null && !Array.isArray(record)
			)
		: [];
};

describe('collections.mutate over the wire', () => {
	it('issues and registers a physical partition without requiring a readable collection', async () => {
		harness = await open(emptyAuthoredRuntime, {
			...definition,
			policies: [
				policy({
					name: 'admin-data',
					effect: 'allow',
					grants: [{ collection: 'orders', action: 'create' }]
				})
			]
		});
		const response = await post(harness, 'sync.partition', {});
		const envelope = response.value as Readonly<Record<string, unknown>>;
		const identity = envelope['partition'] as Readonly<Record<string, unknown>>;

		expect(identity['key']).toEqual(expect.stringMatching(/^sha256:/u));
		expect(identity['schemaFingerprint']).toEqual(expect.any(String));
		expect(envelope).toMatchObject({ mutationConfirmations: [], mutationRejections: [] });
		expect(
			await harness.database.query(
				'select actor_id, effective_subject_id, impersonation_binding from bolt_sync_partition_registry'
			)
		).toEqual([
			{
				actor_id: fixtureUserId('user-admin'),
				effective_subject_id: fixtureUserId('user-admin'),
				impersonation_binding: 'operator'
			}
		]);
	});

	it('deduplicates an M4 journal push under its original key and device sequence and emits one ordinary outbox commit', async () => {
		harness = await open();
		const fingerprint = await schemaFingerprint(harness);
		const initialPull = await post(harness, 'sync.pull', {
			collections: ['orders'],
			cursor: null,
			generations: {}
		});
		const initial = initialPull.value as Readonly<Record<string, unknown>>;
		const input = mutationPush(fingerprint, {
			idempotencyKey: 'm4-accepted-once',
			deviceSequence: 41,
			graph: { action: 'create', collection: 'orders', values: { reference: 'M4-ONCE' } }
		});

		const first = await post(harness, 'collections.mutate', input);
		const replay = await post(harness, 'collections.mutate', input);
		const changedSequence = await harness.runtime.runPromise(
			Effect.result(
				dispatchInvocation(
					command(
						'collections.mutate',
						mutationPush(fingerprint, {
							idempotencyKey: 'm4-accepted-once',
							deviceSequence: 42,
							graph: {
								action: 'create',
								collection: 'orders',
								values: { reference: 'M4-ONCE' }
							}
						})
					)
				)
			)
		);

		expect(first.value).toEqual(replay.value);
		expect(changedSequence._tag).toBe('Failure');
		if (changedSequence._tag === 'Failure')
			expect(Collections.unwrapMutationPhase(changedSequence.failure)).toBeInstanceOf(
				Collections.MutationIdempotencyConflict
			);
		expect(first.value).toMatchObject({
			resolution: 'accepted',
			mutationId: 'm4-accepted-once',
			deviceSequence: 41,
			schemaFingerprint: fingerprint
		});
		expect(storedRecordsOf(first.value)?.[0]?.['id']).toBe(
			'00000000-0000-4000-8000-000000000041'
		);
		expect(
			await harness.database.query(
				"select mutation_id from bolt_sync_outbox where collection_name = 'orders' and operation = 'create'"
			)
		).toEqual([{ mutation_id: 'm4-accepted-once' }]);
		const authoritative = await post(harness, 'sync.pull', {
			collections: ['orders'],
			cursor: initial['cursor'],
			generations: initial['generations'],
			pendingMutationIds: ['m4-accepted-once']
		});
		expect(authoritative.value).toMatchObject({
			kind: 'delta',
			deltas: [expect.objectContaining({ mutationId: 'm4-accepted-once' })],
			mutationConfirmations: [
				{
					mutationId: 'm4-accepted-once',
					cursor: expect.objectContaining({ xid: expect.any(Number), sequence: expect.any(Number) })
				}
			],
			mutationRejections: []
		});
		expect(
			await harness.database.query(
				"select device_sequence, partition_key, schema_fingerprint from bolt_browser_mutation where idempotency_key = 'm4-accepted-once'"
			)
		).toEqual([
			{
				device_sequence: 41,
				partition_key: issuedMutationPartitionKey,
				schema_fingerprint: fingerprint
			}
		]);
	});

	it('confirms a committed write through partition status when the caller has no readable collection', async () => {
		harness = await open(emptyAuthoredRuntime, {
			...definition,
			policies: [
				policy({
					name: 'admin-data',
					effect: 'allow',
					grants: [{ collection: 'orders', action: 'create' }]
				})
			]
		});
		const fingerprint = await schemaFingerprint(harness);
		const mutationId = 'm4-write-only-confirmation';
		const accepted = await post(
			harness,
			'collections.mutate',
			mutationPush(fingerprint, {
				idempotencyKey: mutationId,
				deviceSequence: 54,
				graph: {
					action: 'create',
					collection: 'orders',
					values: { reference: 'WRITE-ONLY' }
				}
			})
		);
		expect(accepted.value).toMatchObject({ resolution: 'accepted', records: [] });

		const status = await post(harness, 'sync.partition', {
			pendingMutationIds: [mutationId]
		});
		expect(status.value).toMatchObject({
			partition: { key: issuedMutationPartitionKey, schemaFingerprint: fingerprint },
			mutationConfirmations: [
				{
					mutationId,
					cursor: expect.objectContaining({ xid: expect.any(Number), sequence: expect.any(Number) })
				}
			],
			mutationRejections: []
		});
	});

	it('binds an M4 journal push to the authenticated partition', async () => {
		harness = await open();
		const fingerprint = await schemaFingerprint(harness);
		const result = await harness.runtime.runPromise(
			Effect.result(
				dispatchInvocation(
					command(
						'collections.mutate',
						mutationPush(fingerprint, {
							idempotencyKey: 'm4-wrong-partition',
							deviceSequence: 42,
							partitionKey: 'sha256:unissued-partition',
							graph: {
								action: 'create',
								collection: 'orders',
								values: { reference: 'MUST-NOT-LAND' }
							}
						})
					)
				)
			)
		);

		expect(result._tag).toBe('Failure');
		if (result._tag === 'Failure')
			expect(Collections.unwrapMutationPhase(result.failure)).toBeInstanceOf(
				AccessControl.AccessDenied
			);
		expect(await harness.database.query('select id from orders')).toEqual([]);
	});

	it('rejects replaying another actor\'s registered physical partition', async () => {
		harness = await open();
		const fingerprint = await schemaFingerprint(harness);
		await seedSession(harness, { token: 'other-admin-token', user: 'user-other', team: 'admin' });
		const input = mutationPush(fingerprint, {
			idempotencyKey: 'm4-switched-actor',
			deviceSequence: 43,
			graph: { action: 'create', collection: 'orders', values: { reference: 'WRONG-ACTOR' } }
		});
		const invocation = command('collections.mutate', input);
		const result = await harness.runtime.runPromise(
			Effect.result(
				dispatchInvocation({
					...invocation,
					headers: { authorization: ['Bearer other-admin-token'] }
				})
			)
		);

		expect(result._tag).toBe('Failure');
		if (result._tag === 'Failure')
			expect(Collections.unwrapMutationPhase(result.failure)).toBeInstanceOf(
				AccessControl.AccessDenied
			);
		expect(await harness.database.query('select id from orders')).toEqual([]);
	});

	it('selects a retained schema adapter inside the offline horizon and reports a rebase', async () => {
		const compatibleDefinition: WorkspaceDefinition = {
			...definition,
			mutationCompatibility: {
				offlineHorizonMillis: 14 * 24 * 60 * 60 * 1000,
				currentSchemaFingerprint: 'schema:orders-v2',
				adapters: [
					{
						fromSchemaFingerprint: 'schema:orders-v1',
						fieldRenames: { orders: { old_reference: 'reference' } }
					}
				]
			}
		};
		harness = await open(authored, compatibleDefinition);
		await schemaFingerprint(harness);
		const historicalPartition = await registerHistoricalPartition(
			harness,
			'schema:orders-v1',
			'sha256:orders-v1'
		);
		const response = await post(
			harness,
			'collections.mutate',
			mutationPush('schema:orders-v1', {
				idempotencyKey: 'm4-rebased',
				deviceSequence: 43,
				partitionKey: historicalPartition,
				graph: {
					action: 'create',
					collection: 'orders',
					values: { old_reference: 'REBASING' }
				}
			})
		);

		expect(response.value).toMatchObject({
			resolution: 'rebased',
			mutationId: 'm4-rebased',
			deviceSequence: 43,
			fromSchemaFingerprint: 'schema:orders-v1'
		});
		expect(await harness.database.query('select reference from orders')).toEqual([
			{ reference: 'REBASING' }
		]);
	});

	it('durably replays an authored M4 rejection without rerunning hooks', async () => {
		let beforeRuns = 0;
		harness = await open({
			...emptyAuthoredRuntime,
			hooks: {
				orders: {
					mutate: {
						perRecord: {
							before: {
								description: 'rejects the M4 write once',
								handler: () => {
									beforeRuns += 1;
									return refuse('This order cannot be created.');
								}
							}
						}
					}
				}
			}
		});
		const fingerprint = await schemaFingerprint(harness);
		const rejected = mutationPush(fingerprint, {
			idempotencyKey: 'm4-rejected',
			deviceSequence: 44,
			graph: { action: 'create', collection: 'orders', values: { reference: 'REFUSED' } }
		});
		const first = await post(harness, 'collections.mutate', rejected);
		const replay = await post(harness, 'collections.mutate', rejected);

		expect(first.value).toEqual(replay.value);
		expect(first.value).toMatchObject({
			resolution: 'rejected',
			mutationId: 'm4-rejected',
			deviceSequence: 44,
			code: 'refused',
			message: 'This order cannot be created.',
			schemaFingerprint: fingerprint
		});
		expect(beforeRuns).toBe(1);
		expect(await harness.database.query('select id from orders')).toEqual([]);
	});

	it('accepts an approval-gated M4 write with durable pending metadata', async () => {
		let approvalRuns = 0;
		const approvalPolicy = describePolicy('admin-data', {
			description: 'Orders require review.',
			grants: {
				orders: {
					read: {},
					create: {
						approval: {
							flow: () => {
								approvalRuns += 1;
								return approveBy('Reviewers');
							},
							superceded_by: []
						}
					}
				}
			}
		});
		const policyFunctions = policyRuntimeFunctionsFor([approvalPolicy]);
		harness = await open(
			{
				...emptyAuthoredRuntime,
				approvalFlows: policyFunctions.approvalFlows,
				policyAuthorizations: policyFunctions.authorizations
			},
			{
				...definition,
				policies: [approvalPolicy],
				teams: { admin: ['admin-data'], Reviewers: [] }
			}
		);
		const fingerprint = await schemaFingerprint(harness);
		const pending = mutationPush(fingerprint, {
			idempotencyKey: 'm4-pending-approval',
			deviceSequence: 45,
			graph: { action: 'create', collection: 'orders', values: { reference: 'REVIEW' } }
		});
		const first = await post(harness, 'collections.mutate', pending);
		const replay = await post(harness, 'collections.mutate', pending);

		expect(first.value).toEqual(replay.value);
		expect(first.value).toMatchObject({
			resolution: 'accepted',
			mutationId: 'm4-pending-approval',
			deviceSequence: 45,
			schemaFingerprint: fingerprint,
			records: [],
			pendingApproval: {
				collection: 'orders',
				action: 'create'
			}
		});
		expect(approvalRuns).toBe(1);
		expect(await harness.database.query('select id from orders')).toEqual([]);

		const pendingApproval = Reflect.get(first.value as object, 'pendingApproval');
		const requestId =
			typeof pendingApproval === 'object' && pendingApproval !== null
				? Reflect.get(pendingApproval, 'requestId')
				: undefined;
		if (typeof requestId !== 'string') throw new TypeError('pending settlement has no request id');
		await harness.runtime.runPromise(
			Effect.gen(function* () {
				const approvals = yield* Approvals.Service;
				const state = yield* approvals.status(harness!.effectId('approval-status'), requestId);
				if (state?._tag !== 'Pending') throw new TypeError('approval is not pending');
				yield* approvals.decide(
					harness!.effectId('approval-reject'),
					{ ...adminSubject, admin: false, teamPath: ['Reviewers'] },
					state,
					'reject',
					'Needs correction.'
				);
				yield* (yield* Collections.Service).discard(
					harness!.effectId('approval-discard'),
					requestId
				);
			})
		);
		const status = await post(harness, 'sync.partition', {
			pendingMutationIds: ['m4-pending-approval']
		});
		expect(status.value).toMatchObject({
			partition: { key: issuedMutationPartitionKey },
			mutationConfirmations: [],
			mutationRejections: [
				{
					mutationId: 'm4-pending-approval',
					code: 'refused'
				}
			]
		});
	});

	it('persists an explicit quarantine for an unknown or expired mutation schema', async () => {
		const compatibleDefinition: WorkspaceDefinition = {
			...definition,
			mutationCompatibility: {
				offlineHorizonMillis: 1_000,
				currentSchemaFingerprint: 'schema:orders-v2',
				adapters: [{ fromSchemaFingerprint: 'schema:known-old' }]
			}
		};
		harness = await open(authored, compatibleDefinition);
		await schemaFingerprint(harness);
		const unknownPartition = await registerHistoricalPartition(
			harness,
			'schema:unknown-old',
			'sha256:unknown-old'
		);
		const expiredPartition = await registerHistoricalPartition(
			harness,
			'schema:known-old',
			'sha256:known-old'
		);
		const unknown = await post(
			harness,
			'collections.mutate',
			mutationPush('schema:unknown-old', {
				idempotencyKey: 'm4-quarantine-unknown',
				deviceSequence: 46,
				partitionKey: unknownPartition,
				graph: { action: 'create', collection: 'orders', values: { reference: 'UNKNOWN' } }
			})
		);
		const expiredInput = mutationPush('schema:known-old', {
			idempotencyKey: 'm4-quarantine-expired',
			deviceSequence: 47,
			issuedAtEpochMs: Date.now() - 1_001,
			partitionKey: expiredPartition,
			graph: { action: 'create', collection: 'orders', values: { reference: 'EXPIRED' } }
		});
		const expired = await post(harness, 'collections.mutate', expiredInput);
		const expiredReplay = await post(harness, 'collections.mutate', expiredInput);

		expect(unknown.value).toMatchObject({ resolution: 'quarantined' });
		expect(expired.value).toEqual(expiredReplay.value);
		expect(expired.value).toMatchObject({
			resolution: 'quarantined',
			mutationId: 'm4-quarantine-expired',
			deviceSequence: 47
		});
		expect(await harness.database.query('select id from orders')).toEqual([]);
	});

	it('durably rejects an M4 write whose whole-row base version is stale', async () => {
		harness = await open();
		const fingerprint = await schemaFingerprint(harness);
		const created = await post(
			harness,
			'collections.mutate',
			mutationPush(fingerprint, {
				idempotencyKey: 'm4-conflict-seed',
				deviceSequence: 48,
				graph: { action: 'create', collection: 'orders', values: { reference: 'BASE' } }
			})
		);
		const id = String(storedRecordsOf(created.value)?.[0]?.['id']);
		const stale = mutationPush(fingerprint, {
			idempotencyKey: 'm4-stale-update',
			deviceSequence: 49,
			graph: { action: 'update', collection: 'orders', values: { id, reference: 'STALE' } },
			baseVersions: [{ row: { collection: 'orders', recordId: id }, rowVersion: 99 }]
		});
		const first = await post(harness, 'collections.mutate', stale);
		const replay = await post(harness, 'collections.mutate', stale);
		expect(first.value).toEqual(replay.value);
		expect(first.value).toMatchObject({
			resolution: 'rejected',
			mutationId: 'm4-stale-update',
			deviceSequence: 49,
			code: 'conflict',
			schemaFingerprint: fingerprint
		});
		expect(await harness.database.query('select reference from orders')).toEqual([
			{ reference: 'BASE' }
		]);
	});

	it('quarantines an M4 update that omitted an existing row from its whole-row base vector', async () => {
		harness = await open();
		const fingerprint = await schemaFingerprint(harness);
		const created = await post(
			harness,
			'collections.mutate',
			mutationPush(fingerprint, {
				idempotencyKey: 'm4-missing-base-seed',
				deviceSequence: 50,
				graph: { action: 'create', collection: 'orders', values: { reference: 'BASE' } }
			})
		);
		const id = String(storedRecordsOf(created.value)?.[0]?.['id']);
		const missing = mutationPush(fingerprint, {
			idempotencyKey: 'm4-missing-base',
			deviceSequence: 51,
			graph: { action: 'update', collection: 'orders', values: { id, reference: 'UNSAFE' } }
		});
		const first = await post(harness, 'collections.mutate', missing);
		const replay = await post(harness, 'collections.mutate', missing);

		expect(first.value).toEqual(replay.value);
		expect(first.value).toMatchObject({
			resolution: 'quarantined',
			mutationId: 'm4-missing-base',
			deviceSequence: 51,
			schemaFingerprint: fingerprint
		});
		expect(await harness.database.query('select reference from orders')).toEqual([
			{ reference: 'BASE' }
		]);
	});

	it('commits client-minted root and nested create UUIDs verbatim and rejects a collision', async () => {
		harness = await open();
		const fingerprint = await schemaFingerprint(harness);
		const rootId = '00000000-0000-4000-8000-000000000052';
		const childId = '00000000-0000-4000-8000-000000000152';
		const created = mutationPush(fingerprint, {
			idempotencyKey: 'm4-client-create-identities',
			deviceSequence: 52,
			graph: {
				action: 'create',
				collection: 'orders',
				values: {
					id: rootId,
					reference: 'CLIENT-ID',
					order_line_order: [{ id: childId, sku: 'CLIENT-CHILD-ID' }]
				}
			}
		});
		const response = await post(harness, 'collections.mutate', created);
		expect(response.value).toMatchObject({ resolution: 'accepted' });
		expect(await harness.database.query('select id from orders')).toEqual([{ id: rootId }]);
		expect(await harness.database.query('select id from order_lines')).toEqual([{ id: childId }]);

		const collision = await post(
			harness,
			'collections.mutate',
			mutationPush(fingerprint, {
				idempotencyKey: 'm4-client-create-collision',
				deviceSequence: 53,
				graph: {
					action: 'create',
					collection: 'orders',
					values: { id: rootId, reference: 'COLLISION' }
				}
			})
		);
		expect(collision.value).toMatchObject({
			resolution: 'rejected',
			code: 'refused'
		});
		expect(await harness.database.query('select reference from orders')).toEqual([
			{ reference: 'CLIENT-ID' }
		]);
	});
});
