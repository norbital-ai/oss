import { describe, expect, it, afterEach } from 'vitest';
import { Effect } from 'effect';
import { EffectId } from '@norbital-ai/bolt-protocol';
import { app, collection, field, policy, workspace } from '../src/authoring/workspace-schema.js';
import * as Collections from '../src/runtime/collections/collections.js';
import { SyncCommit } from '../src/runtime/facilities/services.js';
import {
	emptyAuthoredRuntime,
	type AuthoredRuntime
} from '../src/runtime/collections/authored.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	type BoltTestRuntime
} from './support/bolt-test-layer.js';

/**
 * A write's change set does not depend on how many rows it touched.
 *
 * The payroll failure: a run for a company with ~85 payslips settles, and every registered query on
 * the writer's stream hears nothing — the runs table stays empty until reload — while a 15-employee
 * run on the same build delivers its changes. The browser only heals on a later re-register.
 *
 * The shape is one declared write whose graph is thousands of operations: an insert per row plus an
 * update pinning each source row the graph consumed. This pins the invariant at that size, where the
 * small fixtures cannot.
 */
const definition = workspace({
	name: 'large-write',
	version: '1.0.0',
	collections: [
		collection({
			name: 'batches',
			fields: { reference: field.string({ required: true }) }
		}),
		collection({
			name: 'items',
			fields: {
				batch_id: field.uuid({ required: false }),
				sku: field.string({ required: true })
			}
		}),
		collection({
			name: 'sources',
			fields: {
				batch_id: field.uuid({ required: false }),
				body: field.string({ required: true })
			}
		})
	],
	relations: [
		{
			name: 'item_batch',
			source: 'batches',
			target: 'items',
			cardinality: 'many',
			from: { collection: 'batches', column: 'id' },
			to: { collection: 'items', column: 'batch_id' },
			cascade: true
		},
		{
			name: 'source_batch',
			source: 'batches',
			target: 'sources',
			cardinality: 'many',
			from: { collection: 'batches', column: 'id' },
			to: { collection: 'sources', column: 'batch_id' },
			setNull: true
		}
	],
	apps: [app({ name: 'large', label: 'Large' })],
	policies: [
		policy({
			name: 'admin-data',
			effect: 'allow',
			grants: (['batches', 'items', 'sources'] as const).flatMap((name) =>
				(['create', 'read', 'update', 'delete'] as const).map((action) => ({
					collection: name,
					action
				}))
			)
		})
	],
	tools: [],
	skills: [],
	envoys: [],
	teams: { admin: ['admin-data'] },
	automations: [],
	integrations: [],
	requiredFacilities: [],
	prompt: 'You are the test workspace agent.'
});

const itemSelection = {
	create: { columns: { sku: true } },
	update: { columns: { sku: true } },
	link: { columns: {} },
	unlink: { columns: {} },
	delete: {}
} as const;
const sourceSelection = {
	create: { columns: { body: true } },
	update: { columns: { body: true } },
	link: { columns: {} },
	unlink: { columns: {} },
	delete: {}
} as const;
const declared: AuthoredRuntime['collections'] = {
	batches: {
		create: {
			input: {
				columns: { reference: true },
				with: { item_batch: itemSelection, source_batch: sourceSelection }
			}
		},
		update: { input: { columns: { reference: true } } },
		delete: {}
	},
	items: {
		create: { input: { columns: { batch_id: true, sku: true } } },
		update: { input: { columns: { batch_id: true, sku: true } } },
		delete: {}
	},
	sources: {
		create: { input: { columns: { batch_id: true, body: true } } },
		update: { input: { columns: { batch_id: true, body: true } } },
		delete: {}
	}
};
const authored: AuthoredRuntime = { ...emptyAuthoredRuntime, collections: declared };

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

const ITEMS_PER_BATCH = 30;
const BATCHES = 100;

const SOURCE_COUNT = BATCHES * ITEMS_PER_BATCH;

describe('a large write publishes its changes', () => {
	it('delivers one change per row it committed, at payroll size', async () => {
		harness = await makeBoltTestRuntime(definition, { authored });
		const inputs = Array.from({ length: BATCHES }, (_, index) => ({
			reference: `BATCH-${index}`,
			item_batch: {
				create: Array.from({ length: ITEMS_PER_BATCH }, (_, item) => ({
					sku: `SKU-${index}-${item}`
				}))
			}
		}));
		const result = await harness.runtime.runPromise(
			Effect.gen(function* () {
				const collections = yield* Collections.Service;
				const syncCommit = yield* SyncCommit.Service;
				const written = yield* collections.write(
					EffectId.make('large-write'),
					adminSubject,
					[{ collection: 'batches', action: 'create', inputs }]
				);
				const changes = yield* syncCommit.drainChanges;
				return { written, changes };
			})
		);
		const expected = BATCHES * (ITEMS_PER_BATCH + 1);
		expect(result.written.records.length).toBe(BATCHES);
		expect(result.changes.length).toBe(expected);
		expect(result.changes.filter((change) => change.collection === 'items')).toHaveLength(
			BATCHES * ITEMS_PER_BATCH
		);
	}, 120_000);
	it('delivers the update every pinned source row produced', async () => {
		harness = await makeBoltTestRuntime(definition, { authored });
		const result = await harness.runtime.runPromise(
			Effect.gen(function* () {
				const collections = yield* Collections.Service;
				const syncCommit = yield* SyncCommit.Service;
				// The rows a run pins: they exist first, exactly as a payroll run's source rows do.
				const plain = yield* collections.write(
					EffectId.make('large-write-sources'),
					adminSubject,
					[
						{
							collection: 'sources',
							action: 'create',
							inputs: Array.from({ length: SOURCE_COUNT }, (_, index) => ({
								body: `SOURCE-${index}`
							}))
						}
					]
				);
				yield* syncCommit.drainChanges;
				const sourceIds = plain.records.map((row) => String(row['id']));
				const inputs = Array.from({ length: BATCHES }, (_, index) => ({
					reference: `BATCH-${index}`,
					item_batch: {
						create: Array.from({ length: ITEMS_PER_BATCH }, (_, item) => ({
							sku: `SKU-${index}-${item}`
						}))
					},
					source_batch: {
						link: Array.from({ length: ITEMS_PER_BATCH }, (_, item) => ({
							id: sourceIds[index * ITEMS_PER_BATCH + item]!
						}))
					}
				}));
				const written = yield* collections.write(
					EffectId.make('large-write-pin'),
					adminSubject,
					[{ collection: 'batches', action: 'create', inputs }]
				);
				const changes = yield* syncCommit.drainChanges;
				return { written, changes };
			})
		);
		const pinned = result.changes.filter(
			(change) => change.collection === 'sources' && change.operation === 'update'
		);
		expect(pinned).toHaveLength(SOURCE_COUNT);
		expect(result.written.records.length).toBe(BATCHES);
	}, 300_000);
});
