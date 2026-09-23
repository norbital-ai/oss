import { describe, expect, it } from 'vitest';
import { Schema } from 'effect';
import { CollectionMutationPush, CollectionQueryRequest } from '../src/index.js';

/** The one write the browser pushes: a collection, a root action and its declared inputs. */
describe('the collection mutation push', () => {
	const common = {
		protocolVersion: 2,
		idempotencyKey: 'mutation-1',
		issuedAtEpochMs: 1_700_000_000_000,
		partitionKey: 'sha256:partition',
		schemaFingerprint: 'sha256:schema',
		baseVersions: []
	} as const;

	it('accepts a create batch whose inputs carry relation actions', () => {
		expect(
			Schema.is(CollectionMutationPush)({
				...common,
				graph: {
					collection: 'orders',
					action: 'create',
					inputs: [
						{
							reference: 'ORD-1',
							order_lines: { create: [{ sku: 'a-1' }] }
						},
						{ reference: 'ORD-2' }
					]
				}
			})
		).toBe(true);
	});

	it('accepts a whole-row base vector for every existing row touched by the graph', () => {
		expect(
			Schema.is(CollectionMutationPush)({
				...common,
				graph: {
					collection: 'orders',
					action: 'update',
					inputs: [{ id: 'order-1', reference: 'ORD-2' }]
				},
				baseVersions: [
					{ row: { collection: 'orders', recordId: 'order-1' }, rowVersion: 4 },
					{ row: { collection: 'order_lines', recordId: 'line-new' }, rowVersion: null }
				]
			})
		).toBe(true);
	});

	it('rejects a flat single-record request', () => {
		expect(
			Schema.is(CollectionMutationPush)({
				action: 'create',
				collection: 'orders',
				idempotencyKey: 'mutation-3',
				issuedAtEpochMs: 1_700_000_000_000,
				baseVersion: null,
				values: { reference: 'ORD-1' }
			})
		).toBe(false);
	});

	it('requires the version, physical partition and schema identity', () => {
		const create = {
			...common,
			graph: { collection: 'orders', action: 'create', inputs: [{ reference: 'ORD-1' }] }
		} as const;
		expect(Schema.is(CollectionMutationPush)({ ...create, protocolVersion: 1 })).toBe(false);
		expect(Schema.is(CollectionMutationPush)({ ...create, partitionKey: '' })).toBe(false);
		expect(Schema.is(CollectionMutationPush)({ ...create, schemaFingerprint: '' })).toBe(false);
		expect(
			Schema.is(CollectionMutationPush)({ ...create, graph: { ...create.graph, collection: '' } })
		).toBe(false);
	});

	it('admits one root action per push and refuses an empty batch', () => {
		for (const action of ['create', 'update', 'delete'] as const) {
			expect(
				Schema.is(CollectionMutationPush)({
					...common,
					graph: { collection: 'orders', action, inputs: [{ id: 'order-1' }] }
				})
			).toBe(true);
		}
		expect(
			Schema.is(CollectionMutationPush)({
				...common,
				graph: { collection: 'orders', action: 'mutate', inputs: [{ id: 'order-1' }] }
			})
		).toBe(false);
		expect(
			Schema.is(CollectionMutationPush)({
				...common,
				graph: { collection: 'orders', action: 'delete', inputs: [] }
			})
		).toBe(false);
	});

	it('bounds the attacker-controlled idempotency key', () => {
		const graph = { collection: 'orders', action: 'create', inputs: [{}] } as const;
		expect(
			Schema.is(CollectionMutationPush)({ ...common, idempotencyKey: 'x'.repeat(257), graph })
		).toBe(false);
		expect(
			Schema.is(CollectionMutationPush)({
				...common,
				idempotencyKey: 'mutation\u0000injected',
				graph
			})
		).toBe(false);
	});
});

describe('collection search', () => {
	const query = { collection: 'orders' } as const;

	it('is one string: plain text, /semantic or /<index>', () => {
		for (const search of ['open invoices', '/semantic similar disputes', '/colour {"l":50}'])
			expect(Schema.is(CollectionQueryRequest)({ ...query, search })).toBe(true);
	});

	it('refuses the retired structured commands and an empty string', () => {
		expect(
			Schema.is(CollectionQueryRequest)({ ...query, search: { mode: 'lexical', term: 'x' } })
		).toBe(false);
		expect(Schema.is(CollectionQueryRequest)({ ...query, search: '' })).toBe(false);
	});
});
