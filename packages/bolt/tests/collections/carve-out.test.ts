import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { EffectId } from '@norbital-ai/bolt-protocol';
import {
	emitChangeEventsMany,
	type ChangeEventPorts
} from '../../src/runtime/collections/services/change-events.js';
import { recordEmbeddingParts } from '../../src/runtime/collections/services/embeddings.js';

const COLLECTIONS = join(
	import.meta.dirname,
	'../../src/runtime/collections/collections.ts'
);

/**
 * P2's failure mode is writing the new module beside the old function and leaving both.
 * A green suite that only exercises behaviour cannot see that. These greps fail the moment
 * an implementation is reintroduced under the old `Effect.fn` name.
 */
const definedInCollections = (symbol: string): boolean =>
	new RegExp(String.raw`Effect\.fn\('Collections\.${symbol}'\)`).test(
		readFileSync(COLLECTIONS, 'utf8')
	);

describe('collection-lifecycle P2 carve-out', () => {
	it('does not keep moved implementations in collections.ts', () => {
		expect(definedInCollections('embedRecords')).toBe(false);
		expect(definedInCollections('recordEmbeddingParts')).toBe(false);
		expect(definedInCollections('emitChangeEventsMany')).toBe(false);
		expect(definedInCollections('readRelational')).toBe(false);
		expect(definedInCollections('prepareDelete')).toBe(false);
		expect(definedInCollections('prepareGraphDelete')).toBe(false);
		expect(definedInCollections('prepareNode')).toBe(false);
		expect(definedInCollections('prepareGraphNode')).toBe(false);
		expect(definedInCollections('prepareDeclarativeGraph')).toBe(false);
		expect(definedInCollections('graphWaveRead')).toBe(false);
		expect(definedInCollections('queuedGraphWaveRead')).toBe(false);
		expect(definedInCollections('settleDeclarativeGraph')).toBe(false);
		expect(definedInCollections('historyPrunes')).toBe(false);
		expect(definedInCollections('buildApi')).toBe(false);
		expect(definedInCollections('buildOps')).toBe(false);
		expect(definedInCollections('refuseRunawayHooks')).toBe(false);
		expect(definedInCollections('buildReadOps')).toBe(false);
	});

	it('does not start automations when no records or no matching trigger exist', async () => {
		let started = 0;
		const ports = {
			automations: {
				startMany: () => {
					started += 1;
					return Effect.succeed([]);
				},
				executeMany: () => Effect.succeed([])
			},
			authored: {
				unused: {
					name: 'unused',
					trigger: { _tag: 'Manual' }
				}
			},
			runBody: () => Effect.succeed({})
		} satisfies ChangeEventPorts;
		await Effect.runPromise(
			emitChangeEventsMany(ports, EffectId.make('e1'), 'tickets', [], 'created')
		);
		await Effect.runPromise(
			emitChangeEventsMany(
				ports,
				EffectId.make('e2'),
				'tickets',
				[{ taskScope: 't1', row: { id: '1' } }],
				'created'
			)
		);
		expect(started).toBe(0);
	});

	it('skips empty and missing fields when assembling embedding parts', async () => {
		const parts = await Effect.runPromise(
			recordEmbeddingParts(
				{
					database: { execute: () => Effect.die('database') },
					ai: { execute: () => Effect.die('ai') },
					collections: [],
					readAsset: () => Effect.die('asset')
				},
				EffectId.make('e1'),
				{
					name: 'photos',
					fields: { caption: { type: 'string' }, photo: { type: 'json' } },
					embedding: { fields: ['caption', 'photo', 'missing'] }
				},
				{ caption: '  ', photo: null }
			)
		);
		expect(parts).toEqual([]);
	});
});
