import { afterEach, describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import {
	EnvironmentName,
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
import { authoredHooks, type CollectionHooks } from '../../src/authoring/contracts-schema.js';
import { refuse } from '../../src/authoring/refusal.js';
import { approveBy } from '../../src/authoring/approval-flow.js';
import {
	describePolicy,
	policyRuntimeFunctionsFor
} from '../../src/authoring/policy-introspection.js';
import * as Approvals from '../../src/runtime/approvals/approvals.js';
import * as Collections from '../../src/runtime/collections/collections.js';
import { dispatchInvocation } from '../../src/runtime/dispatch.js';
import * as Workspace from '../../src/runtime/workspace.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	TEST_ENVIRONMENT,
	type BoltTestRuntime
} from '../support/bolt-test-layer.js';
import { seedSession } from '../support/fixture-identity.js';
import { unwrapMutationPhase } from '../support/mutation-phase.js';

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
			from: { collection: 'orders', column: 'id' },
			to: { collection: 'order_lines', column: 'order_id' }
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
 * The fixture tables as a schema, so the hook is typed the way a compiled workspace's are.
 *
 * The generated `label` on `order_lines` is deliberately absent from the insert shape: the graph
 * under test includes a child the caller must not write, and the generated column is only ever
 * produced by the database.
 */
interface WireCreateSchema {
	readonly tables: {
		readonly orders: {
			readonly $inferSelect: {
				readonly id: string;
				readonly reference: string;
				readonly status: string;
				readonly occurred_at: string;
			};
			readonly $inferInsert: {
				readonly id?: string;
				readonly reference: string;
				readonly status?: string;
				readonly occurred_at?: string;
			};
		};
		readonly order_lines: {
			readonly $inferSelect: {
				readonly id: string;
				readonly order_id: string;
				readonly sku: string;
				readonly label: string;
			};
			readonly $inferInsert: {
				readonly id?: string;
				readonly order_id: string;
				readonly sku: string;
			};
		};
	};
	readonly relations: Record<string, never>;
}

/**
 * A hook that changes the record on its way in, which is the cheap stand-in for every reason a
 * stored row differs from the submission — a default, a generated column, a derived field.
 */
const orderHooks: CollectionHooks<WireCreateSchema, 'orders'> = {
	mutate: {
		perRecord: {
			before: {
				description: 'Stamps the status the workspace, not the caller, decides.',
				handler: (context) => {
					if (context.existing !== undefined) return context.input;
					return {
						...context.input,
						status: 'accepted',
						occurred_at: '2026-08-23T05:00:00.000Z'
					};
				}
			}
		}
	}
};

const authored = {
	...emptyAuthoredRuntime,
	hooks: { orders: authoredHooks(orderHooks) }
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
});

const open = async (
	runtimeAuthored: AuthoredRuntime = authored,
	runtimeDefinition: WorkspaceDefinition = definition
): Promise<BoltTestRuntime> => {
	const runtime = await makeBoltTestRuntime(runtimeDefinition, { authored: runtimeAuthored });
	await seedSession(runtime, { token: 'admin-token', user: 'user-admin', team: 'admin' });
	return runtime;
};

/**
 * The coordinate a client canonicalises its push under.
 *
 * Client-chosen, and no longer a handle the server issued and resolves: the wire is `sync.connect`
 * and `sync.advance`, and neither hands one out. The journal only folds it into the request digest,
 * which is what the collision case further down turns on.
 */
const MUTATION_PARTITION_KEY = 'sha256:wire-create-partition';

/**
 * The schema fingerprint the write boundary refuses any push stated against an older one.
 *
 * It rides the compiled workspace definition, which the harness provisions, so a test states the
 * same fact the release does rather than asking a command for it.
 */
const schemaFingerprint = async (runtime: BoltTestRuntime): Promise<string> => {
	const workspace = await runtime.runtime.runPromise(Workspace.Service);
	const fingerprint = workspace.definition.schemaFingerprint;
	if (typeof fingerprint !== 'string')
		throw new TypeError('The test runtime provisioned no schema fingerprint.');
	return fingerprint;
};

