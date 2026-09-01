import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import {
	SyncAdvanceResponse,
	SyncChange,
	SyncConnectEvaluation,
	SyncQueryInput
} from '@norbital-ai/bolt-protocol';
import * as Sync from '../../src/runtime/sync/sync.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	testWorkspace
} from '../support/bolt-test-layer.js';

describe('sync engine owner', () => {
	it('accepts only exact ChangeBatch row transitions', () => {
		expect(
			Schema.decodeUnknownSync(SyncChange)({
				collection: 'people',
				id: 'p1',
				operation: 'update',
				before: { team: 'core' },
				after: { team: 'edge' },
				mutationId: '11111111-1111-5111-8111-111111111111'
			})
		).toEqual({
			collection: 'people',
			id: 'p1',
			operation: 'update',
			before: { team: 'core' },
			after: { team: 'edge' },
			mutationId: '11111111-1111-5111-8111-111111111111'
		});
		expect(() =>
			Schema.decodeUnknownSync(SyncChange)({
				collection: 'people',
				id: 'p1',
				operation: 'update',
				after: { team: 'edge' }
			})
		).toThrow();
	});

	it('admits only contiguous findMany/findFirst live shapes', () => {
		expect(
			Schema.decodeUnknownSync(SyncQueryInput)({
				kind: 'findMany',
				collection: 'people',
				orderBy: { name: 'asc' },
				limit: 100
			})
		).toMatchObject({ kind: 'findMany', collection: 'people' });
		expect(() =>
			Schema.decodeUnknownSync(SyncQueryInput)({ kind: 'count', collection: 'people' })
		).toThrow();
	});

	it('keeps connect and advance on versioned prefix facts only', () => {
		expect(
			Schema.decodeUnknownSync(SyncConnectEvaluation)({
				results: [
					{
						key: 'people',
						input: { kind: 'findMany', collection: 'people', limit: 100 },
						planKey: 'sha256:plan',
						version: 0,
						prefixKeys: [],
						loadedPrefix: 0,
						prefixBytes: 0,
						authorityFingerprint: 'sha256:policy',
						dependencies: ['people'],
						routing: [],
						rows: []
					}
				],
				outcomes: []
			})
		).toMatchObject({ results: [{ version: 0, prefixKeys: [] }], outcomes: [] });
		expect(
			Schema.decodeUnknownSync(SyncAdvanceResponse)({ updates: [], resets: [], outcomes: [] })
		).toEqual({ updates: [], resets: [], outcomes: [] });
	});

	it('opens one admitted plan with version zero and no digest-era state', async () => {
		const harness = await makeBoltTestRuntime(testWorkspace());
		try {
			const evaluation = await harness.runtime.runPromise(
				Effect.flatMap(Sync.Service, (sync) =>
					sync.connect(harness.effectId('connect'), adminSubject, adminSubject, null, {
						queries: [
							{
								queryKey: 'people',
								input: { kind: 'findMany', collection: 'people', limit: 100 },
								requestedPrefix: 100
							}
						],
						detached: [],
						pending: []
					})
				)
			);
			const first = evaluation.results[0];
			expect(first).toMatchObject({
				key: 'people',
				version: 0,
				loadedPrefix: 0,
				prefixKeys: [],
				prefixBytes: 0,
				rows: []
			});
			expect(first?.planKey).toMatch(/^sha256:/);
			expect(first?.authorityFingerprint).toMatch(/^sha256:/);
			expect(first?.dependencies).toContain('people');
			expect(first).not.toHaveProperty('digest');
			expect(first).not.toHaveProperty('heldIds');
			expect(first).not.toHaveProperty('answer');
		} finally {
			await harness.dispose();
		}
	});
});
