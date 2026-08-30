import { Effect, Schema } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import * as Collections from '../../src/runtime/collections/collections.js';
import { changelogSince } from '../../src/runtime/sync/changelog.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	type BoltTestRuntime
} from '../support/bolt-test-layer.js';

/**
 * The sync engine's durable facts, over a real database.
 *
 * The engine is stateless now: a commit appends `bolt_sync_outbox` rows through the capture
 * trigger — collection name, transaction xid and a per-row sequence — and
 * reconnects are answered by `changelogSince` from those rows alone. These tests
 * pin the row shape the trigger writes and the reconnect contract computed from it, because both
 * are invisible to a green unit suite: a trigger that stopped firing, or a horizon that swallowed
 * fresh rows, raises nothing anywhere else.
 */

const OutboxRow = Schema.Struct({
	xid: Schema.Number,
	sequence: Schema.Number,
	collection_name: Schema.String
});

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

const mutatePerson = (name: string) => {
	const h = harness;
	if (h === undefined) throw new Error('harness missing');
	return h.runtime.runPromise(
		Effect.flatMap(Collections.Service, (collections) =>
			collections.mutate(
				h.effectId(`mutate:${name}`),
				adminSubject,
				'people',
				[{ name, team: 'core' }],
				false,
				0
			)
		)
	);
};

describe('sync engine durable facts', () => {
	it('captures a commit as collection-granular outbox rows and reports the written changes', async () => {
		harness = await makeBoltTestRuntime();
		const written = await mutatePerson('Ada');

		// The commit answers with what changed: the engine result the dispatch boundary maps into
		// `DispatchResponse.changes`, one coordinate per written record.
		expect(written.changes).toEqual([
			{ collection: 'people', recordId: written.records[0]?.['id'] }
		]);
		expect(written.records[0]?.['name']).toBe('Ada');

		const rows = await harness.database.query(
			`select xid, sequence, collection_name from bolt_sync_outbox
			 where collection_name = 'people' order by sequence`
		);
		expect(rows.length).toBeGreaterThanOrEqual(1);
		for (const row of rows) {
			const decoded = Schema.decodeUnknownSync(OutboxRow)(row);
			expect(decoded.collection_name).toBe('people');
			expect(decoded.xid).toBeGreaterThan(0);
			expect(decoded.sequence).toBeGreaterThan(0);
		}

		// The narrowed table is the whole record: the replica-era payload columns are gone, and a
		// re-merge that reintroduced them would silently double every commit's row size.
		const staleColumns = await harness.database.query(
			`select column_name from information_schema.columns
			 where table_name = 'bolt_sync_outbox'
			   and column_name in ('record_id', 'operation', 'before_record', 'after_record', 'invalidated_collections', 'mutation_id')`
		);
		expect(staleColumns).toEqual([]);
	});

	it('answers a reconnect from the changelog: head, changed collections, and truncation', async () => {
		harness = await makeBoltTestRuntime();
		const empty = await harness.runtime.runPromise(
			changelogSince(harness.effectId('since:empty'), undefined)
		);
		expect(empty.head.sequence).toBe(0);

		await mutatePerson('Ada');
		await mutatePerson('Grace');
		const atHead = await harness.runtime.runPromise(
			changelogSince(harness.effectId('since:head'), undefined)
		);
		const head = atHead.head;
		expect(head.sequence).toBeGreaterThan(0);

		// A client reconnecting from the previous head is told which collections moved and where the
		// new head is — collection-granular, never row payloads.
		const since = await harness.runtime.runPromise(
			changelogSince(harness.effectId('since'), empty.head)
		);
		expect(since).toMatchObject({ collections: ['people'], truncated: false });
		expect(since.head.sequence).toBe(head.sequence);

		// A client at the head has nothing to replay, and one from beyond the retained window — or
		// with no cursor at all — is told to re-resolve rather than being handed a partial answer.
		const current = await harness.runtime.runPromise(
			changelogSince(harness.effectId('since:current'), head)
		);
		expect(current).toMatchObject({ collections: [], truncated: false });

		const absent = await harness.runtime.runPromise(
			changelogSince(harness.effectId('since:absent'), undefined)
		);
		expect(absent.truncated).toBe(true);

		const beyond = await harness.runtime.runPromise(
			changelogSince(harness.effectId('since:beyond'), { sequence: head.sequence + 1000 })
		);
		expect(beyond.truncated).toBe(true);
	});
});