/** One complete sync handshake: registration, resolution and pending settlement in one command. */
const syncConnect = async (
	runtime: BoltTestRuntime,
	input: Readonly<{
		readonly pending?: ReadonlyArray<string>;
		readonly queries?: ReadonlyArray<{
			readonly queryKey: string;
			readonly input: Readonly<Record<string, unknown>>;
			readonly requestedPrefix: number;
		}>;
	}> = {}
) =>
	post(runtime, 'sync.connect', {
		head: { sequence: 0 },
		queries: input.queries ?? [],
		detached: [],
		pending: input.pending ?? []
	});

const mutationPush = (
	fingerprint: string,
	input: Readonly<{
		readonly idempotencyKey: string;
		readonly seed: number;
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
						id: `00000000-0000-4000-8000-${String(input.seed).padStart(12, '0')}`,
						...values
					}
				}
			: input.graph;
	return {
		protocolVersion: 2,
		idempotencyKey: input.idempotencyKey,
		issuedAtEpochMs: input.issuedAtEpochMs ?? Date.now(),
		partitionKey: input.partitionKey ?? MUTATION_PARTITION_KEY,
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
	it('opens a sync handshake without requiring a readable collection', async () => {
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
		const response = await syncConnect(harness);
		const value = response.value as Readonly<Record<string, unknown>>;

		// The handshake resolves no query, so a subject holding only a `mutate.new` grant is not excluded
		// from it: the head is answered and nothing is resolved that the subject could not read.
		//
		// The head is read back rather than written as a literal zero. `user` and `team` are synced
		// collections and carry the capture trigger, so seeding the session that authenticates this
		// very handshake already advances the changelog; a literal would be asserting that the
		// fixture wrote nothing, not that the handshake answered.
		const [changelog] = await harness.database.query(
			'select coalesce(max(sequence), 0)::int as sequence from bolt_sync_outbox'
		);
		expect(Reflect.get(value, 'head')).toEqual({ sequence: changelog?.['sequence'] });
		expect(value).toMatchObject({ results: [], outcomes: [] });
	}, 60_000);

	it('deduplicates a browser mutation push under its original key and digest and emits one ordinary outbox commit', async () => {
		harness = await open();
		const fingerprint = await schemaFingerprint(harness);
		const input = mutationPush(fingerprint, {
			idempotencyKey: 'm4-accepted-once',
			seed: 41,
			graph: {
				action: 'create',
				collection: 'orders',
				values: { reference: 'BROWSER-MUTATION-ONCE' }
			}
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
							seed: 42,
							graph: {
								action: 'create',
								collection: 'orders',
								values: { reference: 'BROWSER-MUTATION-ONCE-CHANGED' }
							}
						})
					)
				)
			)
		);

		// The replay reproduces the durable outcome, which is the resolution, the key, the fingerprint
		// and the readback — everything the ledger stores. `changes` is not stored there: it is the
		// committing request's own echo of the rows it just wrote, and a retry that never reached the
		// engine has none to echo. What a client learns the invalidation set from is the handshake
		// below, which is asserted in full.
		const { changes: _changes, ...committed } = first.value as Readonly<Record<string, unknown>>;
		expect(replay.value).toEqual(committed);
		expect(changedSequence._tag).toBe('Failure');
		if (changedSequence._tag === 'Failure')
			expect(unwrapMutationPhase(changedSequence.failure)).toBeInstanceOf(
				Collections.MutationIdempotencyConflict
			);
		expect(first.value).toMatchObject({
			resolution: 'accepted',
			mutationId: 'm4-accepted-once',
			schemaFingerprint: fingerprint
		});
		expect(storedRecordsOf(first.value)?.[0]?.['id']).toBe('00000000-0000-4000-8000-000000000041');
		// The authoritative read is the sync handshake: the commit is resolved into the changelog and
		// the journal answer, one query resolution beside the pending outcome.
		const authoritative = await syncConnect(harness, {
			queries: [
				{
					queryKey: 'orders',
					input: { kind: 'findMany', collection: 'orders', limit: 100 },
					requestedPrefix: 100
				}
			],
			pending: ['m4-accepted-once']
		});
		expect(authoritative.value).toMatchObject({
			head: { sequence: expect.any(Number) },
			results: [
				{
					key: 'orders',
					changed: true,
					answer: [expect.objectContaining({ reference: 'BROWSER-MUTATION-ONCE' })]
				}
			],
			outcomes: [
				{
					id: 'm4-accepted-once',
					status: { resolution: 'accepted', schemaFingerprint: fingerprint }
				}
			]
		});
		expect(
			await harness.database.query(
				'select partition_key, schema_fingerprint from bolt_browser_mutation where idempotency_key = $1',
				['m4-accepted-once']
			)
		).toEqual([
			{
				partition_key: MUTATION_PARTITION_KEY,
				schema_fingerprint: fingerprint
			}
		]);
	});

	it('durably rejects and replays a future-issued journal push without applying it', async () => {
		harness = await open();
		const fingerprint = await schemaFingerprint(harness);
		const input = mutationPush(fingerprint, {
			idempotencyKey: 'm4-future-issued',
			seed: 54,
			issuedAtEpochMs: Date.now() + 6 * 60 * 1_000,
			graph: { action: 'create', collection: 'orders', values: { reference: 'FUTURE' } }
		});

		const first = await post(harness, 'collections.mutate', input);
		const replay = await post(harness, 'collections.mutate', input);

		expect(first.value).toEqual(replay.value);
		expect(first.value).toMatchObject({
			resolution: 'rejected',
			mutationId: 'm4-future-issued',
			code: 'refused',
			message: 'The mutation is outside the server retry horizon and cannot be applied safely.',
			schemaFingerprint: fingerprint
		});
		expect(
			await harness.database.query(
				"select status, outcome from bolt_browser_mutation where idempotency_key = 'm4-future-issued'"
			)
		).toEqual([
			{
				status: 'terminal',
				outcome: expect.objectContaining({ _tag: 'Rejected', code: 'refused' })
			}
		]);
		expect(await harness.database.query('select id from orders')).toEqual([]);
	});

	it('quarantines and replays an unclassified failure after acquiring the journal claim', async () => {
		let beforeRuns = 0;
		harness = await open({
			...emptyAuthoredRuntime,
			hooks: {
				orders: {
					mutate: {
						perRecord: {
							before: {
								description: 'fails outside the authored refusal vocabulary',
								handler: () => {
									beforeRuns += 1;
									return Effect.fail(new Error('mutation preparation exploded'));
								}
							}
						}
					}
				}
			}
		});
		const fingerprint = await schemaFingerprint(harness);
		const input = mutationPush(fingerprint, {
			idempotencyKey: 'm4-unclassified-failure',
			seed: 55,
			graph: { action: 'create', collection: 'orders', values: { reference: 'BROKEN' } }
		});

		const first = await post(harness, 'collections.mutate', input);
		const replay = await post(harness, 'collections.mutate', input);

		expect(first.value).toEqual(replay.value);
		expect(first.value).toMatchObject({
			resolution: 'quarantined',
			mutationId: 'm4-unclassified-failure',
			schemaFingerprint: fingerprint,
			reason: expect.stringContaining('mutation preparation exploded')
		});
		expect(beforeRuns).toBe(1);
		expect(
			await harness.database.query(
				"select status, outcome from bolt_browser_mutation where idempotency_key = 'm4-unclassified-failure'"
			)
		).toEqual([
			{
				status: 'terminal',
				outcome: expect.objectContaining({ _tag: 'Quarantined' })
			}
		]);
		expect(await harness.database.query('select id from orders')).toEqual([]);
	});

	it('confirms a committed write through the handshake when the caller has no readable collection', async () => {
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
				seed: 54,
				graph: {
					action: 'create',
					collection: 'orders',
					values: { reference: 'WRITE-ONLY' }
				}
			})
		);
		expect(accepted.value).toMatchObject({ resolution: 'accepted', records: [] });

		// Confirmation without read entitlement: the handshake resolves no queries but still answers
		// the journal's terminal outcome for the pending mutation id.
		const status = await syncConnect(harness, { pending: [mutationId] });
		expect(status.value).toMatchObject({
			head: { sequence: expect.any(Number) },
			results: [],
			outcomes: [
				{
					id: mutationId,
					status: { resolution: 'accepted', schemaFingerprint: fingerprint }
				}
			]
		});
	});

	it('binds a browser mutation key to its canonical request digest', async () => {
		harness = await open();
		const fingerprint = await schemaFingerprint(harness);
		const accepted = await post(
			harness,
			'collections.mutate',
			mutationPush(fingerprint, {
				idempotencyKey: 'm4-partition-bound',
				seed: 42,
				graph: {
					action: 'create',
					collection: 'orders',
					values: { reference: 'LANDED' }
				}
			})
		);
		expect(accepted.value).toMatchObject({ resolution: 'accepted' });

		// The partition key a client carries is part of what it canonicalises: the same committed key
		// pushed under different partition coordinates is a different canonical request, and the
		// journal refuses to bind the key twice rather than applying a second write beneath it.
		const changed = await harness.runtime.runPromise(
			Effect.result(
				dispatchInvocation(
					command(
						'collections.mutate',
						mutationPush(fingerprint, {
							idempotencyKey: 'm4-partition-bound',
							seed: 43,
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
		expect(changed._tag).toBe('Failure');
		if (changed._tag === 'Failure')
			expect(unwrapMutationPhase(changed.failure)).toBeInstanceOf(
				Collections.MutationIdempotencyConflict
			);
		expect(await harness.database.query('select reference from orders')).toEqual([
			{ reference: 'LANDED' }
		]);
	});

	it('isolates a shared idempotency key per authenticated authority', async () => {
		harness = await open();
		const fingerprint = await schemaFingerprint(harness);
		const firstActor = await post(
			harness,
			'collections.mutate',
			mutationPush(fingerprint, {
				idempotencyKey: 'm4-switched-actor',
				seed: 43,
				graph: { action: 'create', collection: 'orders', values: { reference: 'WRONG-ACTOR' } }
			})
		);
		expect(firstActor.value).toMatchObject({
			resolution: 'accepted',
			mutationId: 'm4-switched-actor'
		});
		await seedSession(harness, { token: 'other-admin-token', user: 'user-other', team: 'admin' });
		const invocation = command(
			'collections.mutate',
			mutationPush(fingerprint, {
				idempotencyKey: 'm4-switched-actor',
				seed: 44,
				graph: { action: 'create', collection: 'orders', values: { reference: 'WRONG-ACTOR' } }
			})
		);
		const otherActor = await harness.runtime.runPromise(
			Effect.result(
				dispatchInvocation({
					...invocation,
					headers: { authorization: ['Bearer other-admin-token'] }
				})
			)
		);
		// The journal is scoped to (tenant, environment, authority): the second actor's same key is
		// an independent mutation, not the first actor's write replayed or refused for their key.
		expect(otherActor._tag).toBe('Success');
		if (otherActor._tag === 'Success')
			expect(otherActor.success.value).toMatchObject({
				resolution: 'accepted',
				mutationId: 'm4-switched-actor'
			});
		expect(await harness.database.query('select id, reference from orders order by id')).toEqual([
			{ id: '00000000-0000-4000-8000-000000000043', reference: 'WRONG-ACTOR' },
			{ id: '00000000-0000-4000-8000-000000000044', reference: 'WRONG-ACTOR' }
		]);
	});

	it('durably replays an authored browser-mutation rejection without rerunning hooks', async () => {
		let beforeRuns = 0;
		harness = await open({
			...emptyAuthoredRuntime,
			hooks: {
				orders: {
					mutate: {
						perRecord: {
							before: {
								description: 'rejects the write once',
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
			seed: 44,
			graph: { action: 'create', collection: 'orders', values: { reference: 'REFUSED' } }
		});
		const first = await post(harness, 'collections.mutate', rejected);
		const replay = await post(harness, 'collections.mutate', rejected);

		expect(first.value).toEqual(replay.value);
		expect(first.value).toMatchObject({
			resolution: 'rejected',
			mutationId: 'm4-rejected',
			code: 'refused',
			message: 'This order cannot be created.',
			schemaFingerprint: fingerprint
		});
		expect(beforeRuns).toBe(1);
		expect(await harness.database.query('select id from orders')).toEqual([]);
	});

	it('accepts an approval-gated browser mutation with durable pending metadata', async () => {
		let approvalRuns = 0;
		const approvalPolicy = describePolicy('admin-data', {
			description: 'Orders require review.',
			grants: {
				orders: {
					read: {},
					mutate: {
						new: {
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
			seed: 45,
			graph: { action: 'create', collection: 'orders', values: { reference: 'REVIEW' } }
		});
		const first = await post(harness, 'collections.mutate', pending);
		const replay = await post(harness, 'collections.mutate', pending);

		expect(first.value).toEqual(replay.value);
		expect(first.value).toMatchObject({
			resolution: 'accepted',
			mutationId: 'm4-pending-approval',
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
		const status = await syncConnect(harness, { pending: ['m4-pending-approval'] });
		expect(status.value).toMatchObject({
			head: { sequence: expect.any(Number) },
			results: [],
			outcomes: [
				{
					id: 'm4-pending-approval',
					status: { resolution: 'rejected', code: 'refused' }
				}
			]
		});
	});

	it('durably rejects a mutation stated against a retired schema, and replays the refusal', async () => {
		harness = await open(authored);
		await schemaFingerprint(harness);
		const unknownInput = mutationPush('schema:unknown-old', {
			idempotencyKey: 'm4-reject-unknown',
			seed: 46,
			graph: { action: 'create', collection: 'orders', values: { reference: 'UNKNOWN' } }
		});
		const unknown = await post(harness, 'collections.mutate', unknownInput);
		const unknownReplay = await post(harness, 'collections.mutate', unknownInput);

		expect(unknown.value).toEqual(unknownReplay.value);
		expect(unknown.value).toMatchObject({
			resolution: 'rejected',
			code: 'refused',
			mutationId: 'm4-reject-unknown'
		});
		expect(await harness.database.query('select id from orders')).toEqual([]);
	});

	it('durably rejects a browser mutation whose whole-row base version is stale', async () => {
		harness = await open();
		const fingerprint = await schemaFingerprint(harness);
		const created = await post(
			harness,
			'collections.mutate',
			mutationPush(fingerprint, {
				idempotencyKey: 'm4-conflict-seed',
				seed: 48,
				graph: { action: 'create', collection: 'orders', values: { reference: 'BASE' } }
			})
		);
		const id = String(storedRecordsOf(created.value)?.[0]?.['id']);
		const stale = mutationPush(fingerprint, {
			idempotencyKey: 'm4-stale-update',
			seed: 49,
			graph: { action: 'update', collection: 'orders', values: { id, reference: 'STALE' } },
			baseVersions: [{ row: { collection: 'orders', recordId: id }, rowVersion: 99 }]
		});
		const first = await post(harness, 'collections.mutate', stale);
		const replay = await post(harness, 'collections.mutate', stale);
		expect(first.value).toEqual(replay.value);
		expect(first.value).toMatchObject({
			resolution: 'rejected',
			mutationId: 'm4-stale-update',
			code: 'conflict',
			schemaFingerprint: fingerprint
		});
		expect(await harness.database.query('select reference from orders')).toEqual([
			{ reference: 'BASE' }
		]);
	});

	it('quarantines a browser mutation that omitted an existing row from its whole-row base vector', async () => {
		harness = await open();
		const fingerprint = await schemaFingerprint(harness);
		const created = await post(
			harness,
			'collections.mutate',
			mutationPush(fingerprint, {
				idempotencyKey: 'm4-missing-base-seed',
				seed: 50,
				graph: { action: 'create', collection: 'orders', values: { reference: 'BASE' } }
			})
		);
		const id = String(storedRecordsOf(created.value)?.[0]?.['id']);
		const missing = mutationPush(fingerprint, {
			idempotencyKey: 'm4-missing-base',
			seed: 51,
			graph: { action: 'update', collection: 'orders', values: { id, reference: 'UNSAFE' } }
		});
		const first = await post(harness, 'collections.mutate', missing);
		const replay = await post(harness, 'collections.mutate', missing);

		expect(first.value).toEqual(replay.value);
		expect(first.value).toMatchObject({
			resolution: 'quarantined',
			mutationId: 'm4-missing-base',
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
			seed: 52,
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
				seed: 53,
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
