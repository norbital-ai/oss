import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import {
	SyncAdvanceResponse,
	SyncChange,
	SyncConnectEvaluation,
	SyncCursor
} from '@norbital-ai/bolt-protocol';
import * as Sync from '../../src/runtime/sync/sync.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	testWorkspace
} from '../support/bolt-test-layer.js';

/**
 * The sync wire shapes, pinned at their schema.
 *
 * The changelog is collection-granular and sequence-addressed: a cursor is one integer, the
 * reconnect hint names collections rather than records, and a committed coordinate rides with the
 * write's idempotency key. The wire schema stays strict — PostgreSQL bigint text is normalized by
 * the changelog's own row decoders, never on the wire — so a client that sent `'42'` is refused
 * rather than silently interpreted.
 */
describe('Sync owner', () => {
	it('decodes a sequence cursor and rejects positions the wire schema does not own', () => {
		expect(Schema.decodeUnknownSync(SyncCursor)({ sequence: 9 })).toEqual({ sequence: 9 });
		expect(() => Schema.decodeUnknownSync(SyncCursor)({ sequence: '9' })).toThrow();
		expect(() => Schema.decodeUnknownSync(SyncCursor)({ sequence: -1 })).toThrow();
		expect(() => Schema.decodeUnknownSync(SyncCursor)({ sequence: 1.5 })).toThrow();
	});

	it('rejects malformed committed coordinates', () =>
		expect(() =>
			Schema.decodeUnknownSync(SyncChange)({
				collection: '',
				recordId: '',
				mutationId: 'not-a-key'
			})
		).toThrow());

	it('accepts a committed coordinate that names its mutation', () =>
		expect(
			Schema.decodeUnknownSync(SyncChange)({
				collection: 'people',
				recordId: 'p1',
				mutationId: '11111111-1111-5111-8111-111111111111'
			})
		).toEqual({
			collection: 'people',
			recordId: 'p1',
			mutationId: '11111111-1111-5111-8111-111111111111'
		}));

	it('keeps the connect and advance answers on one head shape', () => {
		const head = { sequence: 7 };
		expect(
			Schema.decodeUnknownSync(SyncConnectEvaluation)({
				head,
				results: [
					{
						key: 'people',
						input: {
							kind: 'findMany',
							collection: 'people',
							where: {},
							orderBy: [],
							limit: 100
						},
						policyHash: 'sha256:abc',
						dependencies: ['people'],
						policyDependencies: [],
						heldIds: [],
						digestOnly: false,
						digest: 'sha256:def',
						changed: true,
						answer: []
					}
				],
				outcomes: []
			})
		).toMatchObject({ head, outcomes: [] });
		expect(
			Schema.decodeUnknownSync(SyncAdvanceResponse)({
				head,
				updates: [],
				refused: [],
				outcomes: []
			})
		).toEqual({ head, updates: [], refused: [], outcomes: [] });
	});

	/**
	 * The registration surface the host files, §2.2. `policyDependencies` is the drift set (identity
	 * and approval collections, so the write that moves a subject reaches the registry) and
	 * `dependencies` adds the query's own collections — never the runtime collections whose writes
	 * cannot touch the answer, or every agent chat message would wake and re-resolve every
	 * subscription in the tenant.
	 */
	it('registers a query with the narrowed policy surface', async () => {
		const harness = await makeBoltTestRuntime(testWorkspace());
		try {
			const evaluation = await harness.runtime.runPromise(
				Effect.flatMap(Sync.Service, (sync) =>
					sync.connect(harness.effectId('connect'), adminSubject, adminSubject, null, {
						queries: [{ key: 'people', input: { kind: 'findMany', collection: 'people' } }],
						released: [],
						pending: []
					})
				)
			);
			const first = evaluation.results[0];
			expect(first?.policyDependencies).toEqual([
				'account',
				'approval_request',
				'auth_config',
				'session',
				'team',
				'user',
				'verification'
			]);
			expect(first?.dependencies).toEqual([
				'account',
				'approval_request',
				'auth_config',
				'people',
				'session',
				'team',
				'user',
				'verification'
			]);
			expect(first?.policyHash).toMatch(/^sha256:/);
			const repeat = await harness.runtime.runPromise(
				Effect.flatMap(Sync.Service, (sync) =>
					sync.connect(harness.effectId('connect:repeat'), adminSubject, adminSubject, null, {
						queries: [{ key: 'people', input: { kind: 'findMany', collection: 'people' } }],
						released: [],
						pending: []
					})
				)
			);
			expect(repeat.results[0]?.policyHash).toBe(first?.policyHash);
		} finally {
			await harness.dispose();
		}
	});
});
