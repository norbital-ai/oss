import { describe, expect, it } from 'vitest';
import { Schema } from 'effect';
import { CollectionMutateRequest } from '../src/index.js';

/** The sole local-first collection mutation request accepted by both protocol endpoints. */
describe('the declarative mutation request', () => {
	const common = {
		protocolVersion: 2,
		idempotencyKey: 'mutation-1',
		issuedAtEpochMs: 1_700_000_000_000,
		deviceSequence: 1,
		partitionKey: 'sha256:partition',
		schemaFingerprint: 'sha256:schema',
		baseVersions: []
	} as const;

	it('accepts a local-first journal push with client identities at every graph level', () => {
		expect(
			Schema.is(CollectionMutateRequest)({
				...common,
				graph: {
					action: 'create',
					collection: 'orders',
					values: {
						id: '0191f0d1-d3a4-7d5d-8a3a-7ef87be42310',
						reference: 'ORD-1',
						order_line_order: [
							{ id: '0191f0d1-d3a4-7d5d-8a3a-7ef87be42311', sku: 'a-1' }
						]
					}
				}
			})
		).toBe(true);
	});

	it('accepts a whole-row base vector for every existing row touched by the graph', () => {
		expect(
			Schema.is(CollectionMutateRequest)({
				...common,
				deviceSequence: 2,
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

	it('requires the version, durable ordering, physical partition and schema identity', () => {
		const create = {
			...common,
			graph: { action: 'create', collection: 'orders', values: { id: 'order-1' } }
		} as const;
		expect(Schema.is(CollectionMutateRequest)({ ...create, protocolVersion: 1 })).toBe(false);
		expect(Schema.is(CollectionMutateRequest)({ ...create, deviceSequence: 0 })).toBe(false);
		expect(Schema.is(CollectionMutateRequest)({ ...create, partitionKey: '' })).toBe(false);
		expect(Schema.is(CollectionMutateRequest)({ ...create, schemaFingerprint: '' })).toBe(false);
		expect(
			Schema.is(CollectionMutateRequest)({
				...create,
				graph: { ...create.graph, collection: '' }
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
