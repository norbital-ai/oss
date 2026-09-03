import { afterEach, describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import * as Collections from '../src/runtime/collections/collections.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	type BoltTestRuntime
} from './support/bolt-test-layer.js';

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

describe('collection history', () => {
	it('stores update snapshots as JSONB through the connectionless query composer', async () => {
		harness = await makeBoltTestRuntime();
		const recordId = '00000000-0000-4000-8000-000000000072';

		await harness.runtime.runPromise(
			Effect.gen(function* () {
				const collections = yield* Collections.Service;
				yield* collections.mutate(
					harness!.effectId('history-create'),
					adminSubject,
					'people',
					[{ id: recordId, name: 'Ada', team: 'Research' }],
					false,
					0,
					{ root: { id: recordId, action: 'create' } }
				);
				yield* collections.mutate(
					harness!.effectId('history-update'),
					adminSubject,
					'people',
					[{ id: recordId, team: 'Platform' }],
					false,
					0,
					{ root: { id: recordId, action: 'update' } }
				);
			})
		);

		const rows = await harness.database.query(
			'select snapshot from bolt_collection_history where collection_name = $1 and record_id = $2 and operation = $3',
			['people', recordId, 'update']
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.['snapshot']).toEqual({ team: 'Platform' });
	});

	it('normalizes persisted patches into chronological full-record revisions', async () => {
		harness = await makeBoltTestRuntime();
		const recordId = '00000000-0000-4000-8000-000000000071';
		const instants = [
			'2026-08-24T01:00:00.000Z',
			'2026-08-24T02:00:00.000Z',
			'2026-08-24T03:00:00.000Z'
		] as const;

		// The record itself, because history is answered through the current row: a record that is
		// absent and one the predicate hides are deliberately the same answer, so a patch log with no
		// row behind it reads as nothing rather than as a record somebody may no longer see.
		await harness.database.query('insert into people (id, name, team) values ($1, $2, $3)', [
			recordId,
			'Ada Lovelace',
			'Platform'
		]);
		await harness.database.query(
			`insert into bolt_collection_history
				(sequence, collection_name, record_id, operation, subject_id, snapshot, created_at)
			values
				(1, 'people', $1, 'create', 'admin-1', $2::jsonb, $3),
				(2, 'people', $1, 'update', 'admin-1', $4::jsonb, $5),
				(3, 'people', $1, 'update', 'admin-1', $6::jsonb, $7)`,
			[
				recordId,
				JSON.stringify({ name: 'Ada', team: 'Research' }),
				instants[0],
				JSON.stringify({ name: 'Ada Lovelace' }),
				instants[1],
				JSON.stringify({ team: 'Platform' }),
				instants[2]
			]
		);

		const history = await harness.runtime.runPromise(
			Effect.gen(function* () {
				const collections = yield* Collections.Service;
				return yield* collections.history(
					harness!.effectId('history-normalization'),
					adminSubject,
					'people',
					recordId
				);
			})
		);

		expect(history).toEqual([
			{
				values: { name: 'Ada', team: 'Research' },
				validFrom: instants[0],
				validTo: instants[1],
				version: 1
			},
			{
				values: { name: 'Ada Lovelace', team: 'Research' },
				validFrom: instants[1],
				validTo: instants[2],
				version: 2
			},
			{
				values: { name: 'Ada Lovelace', team: 'Platform' },
				validFrom: instants[2],
				validTo: null,
				version: 3
			}
		]);
	});
});
