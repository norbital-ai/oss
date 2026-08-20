import { afterEach, describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import {
	EnvironmentName,
	Invocation,
	InvocationId,
	PROTOCOL_VERSION,
	ReleaseId,
	storedRecordsOf,
	TenantId
} from '@norbital-ai/bolt-protocol';
import { app, collection, field, policy, workspace } from '../../src/authoring/index.js';
import { emptyAuthoredRuntime } from '../../src/runtime/collections/authored.js';
import { dispatchInvocation } from '../../src/runtime/dispatch.js';
import { makeBoltTestRuntime, type BoltTestRuntime } from '../support/bolt-test-layer.js';
import { seedSession } from '../support/fixture-identity.js';

/**
 * The create command as a browser actually reaches it: over `dispatchInvocation`, with a bearer
 * token, through the boundary that mints the subject.
 *
 * Reached this way rather than by calling the collections service, because the three things under
 * test are properties of the *command*, not of the service beneath it. Who assigns the id, what
 * shape a body may have, and what the response is entitled to say are all decisions the boundary
 * makes, and the service has never had an opinion about any of them.
 */
const definition = workspace({
	name: 'wire',
	version: '1.0.0',
	collections: [
		collection({
			name: 'orders',
			fields: {
				reference: field.string({ required: true }),
				status: field.string({ required: false })
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
			to: { collection: 'orders', column: 'norbital_id' }
		}
	],
	apps: [app({ name: 'wire', label: 'Wire' })],
	teams: { admin: ['admin-data'] },
	agents: [],
	automations: [],
	channels: [],
	integrations: [],
	requiredFacilities: [],
	policies: [
		policy({
			name: 'admin-data',
			effect: 'allow',
			grants: [
				{ collection: 'orders', action: 'create' },
				{ collection: 'orders', action: 'read' },
				{ collection: 'orders', action: 'update' },
				{ collection: 'order_lines', action: 'create' },
				{ collection: 'order_lines', action: 'read' }
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
			create: {
				perRecord: {
					before: {
						description: 'Stamps the status the workspace, not the caller, decides.',
						handler: (context: unknown) => ({
							...(context as { readonly input: Record<string, unknown> }).input,
							status: 'accepted'
						})
					}
				}
			}
		}
	}
};

const scope = {
	tenantId: TenantId.make('test-tenant'),
	environment: EnvironmentName.make('development'),
	releaseId: ReleaseId.make('local')
};

let sequence = 0;
const command = (name: string, input: unknown) =>
	Invocation.cases.Command.make({
		protocolVersion: PROTOCOL_VERSION,
		id: InvocationId.make(`command-${name}-${(sequence += 1)}`),
		scope,
		deadlineEpochMs: Date.now() + 30_000,
		command: name,
		input: input as never,
		headers: { authorization: ['Bearer admin-token'] }
	});

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

const open = async (): Promise<BoltTestRuntime> => {
	const runtime = await makeBoltTestRuntime(definition, { authored });
	await seedSession(runtime, { token: 'admin-token', user: 'user-admin', team: 'admin' });
	return runtime;
};

const post = async (runtime: BoltTestRuntime, name: string, input: unknown) =>
	runtime.runtime.runPromise(dispatchInvocation(command(name, input)));

describe('collections.create over the wire', () => {
	it('assigns the id itself, and answers with it', async () => {
		harness = await open();

		const response = await post(harness, 'collections.create', {
			collection: 'orders',
			values: { reference: 'ORD-1' }
		});

		const rows = await harness.database.query('select norbital_id from orders');
		expect(rows).toHaveLength(1);
		// The body carried no id at all, so this one can only have come from the server.
		expect((response.value as { readonly norbital_id: unknown }).norbital_id).toBe(
			rows[0]?.['norbital_id']
		);
	});

	it('assigns a distinct id per create', async () => {
		harness = await open();

		await post(harness, 'collections.create', {
			collection: 'orders',
			values: { reference: 'ORD-1' }
		});
		await post(harness, 'collections.create', {
			collection: 'orders',
			values: { reference: 'ORD-2' }
		});

		const rows = await harness.database.query('select norbital_id from orders');
		expect(new Set(rows.map((row) => row['norbital_id'])).size).toBe(2);
	});

	it('answers with the row as stored, not with the values that were posted', async () => {
		harness = await open();

		const response = await post(harness, 'collections.create', {
			collection: 'orders',
			values: { reference: 'ORD-1' }
		});

		const records = storedRecordsOf(response.value);
		expect(records).toHaveLength(1);
		const record = records?.[0] ?? {};
		// The hook's field, which the caller never sent — and which the old response, being the
		// caller's own submission, could not have contained.
		expect(record['status']).toBe('accepted');
		// And a column only the database can fill: its default, applied at insert.
		expect(record['norbital_row_version']).toBe(1);
		expect(record['norbital_created_at']).toBeDefined();
	});

	it('writes a graph posted in one body as one parent and its children', async () => {
		harness = await open();

		const response = await post(harness, 'collections.create', {
			collection: 'orders',
			values: {
				reference: 'ORD-1',
				order_line_order: [{ sku: 'a-1' }, { sku: 'a-2' }]
			}
		});

		const orders = await harness.database.query('select norbital_id from orders');
		const lines = await harness.database.query(
			'select order_id, sku from order_lines order by sku'
		);
		expect(orders).toHaveLength(1);
		expect(lines.map((row) => row['sku'])).toEqual(['a-1', 'a-2']);
		// The foreign key nobody wrote: filled from the id the server assigned the parent, which is
		// the reason a client could not have minted it.
		expect(lines.map((row) => row['order_id'])).toEqual([
			orders[0]?.['norbital_id'],
			orders[0]?.['norbital_id']
		]);
		// The children are not read back — that would cost a query per child collection — so the
		// answer is the parent, and it does not pretend otherwise.
		expect(storedRecordsOf(response.value)).toHaveLength(1);
	});

	it('refuses a norbital_id smuggled in through the values', async () => {
		harness = await open();

		// Dropping `id` from the create body leaves exactly one way back in, so it is closed here:
		// on the parent this would have routed the payload through the update branch and made
		// `collections.create` perform an update.
		const outcome = await harness.runtime.runPromise(
			Effect.result(
				dispatchInvocation(
					command('collections.create', {
						collection: 'orders',
						values: { norbital_id: '0f5f0f6e-2c2e-4f3f-9b3a-9b9c9d9e9f00', reference: 'ORD-1' }
					})
				)
			)
		);

		expect(outcome._tag).toBe('Failure');
		expect(await harness.database.query('select norbital_id from orders')).toHaveLength(0);
	});

	it('checks a child of the graph the same way it checks the parent', async () => {
		harness = await open();

		const outcome = await harness.runtime.runPromise(
			Effect.result(
				dispatchInvocation(
					command('collections.create', {
						collection: 'orders',
						values: {
							reference: 'ORD-1',
							// `label` is a generated column on `order_lines`. Writing one is refused at this
							// boundary, and before the graph walk existed that refusal only reached the top
							// level — so the same edit, moved one level down, was reported nowhere and the
							// value silently stayed as the database computed it.
							order_line_order: [{ sku: 'a-1', label: 'mine' }]
						}
					})
				)
			)
		);

		expect(outcome._tag).toBe('Failure');
		expect(JSON.stringify(outcome)).toContain('label');
		expect(await harness.database.query('select norbital_id from orders')).toHaveLength(0);
	});

	it('refuses a key that is neither a column nor a declared relation, and writes nothing', async () => {
		harness = await open();

		const outcome = await harness.runtime.runPromise(
			Effect.result(
				dispatchInvocation(
					command('collections.create', {
						collection: 'orders',
						values: { reference: 'ORD-1', order_line_orders: [{ sku: 'a-1' }] }
					})
				)
			)
		);

		expect(outcome._tag).toBe('Failure');
		expect(await harness.database.query('select norbital_id from orders')).toHaveLength(0);
		expect(await harness.database.query('select norbital_id from order_lines')).toHaveLength(0);
	});
});

describe('collections.update over the wire', () => {
	it('answers with the row as stored, including the version the database bumped', async () => {
		harness = await open();

		const created = await post(harness, 'collections.create', {
			collection: 'orders',
			values: { reference: 'ORD-1' }
		});
		const id = (created.value as { readonly norbital_id: string }).norbital_id;

		const updated = await post(harness, 'collections.update', {
			collection: 'orders',
			id,
			values: { reference: 'ORD-1-revised' }
		});

		const record = storedRecordsOf(updated.value)?.[0] ?? {};
		expect(record['norbital_id']).toBe(id);
		expect(record['reference']).toBe('ORD-1-revised');
		expect(record['norbital_row_version']).toBe(2);
	});
});
