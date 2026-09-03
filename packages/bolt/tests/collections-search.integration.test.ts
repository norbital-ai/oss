import { Effect } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import { defineModel, text } from '../src/authoring/models-schema.js';
import { compileModel } from '../src/authoring/model-introspection.js';
import { collection, policy, workspace } from '../src/authoring/workspace-schema.js';
import * as Collections from '../src/runtime/collections/collections.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	type BoltTestRuntime
} from './support/bolt-test-layer.js';

/**
 * A valid record id for a one-letter fixture name.
 *
 * Records are keyed by `id uuid`; `'a'` was only ever accepted by the `id text` primary key
 * Bolt used to invent, so these fixtures built rows a real database would have rejected.
 */
const rid = (name: string): string =>
	`00000000-0000-5000-8000-${name.charCodeAt(0).toString().padStart(12, '0')}`;

/**
 * Free-text search over real SQL.
 *
 * The box did nothing at all: the column builders accepted `search: true` and dropped it, the
 * command boundary dropped the term, and the query input had no field for it. Each of the three
 * would have been enough on its own.
 */

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

/**
 * Compiled through `compileModel`, because that is the only thing that derives a collection's
 * lexical metadata. `search: true` on a field is what generates the document column; the
 * `search` block it produces beside it is what the read resolver looks the column up through, and
 * a fixture that wrote the flag by hand had the first without the second.
 */
const peopleModel = defineModel({
	name: text({ search: true }).notNull(),
	team: text({ search: true }),
	// Not opted in: search must never reach it.
	secret_note: text()
});

const searchable = workspace({
	name: 'test-workspace',
	version: '1',
	collections: [compileModel(collection({ name: 'people', fields: {} }), peopleModel)],
	apps: [],
	policies: [
		policy({ name: 'admin', effect: 'allow', actions: ['*'], capabilities: { apps: ['*'] } })
	],
	teams: {
		admin: ['admin']
	},
	automations: [],
	integrations: [],
	prompt: 'You are the test workspace agent.',
	tools: [],
	skills: [],
	envoys: [],
	requiredFacilities: []
});

const seed = (harness: BoltTestRuntime) =>
	harness.runtime.runPromise(
		Effect.gen(function* () {
			const collections = yield* Collections.Service;
			yield* collections.mutate(
				harness.effectId('a'),
				adminSubject,
				'people',
				[{ id: rid('a'), name: 'Ada Lovelace', team: 'Engineering', secret_note: 'zebra' }],
				false,
				0,
				{ root: { id: rid('a'), action: 'create' } }
			);
			yield* collections.mutate(
				harness.effectId('b'),
				adminSubject,
				'people',
				[{ id: rid('b'), name: 'Grace Hopper', team: 'Research', secret_note: 'quartz' }],
				false,
				0,
				{ root: { id: rid('b'), action: 'create' } }
			);
		})
	);

const search = (harness: BoltTestRuntime, term?: string) =>
	harness.runtime.runPromise(
		Effect.gen(function* () {
			const rows = yield* (yield* Collections.Service).findMany(
				harness.effectId('find'),
				adminSubject,
				{
					collection: 'people',
					...(term === undefined ? {} : { search: { mode: 'lexical' as const, term } })
				}
			);
			return rows.map((row) =>
				row !== null && typeof row === 'object' && !Array.isArray(row)
					? Reflect.get(row, 'name')
					: null
			);
		})
	);

describe('collection search', () => {
	it('matches a declared searchable column', async () => {
		harness = await makeBoltTestRuntime(searchable);
		await seed(harness);
		expect(await search(harness, 'Ada')).toEqual(['Ada Lovelace']);
	});

	it('matches case-insensitively and on a fragment', async () => {
		harness = await makeBoltTestRuntime(searchable);
		await seed(harness);
		expect(await search(harness, 'hopp')).toEqual(['Grace Hopper']);
	});

	it('spans every searchable column, not just the first', async () => {
		harness = await makeBoltTestRuntime(searchable);
		await seed(harness);
		expect(await search(harness, 'Research')).toEqual(['Grace Hopper']);
	});

	it('never reaches a column that did not opt in', async () => {
		harness = await makeBoltTestRuntime(searchable);
		await seed(harness);
		// `zebra` exists, in a column nobody declared searchable. Matching it would make search a way
		// to read fields a collection deliberately kept out of it.
		expect(await search(harness, 'zebra')).toEqual([]);
	});

	it('returns everything when no term is given', async () => {
		harness = await makeBoltTestRuntime(searchable);
		await seed(harness);
		expect((await search(harness)).sort()).toEqual(['Ada Lovelace', 'Grace Hopper']);
	});

	it('matches nothing on a collection that declares no searchable column', async () => {
		harness = await makeBoltTestRuntime();
		await harness.runtime.runPromise(
			Effect.gen(function* () {
				yield* (yield* Collections.Service).mutate(
					harness!.effectId('x'),
					adminSubject,
					'people',
					[{ id: rid('x'), name: 'Ada Lovelace' }],
					false,
					0,
					{ root: { id: rid('x'), action: 'create' } }
				);
			})
		);
		// The default fixture opts no column in, so a term that reached here must not widen to a scan.
		expect(await search(harness, 'Ada')).toEqual([]);
	});

	it('counts the same rows it returns', async () => {
		harness = await makeBoltTestRuntime(searchable);
		await seed(harness);
		const total = await harness.runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Collections.Service).count(harness!.effectId('count'), adminSubject, {
					collection: 'people',
					search: { mode: 'lexical', term: 'Ada' }
				});
			})
		);
		// A count that ignored the term reported the whole collection under a filtered page.
		expect(total).toBe(1);
	});
});
