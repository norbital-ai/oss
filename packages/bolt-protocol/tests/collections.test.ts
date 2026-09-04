import { describe, expect, it } from 'vitest';
import { Schema } from 'effect';
import { CollectionMutateRequest, CollectionQueryRequest } from '../src/index.js';

/** The sole declarative collection mutation request accepted by both protocol endpoints. */
describe('the declarative mutation request', () => {
	const common = {
		protocolVersion: 2,
		idempotencyKey: 'mutation-1',
		issuedAtEpochMs: 1_700_000_000_000,
		partitionKey: 'sha256:partition',
		schemaFingerprint: 'sha256:schema',
		baseVersions: []
	} as const;

	it('accepts a mutation push with client-minted record identities at every graph level', () => {
		expect(
			Schema.is(CollectionMutateRequest)({
				...common,
				graph: {
					action: 'create',
					collection: 'orders',
					values: {
						id: '0191f0d1-d3a4-7d5d-8a3a-7ef87be42310',
						reference: 'ORD-1',
						order_line_order: [{ id: '0191f0d1-d3a4-7d5d-8a3a-7ef87be42311', sku: 'a-1' }]
					}
				}
			})
		).toBe(true);
	});

	it('accepts a whole-row base vector for every existing row touched by the graph', () => {
		expect(
			Schema.is(CollectionMutateRequest)({
				...common,
				graph: {
					action: 'update',
					collection: 'orders',
					values: { id: 'order-1', reference: 'ORD-2' }
				},
				baseVersions: [
					{ row: { collection: 'orders', recordId: 'order-1' }, rowVersion: 4 },
					{ row: { collection: 'order_lines', recordId: 'line-new' }, rowVersion: null }
				]
			})
		).toBe(true);
	});

	it('rejects the removed pre-v2 request shape', () => {
		expect(
			Schema.is(CollectionMutateRequest)({
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
			graph: { action: 'create', collection: 'orders', values: { id: 'order-1' } }
		} as const;
		expect(Schema.is(CollectionMutateRequest)({ ...create, protocolVersion: 1 })).toBe(false);
		expect(Schema.is(CollectionMutateRequest)({ ...create, partitionKey: '' })).toBe(false);
		expect(Schema.is(CollectionMutateRequest)({ ...create, schemaFingerprint: '' })).toBe(false);
		expect(
			Schema.is(CollectionMutateRequest)({
				...create,
				graph: { ...create.graph, collection: '' }
			})
		).toBe(false);
	});

	it('accepts a mutate batch of write rows', () => {
		expect(
			Schema.is(CollectionMutateRequest)({
				...common,
				graph: {
					action: 'mutate',
					collection: 'orders',
					rows: [
						{ action: 'create', values: { id: 'order-1', reference: 'ORD-1' } },
						{ action: 'update', values: { id: 'order-2', reference: 'ORD-2' } }
					]
				}
			})
		).toBe(true);
	});

	it('accepts a delete batch of unique ids and rejects a single-id graph', () => {
		expect(
			Schema.is(CollectionMutateRequest)({
				...common,
				graph: { action: 'delete', collection: 'orders', ids: ['order-1', 'order-2'] }
			})
		).toBe(true);
		expect(
			Schema.is(CollectionMutateRequest)({
				...common,
				graph: { action: 'delete', collection: 'orders', id: 'order-1' }
			})
		).toBe(false);
		expect(
			Schema.is(CollectionMutateRequest)({
				...common,
				graph: { action: 'delete', collection: 'orders', ids: [] }
			})
		).toBe(false);
		expect(
			Schema.is(CollectionMutateRequest)({
				...common,
				graph: { action: 'delete', collection: 'orders', ids: ['order-1', 'order-1'] }
			})
		).toBe(false);
	});

	it('bounds the attacker-controlled idempotency key', () => {
		expect(
			Schema.is(CollectionMutateRequest)({
				...common,
				idempotencyKey: 'x'.repeat(257),
				graph: { action: 'create', collection: 'orders', values: {} }
			})
		).toBe(false);
		expect(
			Schema.is(CollectionMutateRequest)({
				...common,
				idempotencyKey: 'mutation\u0000injected',
				graph: { action: 'create', collection: 'orders', values: {} }
			})
		).toBe(false);
	});
});

describe('collection search commands', () => {
	const query = { collection: 'orders' } as const;

	it('admits explicit lexical and semantic search commands', () => {
		expect(
			Schema.is(CollectionQueryRequest)({
				...query,
				search: { mode: 'lexical', term: 'open invoices' }
			})
		).toBe(true);
		expect(
			Schema.is(CollectionQueryRequest)({
				...query,
				search: { mode: 'semantic', term: 'similar contract disputes' }
			})
		).toBe(true);
	});

	it('refuses strings, unknown modes, and empty commands', () => {
		expect(Schema.is(CollectionQueryRequest)({ ...query, search: 'open invoices' })).toBe(false);
		expect(
			Schema.is(CollectionQueryRequest)({
				...query,
				search: { mode: 'hybrid', term: 'ordinary typing' }
			})
		).toBe(false);
		expect(
			Schema.is(CollectionQueryRequest)({ ...query, search: { mode: 'lexical', term: '' } })
		).toBe(false);
		expect(
			Schema.is(CollectionQueryRequest)({ ...query, search: { mode: 'semantic', term: '' } })
		).toBe(false);
	});
});
