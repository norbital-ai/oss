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
import { app, collection, field, policy, workspace } from '../../src/authoring/workspace-schema.js';
import {
	emptyAuthoredRuntime,
	type AuthoredRuntime
} from '../../src/runtime/collections/authored.js';
import { dispatchInvocation } from '../../src/runtime/dispatch.js';
import { makeBoltTestRuntime, type BoltTestRuntime } from '../support/bolt-test-layer.js';
import { seedSession } from '../support/fixture-identity.js';

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

const open = async (runtimeAuthored: AuthoredRuntime = authored): Promise<BoltTestRuntime> => {
	const runtime = await makeBoltTestRuntime(definition, { authored: runtimeAuthored });
	await seedSession(runtime, { token: 'admin-token', user: 'user-admin', team: 'admin' });
	return runtime;
};

const post = async (runtime: BoltTestRuntime, name: string, input: unknown) =>
	runtime.runtime.runPromise(dispatchInvocation(command(name, input)));

describe('collections.mutate over the wire', () => {
	it('assigns a new root an id and answers with exactly the stored root record', async () => {
		harness = await open();

		const response = await post(harness, 'collections.mutate', {
			collection: 'orders',
			values: { reference: 'ORD-1' }
		});

		const rows = await harness.database.query('select id from orders');
		expect(rows).toHaveLength(1);
		expect(response.value).toEqual({
			records: [
				expect.objectContaining({
					id: rows[0]?.['id'],
					reference: 'ORD-1',
					status: 'accepted',
					row_version: 1
				})
			]
		});
	});

	it('assigns a distinct id per new root', async () => {
		harness = await open();

		await post(harness, 'collections.mutate', {
			collection: 'orders',
			values: { reference: 'ORD-1' }
		});
		await post(harness, 'collections.mutate', {
			collection: 'orders',
			values: { reference: 'ORD-2' }
		});

		const rows = await harness.database.query('select id from orders');
		expect(new Set(rows.map((row) => row['id'])).size).toBe(2);
	});

	it('answers with the row as stored, not with the values that were posted', async () => {
		harness = await open();

		const response = await post(harness, 'collections.mutate', {
			collection: 'orders',
			values: { reference: 'ORD-1' }
		});

		const records = storedRecordsOf(response.value);
		expect(records).toHaveLength(1);
		expect(response.value).toEqual({ records });
		const record = records?.[0] ?? {};
		// The hook's field, which the caller never sent — and which the old response, being the
		// caller's own submission, could not have contained.
		expect(record['status']).toBe('accepted');
		// And a column only the database can fill: its default, applied at insert.
		expect(record['row_version']).toBe(1);
		expect(record['created_at']).toBeDefined();
	});

	it('writes a graph posted in one body as one parent and its children', async () => {
		harness = await open();

		const response = await post(harness, 'collections.mutate', {
			collection: 'orders',
			values: {
				reference: 'ORD-1',
				order_line_order: [{ sku: 'a-1' }, { sku: 'a-2' }]
			}
		});

		const orders = await harness.database.query('select id from orders');
		const lines = await harness.database.query(
			'select order_id, sku from order_lines order by sku'
		);
		expect(orders).toHaveLength(1);
		expect(lines.map((row) => row['sku'])).toEqual(['a-1', 'a-2']);
		// The foreign key nobody wrote: filled from the id the server assigned the parent, which is
		// the reason a client could not have minted it.
		expect(lines.map((row) => row['order_id'])).toEqual([orders[0]?.['id'], orders[0]?.['id']]);
		// The children are not read back — that would cost a query per child collection — so the
		// answer is the parent, and it does not pretend otherwise.
		const records = storedRecordsOf(response.value);
		expect(records).toHaveLength(1);
		expect(response.value).toEqual({ records });
	});

	it('runs a relationship introduced by a root hook through the child mutation pipeline', async () => {
		const childInputs: Array<unknown> = [];
		harness = await open({
			...emptyAuthoredRuntime,
			hooks: {
				orders: {
					create: {
						perRecord: {
							before: {
								description: 'Adds a child the submitted scalar payload did not contain.',
								handler: (context: unknown) => ({
									...(context as { readonly input: Record<string, unknown> }).input,
									order_line_order: [{ sku: 'hook-child' }]
								})
							}
						}
					}
				},
				order_lines: {
					create: {
						perRecord: {
							before: {
								description: 'Proves the hook-added child ran its own create hook.',
								handler: (context: unknown) => {
									const input = (context as { readonly input: Record<string, unknown> }).input;
									childInputs.push(input);
									return { ...input, sku: `${String(input['sku'])}-prepared` };
								}
							}
						}
					}
				}
			}
		});

		await post(harness, 'collections.mutate', {
			collection: 'orders',
			values: { reference: 'HOOK-1' }
		});

		expect(childInputs).toHaveLength(1);
		expect(await harness.database.query('select sku from order_lines')).toEqual([
			{ sku: 'hook-child-prepared' }
		]);
	});

	it('accepts identities at the root and nested levels', async () => {
		harness = await open();

		const created = await post(harness, 'collections.mutate', {
			collection: 'orders',
			values: {
				reference: 'ORD-1',
				order_line_order: [{ sku: 'a-1' }, { sku: 'a-2' }]
			}
		});
		const root = storedRecordsOf(created.value)?.[0];
		const children = await harness.database.query('select id, sku from order_lines order by sku');
		const first = children[0];
		const second = children[1];
		expect(root).toBeDefined();
		expect(first).toBeDefined();
		expect(second).toBeDefined();

		const updated = await post(harness, 'collections.mutate', {
			collection: 'orders',
			values: {
				id: root?.['id'],
				reference: 'ORD-1-revised',
				order_line_order: [
					{ id: first?.['id'], sku: 'a-1-revised' },
					{ id: second?.['id'], sku: 'a-2' }
				]
			}
		});

		const storedRoot = storedRecordsOf(updated.value)?.[0] ?? {};
		expect(updated.value).toEqual({ records: [storedRoot] });
		expect(storedRoot['id']).toBe(root?.['id']);
		expect(storedRoot['reference']).toBe('ORD-1-revised');
		expect(storedRoot['row_version']).toBe(2);
		expect(await harness.database.query('select id, sku from order_lines order by sku')).toEqual([
			{ id: first?.['id'], sku: 'a-1-revised' },
			{ id: second?.['id'], sku: 'a-2' }
		]);
	});

	it('checks a child of the graph the same way it checks the parent', async () => {
		harness = await open();

		const outcome = await harness.runtime.runPromise(
			Effect.result(
				dispatchInvocation(
					command('collections.mutate', {
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
		expect(await harness.database.query('select id from orders')).toHaveLength(0);
	});

	it('refuses a key that is neither a column nor a declared relation, and writes nothing', async () => {
		harness = await open();

		const outcome = await harness.runtime.runPromise(
			Effect.result(
				dispatchInvocation(
					command('collections.mutate', {
						collection: 'orders',
						values: { reference: 'ORD-1', order_line_orders: [{ sku: 'a-1' }] }
					})
				)
			)
		);

		expect(outcome._tag).toBe('Failure');
		expect(await harness.database.query('select id from orders')).toHaveLength(0);
		expect(await harness.database.query('select id from order_lines')).toHaveLength(0);
	});

	it('refuses a malformed root identity before writing', async () => {
		harness = await open();

		const outcome = await harness.runtime.runPromise(
			Effect.result(
				dispatchInvocation(
					command('collections.mutate', {
						collection: 'orders',
						values: { id: '', reference: 'ORD-1' }
					})
				)
			)
		);

		expect(outcome._tag).toBe('Failure');
		expect(await harness.database.query('select id from orders')).toHaveLength(0);
	});

	it.each([
		['row_version', 99],
		['approval_id', '0f5f0f6e-2c2e-4f3f-9b3a-9b9c9d9e9f00'],
		['created_at', '2026-01-01T00:00:00.000Z']
	] as const)('refuses the system-managed root field %s', async (field, value) => {
		harness = await open();
		const outcome = await harness.runtime.runPromise(
			Effect.result(
				dispatchInvocation(
					command('collections.mutate', {
						collection: 'orders',
						values: { reference: 'ORD-1', [field]: value }
					})
				)
			)
		);
		expect(outcome._tag).toBe('Failure');
		expect(await harness.database.query('select id from orders')).toEqual([]);
	});

	it('refuses a system-managed field on a nested row', async () => {
		harness = await open();
		const outcome = await harness.runtime.runPromise(
			Effect.result(
				dispatchInvocation(
					command('collections.mutate', {
						collection: 'orders',
						values: {
							reference: 'ORD-1',
							order_line_order: [{ sku: 'a-1', updated_at: '2026-01-01T00:00:00.000Z' }]
						}
					})
				)
			)
		);
		expect(outcome._tag).toBe('Failure');
		expect(await harness.database.query('select id from orders')).toEqual([]);
		expect(await harness.database.query('select id from order_lines')).toEqual([]);
	});
});

describe('the retired browser write commands', () => {
	it.each([
		['collections.create', { collection: 'orders', values: { reference: 'ORD-1' } }],
		[
			'collections.update',
			{
				collection: 'orders',
				id: '0f5f0f6e-2c2e-4f3f-9b3a-9b9c9d9e9f00',
				values: { reference: 'ORD-1' }
			}
		],
		['collections.delete', { collection: 'orders', id: '0f5f0f6e-2c2e-4f3f-9b3a-9b9c9d9e9f00' }],
		[
			'collections.createMany',
			{
				records: [
					{
						collection: 'orders',
						id: '0f5f0f6e-2c2e-4f3f-9b3a-9b9c9d9e9f00',
						values: { reference: 'ORD-1' }
					}
				]
			}
		]
	] as const)(
		'refuses %s rather than preserving a second mutation surface',
		async (name, input) => {
			harness = await open();

			const outcome = await harness.runtime.runPromise(
				Effect.result(dispatchInvocation(command(name, input)))
			);

			expect(outcome._tag).toBe('Failure');
			expect(await harness.database.query('select id from orders')).toHaveLength(0);
		}
	);
});
