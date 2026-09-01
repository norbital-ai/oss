import {
	AIResponse,
	EffectId,
	ProviderObservation,
	type AIRequest,
	type DatabaseRequest,
	type DatabaseResponse
} from '@norbital-ai/bolt-protocol';
import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import {
	embedRecords,
	RECORD_EMBEDDING_BACKFILL_LIMIT
} from '../../src/runtime/collections/services/embeddings.js';
import { FacilityError } from '../../src/runtime/facilities/database.js';

describe('record embedding backfill', () => {
	it('claims 512 rows and embeds one typed input per record with bounded parallelism', async () => {
		const rows = Array.from({ length: RECORD_EMBEDDING_BACKFILL_LIMIT }, (_, index) => ({
			id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
			updated_at: '2026-08-30T00:00:00.000Z',
			record_embedding: null,
			record_embedding_fingerprint: null,
			photo: {
				storage_key: `evidence/${index}.jpg`,
				file_name: `${index}.jpg`,
				file_size: 512_000,
				mime_type: 'image/jpeg'
			}
		}));
		const databaseCalls: Array<{ readonly id: string; readonly request: DatabaseRequest }> = [];
		const aiCalls: Array<{ readonly id: string; readonly request: AIRequest }> = [];
		let activeAI = 0;
		let peakAI = 0;

		const summary = await Effect.runPromise(
			embedRecords(
				{
					database: {
						execute: (effectId, request) => {
							databaseCalls.push({ id: effectId, request });
							return Effect.succeed(
								request._tag === 'Query' && request.sql.startsWith('select ')
									? ({ rows, affectedRows: 0 } satisfies DatabaseResponse)
									: ({ rows: [], affectedRows: rows.length } satisfies DatabaseResponse)
							);
						}
					},
					ai: {
						embed: (effectId, request) => {
							aiCalls.push({ id: effectId, request });
							return Effect.promise(async () => {
								activeAI += 1;
								peakAI = Math.max(peakAI, activeAI);
								await new Promise((resolve) => setTimeout(resolve, 5));
								activeAI -= 1;
								return AIResponse.cases.Embedded.make({
									embeddings: request.inputs.map(() => [0.1, 0.2]),
									observation: ProviderObservation.make({
										callId: request.callId,
										provider: 'test',
										model: request.modelId,
										operation: 'embedding'
									})
								});
							});
						}
					},
					collections: [
						{
							name: 'photo_evidence',
							fields: { photo: { type: 'json' } },
							embedding: { fields: ['photo'], model: 'test/embedding' }
						}
					]
				},
				EffectId.make('embedding-backfill')
			)
		);

		expect(summary).toEqual([
			{ collection: 'photo_evidence', selected: 512, embedded: 512, failed: 0 }
		]);
		const select = databaseCalls.find(({ request }) =>
			request._tag === 'Query' ? request.sql.startsWith('select ') : false
		);
		expect(select?.request._tag).toBe('Query');
		if (select?.request._tag !== 'Query') throw new Error('expected a database select');
		expect(select.request.parameters[0]).toBe(512);
		expect(aiCalls).toHaveLength(512);
		expect(
			aiCalls.map(({ request }) => (request._tag === 'Embed' ? request.inputs.length : 0))
		).toEqual(Array.from({ length: 512 }, () => 1));
		expect(
			aiCalls.every(
				({ request }) => request._tag === 'Embed' && request.modelId === 'test/embedding'
			)
		).toBe(true);
		expect(peakAI).toBe(4);
		expect(databaseCalls).toHaveLength(7);
		expect(new Set([...databaseCalls, ...aiCalls].map(({ id }) => id)).size).toBe(519);
	});

	it('keeps the provider reason when a batch cannot be embedded', async () => {
		const row = {
			id: '00000000-0000-4000-8000-000000000001',
			updated_at: '2026-08-30T00:00:00.000Z',
			record_embedding: null,
			record_embedding_fingerprint: null,
			photo: {
				storage_key: 'evidence/1.jpg',
				file_name: '1.jpg',
				file_size: 512_000,
				mime_type: 'image/jpeg'
			}
		};
		const summary = await Effect.runPromise(
			embedRecords(
				{
					database: {
						execute: (_effectId, request) =>
							Effect.succeed(
								request._tag === 'Query' && request.sql.startsWith('select ')
									? { rows: [row], affectedRows: 0 }
									: { rows: [], affectedRows: 0 }
							)
					},
					ai: {
						embed: () =>
							Effect.fail(
								new FacilityError({
									operation: 'ai',
									code: 'ai_provider_failure',
									message: 'provider gateway timed out',
									retryable: true,
									outcome: 'unknown'
								})
							)
					},
					collections: [
						{
							name: 'photo_evidence',
							fields: { photo: { type: 'json' } },
							embedding: { fields: ['photo'], model: 'test/embedding' }
						}
					]
				},
				EffectId.make('embedding-failure')
			)
		);

		expect(summary).toEqual([
			{
				collection: 'photo_evidence',
				selected: 1,
				embedded: 0,
				failed: 1,
				issues: ['ai_provider_failure: provider gateway timed out']
			}
		]);
	});
});
