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
} from '../src/authoring/workspace-schema.js';
import { emptyAuthoredRuntime, type AuthoredRuntime } from '../src/runtime/collections/authored.js';
import { refuse } from '../src/authoring/refusal.js';
import { approveBy } from '../src/authoring/approval-flow.js';
import {
	describePolicy,
	policyRuntimeFunctionsFor
} from '../src/authoring/policy-introspection.js';
import * as Approvals from '../src/runtime/approvals/approvals.js';
import * as Collections from '../src/runtime/collections/collections.js';
import { dispatchInvocation } from '../src/runtime/dispatch.js';
import * as Workspace from '../src/runtime/workspace.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	TEST_ENVIRONMENT,
	type BoltTestRuntime
} from './support/bolt-test-layer.js';
import { seedSession } from './support/fixture-identity.js';
import { unwrapMutationPhase } from './support/mutation-phase.js';

/**
 * The declared write as a browser actually reaches it: over `dispatchInvocation`, with a bearer
 * token, through the boundary that mints the subject.
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
				order_id: field.uuid({ required: true }),
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
			to: { collection: 'order_lines', column: 'order_id' },
			cascade: true
		}
	],
	apps: [app({ name: 'wire', label: 'Wire' })],
	teams: { admin: ['admin-data'] },
	automations: [],
	integrations: [],
	prompt: 'You are the test workspace agent.',
	tools: [],
	skills: [],
	channels: [],
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

type Payload = Readonly<Record<string, unknown>>;
type Transform = (
	inputs: ReadonlyArray<Payload>,
	context: Readonly<{ existing: ReadonlyArray<Payload | undefined> }>
) => unknown;

const ordersModule: AuthoredRuntime['collections']['orders'] = {
	create: {
		input: {
			columns: { reference: true },
			with: { order_line_order: { create: { columns: { sku: true } } } }
		}
	},
	update: {
		input: {
			columns: { reference: true },
			with: { order_line_order: { update: { columns: { sku: true } } } }
		}
	}
};

/**
 * A transform that changes the record on its way in, which is the cheap stand-in for every reason a
 * stored row differs from the submission — a default, a generated column, a derived field.
 */
const stamping: Transform = (inputs, { existing }) =>
	inputs.map((input, index) =>
		existing[index] === undefined
			? { ...input, status: 'accepted', occurred_at: '2026-08-23T05:00:00.000Z' }
			: input
	);

const authoredWith = (transform?: Transform): AuthoredRuntime => ({
	...emptyAuthoredRuntime,
	collections: {
		orders: { ...ordersModule, ...(transform === undefined ? {} : { transform }) },
		order_lines: { create: { input: { columns: { order_id: true, sku: true } } } }
	}
});

const authored = authoredWith(stamping);

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
		queries: input.queries ?? [],
		detached: [],
		pending: input.pending ?? []
	});

/** One push of the declared input (RFC §4.2): a create never carries an id; the engine allocates. */
const mutationPush = (
	fingerprint: string,
	input: Readonly<{
		readonly idempotencyKey: string;
		readonly graph: Readonly<{
			readonly collection: string;
			readonly action: 'create' | 'update' | 'delete';
			readonly inputs: ReadonlyArray<Payload>;
		}>;
		readonly baseVersions?: ReadonlyArray<Readonly<Record<string, unknown>>>;
		readonly issuedAtEpochMs?: number;
		readonly partitionKey?: string;
	}>
) => ({
	protocolVersion: 2,
	idempotencyKey: input.idempotencyKey,
	issuedAtEpochMs: input.issuedAtEpochMs ?? Date.now(),
	partitionKey: input.partitionKey ?? MUTATION_PARTITION_KEY,
	schemaFingerprint: fingerprint,
	graph: input.graph,
	baseVersions: input.baseVersions ?? []
});

const createOrder = (reference: string) => ({
	collection: 'orders',
	action: 'create' as const,
	inputs: [{ reference }]
});

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

/** The request a pending settlement names, or a thrown explanation of why it names none. */
const requestIdOf = (value: unknown): string => {
	const pendingApproval =
		typeof value === 'object' && value !== null ? Reflect.get(value, 'pendingApproval') : undefined;
	const requestId =
		typeof pendingApproval === 'object' && pendingApproval !== null
			? Reflect.get(pendingApproval, 'requestId')
			: undefined;
	if (typeof requestId !== 'string') throw new TypeError('pending settlement has no request id');
	return requestId;
};

