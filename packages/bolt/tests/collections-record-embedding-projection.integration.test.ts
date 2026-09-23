import { afterEach, describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import { field, type WorkspaceDefinition } from '../src/authoring/workspace-schema.js';
import * as Collections from '../src/runtime/collections/collections.js';
import { emptyAuthoredRuntime, type AuthoredRuntime } from '../src/runtime/collections/authored.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	testWorkspace,
	type BoltTestRuntime
} from './support/bolt-test-layer.js';

/**
 * A root `columns` projection that names the record embedding returns it.
 *
 * The root SELECT is narrowed to the named columns, and the narrowing listed only system columns and
 * declared fields. `record_embedding` is neither — the model's `embedding` declaration adds it — so
 * naming it was dropped without a word and the row came back without the key. Field operations'
 * photo-reuse retrieval probed with exactly that read, found no vector on any photo, and reported
 * every assignment clear.
 */
const base = testWorkspace({
	collections: [{ name: 'photos', fields: { caption: field.string() } }]
});
/** The compiler attaches `embedding` from the model's declaration; `collection()` never takes it. */
const definition: WorkspaceDefinition = {
	...base,
	collections: base.collections.map((photos) => ({
		...photos,
		embedding: {
			fields: ['caption'],
			dimensions: 3,
			vectorColumn: 'record_embedding',
			embeddedAtColumn: 'embedded_at',
			sourceFingerprintColumn: 'record_embedding_fingerprint'
		}
	}))
};

const authored: AuthoredRuntime = {
	...emptyAuthoredRuntime,
	collections: { photos: { create: { input: { columns: { caption: true } } } } }
};

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

describe('record embedding projection', () => {
	it('returns record_embedding when a root read names it in columns', async () => {
		harness = await makeBoltTestRuntime(definition, { authored });
		let id = '';
		const rows = await harness.runtime.runPromise(
			Effect.gen(function* () {
				const collections = yield* Collections.Service;
				const created = yield* collections.write(harness!.effectId('photo-create'), adminSubject, [
					{ collection: 'photos', action: 'create', inputs: [{ caption: 'ceiling' }] }
				]);
				id = String(created.records[0]?.['id']);
				yield* Effect.promise(() =>
					harness!.database.query(
						`update "photos" set "record_embedding" = '[1,2,3]' where id = $1`,
						[id]
					)
				);
				return yield* collections.findMany(harness!.effectId('photo-read'), adminSubject, {
					collection: 'photos',
					columns: { id: true, record_embedding: true }
				});
			})
		);
		expect(rows).toEqual([{ id, record_embedding: [1, 2, 3] }]);
	});
});