describe('collections.write over the wire', () => {
	it('opens a sync handshake without requiring a readable collection', async () => {
		harness = await open(authoredWith(), {
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

		// The handshake resolves no query, so a subject holding only a create grant is not excluded
		// from it: nothing is resolved that the subject could not read. The answer is versioned-prefix
		// facts, not a changelog head.
		expect(value).toMatchObject({ results: [], outcomes: [] });
		expect(value).not.toHaveProperty('head');
		expect(value).not.toHaveProperty('digest');
	}, 60_000);

	it('deduplicates a browser write under its original key and digest and emits one ChangeBatch', async () => {
		harness = await open();
		const fingerprint = await schemaFingerprint(harness);
		const input = mutationPush(fingerprint, {
			idempotencyKey: 'm4-accepted-once',
			graph: createOrder('BROWSER-MUTATION-ONCE')
		});

		const first = await post(harness, 'collections.write', input);
		const replay = await post(harness, 'collections.write', input);
		const changedSequence = await harness.runtime.runPromise(
			Effect.result(
				dispatchInvocation(
					command(
						'collections.write',
						mutationPush(fingerprint, {
							idempotencyKey: 'm4-accepted-once',
							graph: createOrder('BROWSER-MUTATION-ONCE-CHANGED')
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
		// The engine allocated the id (RFC §4.2); the readback and the change both carry it, and the
		// transform's stamp rides the stored row.
		const [stored] = await harness.database.query('select id, status from orders');
		const id = String(stored?.['id']);
		expect(stored).toMatchObject({ status: 'accepted' });
		expect(first.value).toMatchObject({
			resolution: 'accepted',
			mutationId: 'm4-accepted-once',
			schemaFingerprint: fingerprint,
			changes: [expect.objectContaining({ collection: 'orders', operation: 'insert', id })]
		});
		expect(storedRecordsOf(first.value)?.[0]).toMatchObject({ id, status: 'accepted' });
		// The authoritative read is the sync handshake: one prefix resolution beside the pending
		// journal outcome.
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
			results: [
				{
					key: 'orders',
					rows: [expect.objectContaining({ reference: 'BROWSER-MUTATION-ONCE' })]
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

	it('refuses a create whose input names an id, root or nested, and allocates when it does not', async () => {
		harness = await open();
		const fingerprint = await schemaFingerprint(harness);
		const rootId = '00000000-0000-4000-8000-000000000052';
		const childId = '00000000-0000-4000-8000-000000000152';

		// A person cannot name a created record's id: the key is not part of the declared input, so
		// the push is rejected as a refusal before anything is written (`admitSubmission`).
		const named = await post(
			harness,
			'collections.write',
			mutationPush(fingerprint, {
				idempotencyKey: 'm4-client-named-root',
				graph: {
					collection: 'orders',
					action: 'create',
					inputs: [{ id: rootId, reference: 'CLIENT-ID' }]
				}
			})
		);
		expect(named.value).toMatchObject({
			resolution: 'rejected',
			code: 'refused',
			message: expect.stringContaining('id is not part of the declared create input')
		});
		const nested = await post(
			harness,
			'collections.write',
			mutationPush(fingerprint, {
				idempotencyKey: 'm4-client-named-child',
				graph: {
					collection: 'orders',
					action: 'create',
					inputs: [
						{
							reference: 'CLIENT-CHILD-ID',
							order_line_order: { create: [{ id: childId, sku: 'CLIENT-CHILD' }] }
						}
					]
				}
			})
		);
		expect(nested.value).toMatchObject({ resolution: 'rejected', code: 'refused' });
		expect(await harness.database.query('select id from orders')).toEqual([]);
		expect(await harness.database.query('select id from order_lines')).toEqual([]);

		const allocated = await post(
			harness,
			'collections.write',
			mutationPush(fingerprint, {
				idempotencyKey: 'm4-allocated',
				graph: {
					collection: 'orders',
					action: 'create',
					inputs: [{ reference: 'ALLOCATED', order_line_order: { create: [{ sku: 'LINE' }] } }]
				}
			})
		);
		expect(allocated.value).toMatchObject({ resolution: 'accepted' });
		const [order] = await harness.database.query('select id from orders');
		expect(order?.['id']).not.toBe(rootId);
		expect(await harness.database.query('select order_id, sku from order_lines')).toEqual([
			{ order_id: order?.['id'], sku: 'LINE' }
		]);
	});

	it('durably rejects and replays a future-issued journal push without applying it', async () => {
		harness = await open();
		const fingerprint = await schemaFingerprint(harness);
		const input = mutationPush(fingerprint, {
			idempotencyKey: 'm4-future-issued',
			issuedAtEpochMs: Date.now() + 6 * 60 * 1_000,
			graph: createOrder('FUTURE')
		});

		const first = await post(harness, 'collections.write', input);
		const replay = await post(harness, 'collections.write', input);

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
		let transformRuns = 0;
		harness = await open(
			authoredWith(() => {
				transformRuns += 1;
				return Effect.fail(new Error('mutation preparation exploded'));
			})
		);
		const fingerprint = await schemaFingerprint(harness);
		const input = mutationPush(fingerprint, {
			idempotencyKey: 'm4-unclassified-failure',
			graph: createOrder('BROKEN')
		});

		const first = await post(harness, 'collections.write', input);
		const replay = await post(harness, 'collections.write', input);

		expect(first.value).toEqual(replay.value);
		expect(first.value).toMatchObject({
			resolution: 'quarantined',
			mutationId: 'm4-unclassified-failure',
			schemaFingerprint: fingerprint,
			reason: expect.stringContaining('mutation preparation exploded')
		});
		expect(transformRuns).toBe(1);
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
		harness = await open(authoredWith(), {
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
			'collections.write',
			mutationPush(fingerprint, { idempotencyKey: mutationId, graph: createOrder('WRITE-ONLY') })
		);
		expect(accepted.value).toMatchObject({ resolution: 'accepted', records: [] });

		// Confirmation without read entitlement: the handshake resolves no queries but still answers
		// the journal's terminal outcome for the pending mutation id.
		const status = await syncConnect(harness, { pending: [mutationId] });
		expect(status.value).toMatchObject({
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
			'collections.write',
			mutationPush(fingerprint, {
				idempotencyKey: 'm4-partition-bound',
				graph: createOrder('LANDED')
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
						'collections.write',
						mutationPush(fingerprint, {
							idempotencyKey: 'm4-partition-bound',
							partitionKey: 'sha256:unissued-partition',
							graph: createOrder('MUST-NOT-LAND')
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
			'collections.write',
			mutationPush(fingerprint, {
				idempotencyKey: 'm4-switched-actor',
				graph: createOrder('WRONG-ACTOR')
			})
		);
		expect(firstActor.value).toMatchObject({
			resolution: 'accepted',
			mutationId: 'm4-switched-actor'
		});
		await seedSession(harness, { token: 'other-admin-token', user: 'user-other', team: 'admin' });
		const invocation = command(
			'collections.write',
			mutationPush(fingerprint, {
				idempotencyKey: 'm4-switched-actor',
				graph: createOrder('WRONG-ACTOR')
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
		expect(await harness.database.query('select reference from orders')).toEqual([
			{ reference: 'WRONG-ACTOR' },
			{ reference: 'WRONG-ACTOR' }
		]);
	});

	it('durably replays an authored browser-mutation rejection without rerunning the transform', async () => {
		let transformRuns = 0;
		harness = await open(
			authoredWith(() => {
				transformRuns += 1;
				return refuse('This order cannot be created.');
			})
		);
		const fingerprint = await schemaFingerprint(harness);
		const rejected = mutationPush(fingerprint, {
			idempotencyKey: 'm4-rejected',
			graph: createOrder('REFUSED')
		});
		const first = await post(harness, 'collections.write', rejected);
		const replay = await post(harness, 'collections.write', rejected);

		expect(first.value).toEqual(replay.value);
		expect(first.value).toMatchObject({
			resolution: 'rejected',
			mutationId: 'm4-rejected',
			code: 'refused',
			message: 'This order cannot be created.',
			schemaFingerprint: fingerprint
		});
		expect(transformRuns).toBe(1);
		expect(await harness.database.query('select id from orders')).toEqual([]);
	});

	/** The fixture with every order create routed through review by `Reviewers`. */
	const reviewed = (flow: () => ReturnType<typeof approveBy>) => {
		const approvalPolicy = describePolicy('admin-data', {
			description: 'Orders require review.',
			grants: {
				orders: { read: {}, mutate: { new: { approval: { flow, superceded_by: [] } } } }
			}
		});
		const policyFunctions = policyRuntimeFunctionsFor([approvalPolicy]);
		return open(
			{
				...authoredWith(),
				approvalFlows: policyFunctions.approvalFlows,
				policyAuthorizations: policyFunctions.authorizations
			},
			{
				...definition,
				policies: [approvalPolicy],
				teams: { admin: ['admin-data'], Reviewers: [] }
			}
		);
	};

	it('commits an approval-gated browser write provisionally and restores it on rejection', async () => {
		let approvalRuns = 0;
		harness = await reviewed(() => {
			approvalRuns += 1;
			return approveBy('Reviewers');
		});
		const fingerprint = await schemaFingerprint(harness);
		const pending = mutationPush(fingerprint, {
			idempotencyKey: 'm4-pending-approval',
			graph: createOrder('REVIEW')
		});
		const first = await post(harness, 'collections.write', pending);
		const replay = await post(harness, 'collections.write', pending);

		// The provisional commit echoes its changes like any commit; the replay has none to echo.
		const { changes: _changes, ...settled } = first.value as Readonly<Record<string, unknown>>;
		expect(replay.value).toEqual(settled);
		expect(first.value).toMatchObject({
			resolution: 'accepted',
			mutationId: 'm4-pending-approval',
			schemaFingerprint: fingerprint,
			pendingApproval: { collection: 'orders', action: 'create' }
		});
		expect(approvalRuns).toBe(1);
		const requestId = requestIdOf(first.value);
		// RFC §4.8: the proposal is a real row, stamped with the request that holds it.
		expect(await harness.database.query('select reference, approval_id from orders')).toEqual([
			{ reference: 'REVIEW', approval_id: requestId }
		]);

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
		// The restore: a row born under the hold is deleted, and the browser learns the refusal.
		expect(await harness.database.query('select id from orders')).toEqual([]);
		const status = await syncConnect(harness, { pending: ['m4-pending-approval'] });
		expect(status.value).toMatchObject({
			results: [],
			outcomes: [
				{
					id: 'm4-pending-approval',
					status: { resolution: 'rejected', code: 'refused' }
				}
			]
		});
	});

	it('seals an approved browser write once, however many resumes race, and replays the committed outcome', async () => {
		harness = await reviewed(() => approveBy('Reviewers'));
		const runtime = harness;
		const first = await post(
			runtime,
			'collections.write',
			mutationPush(await schemaFingerprint(runtime), {
				idempotencyKey: 'approved-concurrent-resume',
				graph: createOrder('CONCURRENT')
			})
		);
		const requestId = requestIdOf(first.value);
		const collections = await runtime.runtime.runPromise(Collections.Service);
		const unapproved = await runtime.runtime.runPromise(
			collections.resume(runtime.effectId('approval-resume-pending'), requestId).pipe(Effect.result)
		);
		expect(unapproved).toMatchObject({
			_tag: 'Failure',
			failure: { reason: 'approval has not been approved' }
		});
		await runtime.runtime.runPromise(
			Effect.gen(function* () {
				const approvals = yield* Approvals.Service;
				const state = yield* approvals.status(runtime.effectId('approval-status'), requestId);
				if (state?._tag !== 'Pending') throw new TypeError('approval is not pending');
				yield* approvals.decide(
					runtime.effectId('approval-approve'),
					{ ...adminSubject, admin: false, teamPath: ['Reviewers'] },
					state,
					'approve'
				);
			})
		);
		const outcomes = await runtime.runtime.runPromise(
			Effect.all(
				['first', 'second'].map((name) =>
					collections
						.resume(runtime.effectId(`approval-resume-${name}`), requestId)
						.pipe(Effect.result)
				),
				{ concurrency: 'unbounded' }
			)
		);
		expect(outcomes.filter((outcome) => outcome._tag === 'Success').length).toBeGreaterThan(0);
		// The seal clears the stamp exactly once: the row moved one version past the hold.
		expect(
			await runtime.database.query('select reference, approval_id, row_version from orders')
		).toEqual([{ reference: 'CONCURRENT', approval_id: null, row_version: 2 }]);
		const [approval] = await runtime.database.query(
			'select status, applied_at, row_version from approval_request where id = $1',
			[requestId]
		);
		expect(approval).toMatchObject({ status: 'APPROVED', applied_at: expect.anything() });
		expect(
			await runtime.database.query(
				'select outcome from bolt_browser_mutation where idempotency_key = $1',
				['approved-concurrent-resume']
			)
		).toEqual([{ outcome: expect.objectContaining({ _tag: 'Committed' }) }]);
		await runtime.runtime.runPromise(
			collections.resume(runtime.effectId('approval-resume-later'), requestId)
		);
		expect(
			await runtime.database.query(
				'select status, applied_at, row_version from approval_request where id = $1',
				[requestId]
			)
		).toEqual([approval]);
		expect(await runtime.database.query('select row_version from orders')).toEqual([
			{ row_version: 2 }
		]);
	});

	it('durably rejects a mutation stated against a retired schema, and replays the refusal', async () => {
		harness = await open(authored);
		await schemaFingerprint(harness);
		const unknownInput = mutationPush('schema:unknown-old', {
			idempotencyKey: 'm4-reject-unknown',
			graph: createOrder('UNKNOWN')
		});
		const unknown = await post(harness, 'collections.write', unknownInput);
		const unknownReplay = await post(harness, 'collections.write', unknownInput);

		expect(unknown.value).toEqual(unknownReplay.value);
		expect(unknown.value).toMatchObject({
			resolution: 'rejected',
			code: 'refused',
			mutationId: 'm4-reject-unknown'
		});
		expect(await harness.database.query('select id from orders')).toEqual([]);
	});

	it('durably rejects a browser update whose observed version is stale, root or nested child', async () => {
		harness = await open();
		const fingerprint = await schemaFingerprint(harness);
		const created = await post(
			harness,
			'collections.write',
			mutationPush(fingerprint, {
				idempotencyKey: 'm4-conflict-seed',
				graph: {
					collection: 'orders',
					action: 'create',
					inputs: [{ reference: 'BASE', order_line_order: { create: [{ sku: 'BASE-LINE' }] } }]
				}
			})
		);
		const id = String(storedRecordsOf(created.value)?.[0]?.['id']);
		const [line] = await harness.database.query('select id, row_version from order_lines');
		const lineId = String(line?.['id']);
		const stale = mutationPush(fingerprint, {
			idempotencyKey: 'm4-stale-update',
			graph: { collection: 'orders', action: 'update', inputs: [{ id, reference: 'STALE' }] },
			baseVersions: [{ row: { collection: 'orders', recordId: id }, rowVersion: 99 }]
		});
		const first = await post(harness, 'collections.write', stale);
		const replay = await post(harness, 'collections.write', stale);
		expect(first.value).toEqual(replay.value);
		expect(first.value).toMatchObject({
			resolution: 'rejected',
			mutationId: 'm4-stale-update',
			code: 'conflict',
			schemaFingerprint: fingerprint
		});

		// The caller submitted the child itself, so a stale version on it is a conflict too.
		const staleChild = await post(
			harness,
			'collections.write',
			mutationPush(fingerprint, {
				idempotencyKey: 'm4-stale-child',
				graph: {
					collection: 'orders',
					action: 'update',
					inputs: [
						{ id, order_line_order: { update: [{ id: lineId, set: { sku: 'STALE-LINE' } }] } }
					]
				},
				baseVersions: [
					{ row: { collection: 'orders', recordId: id }, rowVersion: 1 },
					{ row: { collection: 'order_lines', recordId: lineId }, rowVersion: 99 }
				]
			})
		);
		expect(staleChild.value).toMatchObject({ resolution: 'rejected', code: 'conflict' });
		expect(await harness.database.query('select reference from orders')).toEqual([
			{ reference: 'BASE' }
		]);
		expect(await harness.database.query('select sku from order_lines')).toEqual([
			{ sku: 'BASE-LINE' }
		]);

		// The versions the browser really read are admitted: the refusal above was the version.
		const fresh = await post(
			harness,
			'collections.write',
			mutationPush(fingerprint, {
				idempotencyKey: 'm4-fresh-child',
				graph: {
					collection: 'orders',
					action: 'update',
					inputs: [
						{ id, order_line_order: { update: [{ id: lineId, set: { sku: 'FRESH-LINE' } }] } }
					]
				},
				baseVersions: [
					{ row: { collection: 'orders', recordId: id }, rowVersion: 1 },
					{
						row: { collection: 'order_lines', recordId: lineId },
						rowVersion: Number(line?.['row_version'])
					}
				]
			})
		);
		expect(fresh.value).toMatchObject({ resolution: 'accepted' });
		expect(await harness.database.query('select sku from order_lines')).toEqual([
			{ sku: 'FRESH-LINE' }
		]);
	});
});
