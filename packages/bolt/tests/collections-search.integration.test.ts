import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { Effect } from 'effect';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { defineModel, text } from '../src/authoring/models-schema.js';
import { compileModel } from '../src/authoring/model-introspection.js';
import { collection, policy, workspace } from '../src/authoring/workspace-schema.js';
import * as Collections from '../src/runtime/collections/collections.js';
import { emptyAuthoredRuntime, type AuthoredRuntime } from '../src/runtime/collections/authored.js';
import { lexicalSearchSteps } from '../src/runtime/collections/read/search.js';
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
	channels: [],
	envoys: [],
	requiredFacilities: []
});

const authored: AuthoredRuntime = {
	...emptyAuthoredRuntime,
	collections: {
		people: { create: { input: { columns: { name: true, team: true, secret_note: true } } } }
	}
};

const seed = (harness: BoltTestRuntime) =>
	harness.runtime.runPromise(
		Effect.gen(function* () {
			const collections = yield* Collections.Service;
			yield* collections.write(harness.effectId('seed'), adminSubject, [
				{
					collection: 'people',
					action: 'create',
					inputs: [
						{ id: rid('a'), name: 'Ada Lovelace', team: 'Engineering', secret_note: 'zebra' },
						{ id: rid('b'), name: 'Grace Hopper', team: 'Research', secret_note: 'quartz' }
					]
				}
			]);
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
		harness = await makeBoltTestRuntime(searchable, { authored });
		await seed(harness);
		expect(await search(harness, 'Ada')).toEqual(['Ada Lovelace']);
	});

	it('matches case-insensitively and on a fragment', async () => {
		harness = await makeBoltTestRuntime(searchable, { authored });
		await seed(harness);
		expect(await search(harness, 'hopp')).toEqual(['Grace Hopper']);
	});

	it('spans every searchable column, not just the first', async () => {
		harness = await makeBoltTestRuntime(searchable, { authored });
		await seed(harness);
		expect(await search(harness, 'Research')).toEqual(['Grace Hopper']);
	});

	it('never reaches a column that did not opt in', async () => {
		harness = await makeBoltTestRuntime(searchable, { authored });
		await seed(harness);
		// `zebra` exists, in a column nobody declared searchable. Matching it would make search a way
		// to read fields a collection deliberately kept out of it.
		expect(await search(harness, 'zebra')).toEqual([]);
	});

	it('returns everything when no term is given', async () => {
		harness = await makeBoltTestRuntime(searchable, { authored });
		await seed(harness);
		expect((await search(harness)).sort()).toEqual(['Ada Lovelace', 'Grace Hopper']);
	});

	it('matches nothing on a collection that declares no searchable column', async () => {
		harness = await makeBoltTestRuntime(undefined, { authored });
		await harness.runtime.runPromise(
			Effect.gen(function* () {
				yield* (yield* Collections.Service).write(harness!.effectId('x'), adminSubject, [
					{
						collection: 'people',
						action: 'create',
						inputs: [{ id: rid('x'), name: 'Ada Lovelace' }]
					}
				]);
			})
		);
		// The default fixture opts no column in, so a term that reached here must not widen to a scan.
		expect(await search(harness, 'Ada')).toEqual([]);
	});

	it('counts the same rows it returns', async () => {
		harness = await makeBoltTestRuntime(searchable, { authored });
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

/**
 * The tokeniser itself, over the same SQL the schema plan installs: the document and the query
 * are both built by it, so these pin what a stored row and a typed term turn into.
 */
describe('lexical tokeniser', () => {
	const database = new PGlite({ extensions: { pg_trgm } });
	beforeAll(async () => {
		for (const step of lexicalSearchSteps()) await database.exec(step.sql);
	});
	afterAll(() => database.close());
	const value = async (statement: string, parameter: string): Promise<unknown> =>
		(await database.query<{ value: unknown }>(`select ${statement} as value`, [parameter])).rows[0]
			?.value;
	const lexemes = async (text: string): Promise<ReadonlyArray<string>> =>
		(
			await database.query<{ lexeme: string }>(
				'select lexeme from bolt_search_terms($1) order by kind, lexeme',
				[text]
			)
		).rows.map((row) => row.lexeme);

	it('folds width, case, accents, tones and punctuation the same way everywhere', async () => {
		expect(await value('bolt_search_fold($1)', "Ｂｅｄｏｋ Nth. Ave-3, Café O'Brien Běijīng")).toBe(
			'bedok nth ave 3 cafe obrien beijing'
		);
		expect(await value('bolt_search_fold($1)', 'Jalan《北京》路ｶﾀｶﾅ')).toBe(
			'jalan 北京 路カタカナ'
		);
	});

	it('transliterates Han to toneless pinyin, keeping a second reading', async () => {
		expect(await value('bolt_search_pinyin($1)', '北京厦门')).toEqual([
			'bei',
			'jing',
			'sha xia',
			'men'
		]);
	});

	it('indexes CJK suffixes, pinyin syllables and joins, and Latin skeletons', async () => {
		const terms = await lexemes('北京市 Kismis');
		expect(terms).toEqual(
			expect.arrayContaining([
				'北京市',
				'京市',
				'市',
				'bei',
				'beijing',
				'beijingshi',
				'kismis',
				'#ksms'
			])
		);
		expect(await lexemes('厦门')).toEqual(expect.arrayContaining(['xiamen', 'shamen']));
	});

	it('builds a prefix query from the same terms', async () => {
		expect(await value('bolt_search_query($1, false)::text', 'kizmi')).toBe("'#ksm':* | 'kizmi':*");
		expect(await value('bolt_search_query($1, true)::text', 'bei jing')).toBe("'bei':* & 'jing':*");
		expect(await value('bolt_search_query($1, false)', '...')).toBeNull();
	});
});

const placesModel = defineModel({
	name: text({ search: true }).notNull(),
	note: text({ search: true })
});

const places = workspace({
	name: 'test-workspace',
	version: '1',
	collections: [compileModel(collection({ name: 'places', fields: {} }), placesModel)],
	apps: [],
	policies: [
		policy({ name: 'admin', effect: 'allow', actions: ['*'], capabilities: { apps: ['*'] } })
	],
	teams: { admin: ['admin'] },
	automations: [],
	integrations: [],
	prompt: 'You are the test workspace agent.',
	tools: [],
	skills: [],
	channels: [],
	envoys: [],
	requiredFacilities: []
});

const placesAuthored: AuthoredRuntime = {
	...emptyAuthoredRuntime,
	collections: { places: { create: { input: { columns: { name: true, note: true } } } } }
};

const placeRows: ReadonlyArray<readonly [string, string | null]> = [
	['Kismis', null],
	['Kimchi House', null],
	['Kasma Tailor', null],
	['Kismis Raya Bakery', null],
	['Dunearn Road 12', null],
	['Dunearn Close', null],
	['Singapore Botanic Gardens', null],
	['Bedok North Avenue 1', 'block 511'],
	['Bedok North Avenue 3', null],
	['Bedok Reservoir Road 3', null],
	['北京市朝阳区建国路', null],
	['Beijing Road', null],
	['东京', null],
	['Café Déjà Vu', null],
	['重庆火锅', null]
];

/** Ids ascending in fixture order, so an id tie-break is visible in the expected order. */
const placeId = (index: number): string =>
	`00000000-0000-5000-8000-${(index + 1).toString().padStart(12, '0')}`;

const seedPlaces = (harness: BoltTestRuntime) =>
	harness.runtime.runPromise(
		Effect.gen(function* () {
			yield* (yield* Collections.Service).write(harness.effectId('seed'), adminSubject, [
				{
					collection: 'places',
					action: 'create',
					inputs: placeRows.map(([name, note], index) => ({ id: placeId(index), name, note }))
				}
			]);
		})
	);

const searchPlaces = (harness: BoltTestRuntime, term: string) =>
	harness.runtime.runPromise(
		Effect.gen(function* () {
			const rows = yield* (yield* Collections.Service).findMany(
				harness.effectId('find'),
				adminSubject,
				{ collection: 'places', search: { mode: 'lexical', term } }
			);
			return rows.map((row) =>
				row !== null && typeof row === 'object' && !Array.isArray(row)
					? Reflect.get(row, 'name')
					: null
			);
		})
	);

describe('ranked lexical search', () => {
	let placesHarness: BoltTestRuntime | undefined;
	beforeAll(async () => {
		placesHarness = await makeBoltTestRuntime(places, { authored: placesAuthored });
		await seedPlaces(placesHarness);
	});
	afterAll(() => placesHarness?.dispose());
	const first = async (term: string) => (await searchPlaces(placesHarness!, term))[0];

	it.each([
		['kizmi', 'Kismis'],
		['dunearn rd', 'Dunearn Road 12'],
		['sngapore', 'Singapore Botanic Gardens'],
		['bedok nth ave 3', 'Bedok North Avenue 3'],
		['cafe deja vu', 'Café Déjà Vu'],
		['CAFÉ', 'Café Déjà Vu']
	])('ranks the closest row first for a slipped term: %s', async (term, expected) => {
		expect(await first(term)).toBe(expected);
	});

	it('finds Chinese text by pinyin, spaced or not, and by a second reading', async () => {
		// 东京 shares `jing`, so it trails: a partial match, ranked below both halves matching.
		expect(await searchPlaces(placesHarness!, 'bei jing')).toEqual([
			'北京市朝阳区建国路',
			'Beijing Road',
			'东京'
		]);
		expect(await searchPlaces(placesHarness!, 'beijing')).toContain('北京市朝阳区建国路');
		expect(await first('chaoyang')).toBe('北京市朝阳区建国路');
		expect(await first('chongqing')).toBe('重庆火锅');
	});

	it('finds Chinese text by a partial Chinese phrase', async () => {
		expect(await first('朝阳')).toBe('北京市朝阳区建国路');
		expect(await first('北京')).toBe('北京市朝阳区建国路');
	});

	it('ranks an exact word above fuzzy neighbours and orders ties by id', async () => {
		expect(await searchPlaces(placesHarness!, 'kismis')).toEqual(['Kismis', 'Kismis Raya Bakery']);
		const kizmi = await searchPlaces(placesHarness!, 'kizmi');
		expect(kizmi.slice(0, 2)).toEqual(['Kismis', 'Kismis Raya Bakery']);
		expect(kizmi).not.toContain('Kimchi House');
		expect(await searchPlaces(placesHarness!, 'kizmi')).toEqual(kizmi);
	});

	it('returns nothing for noise', async () => {
		expect(await searchPlaces(placesHarness!, 'zzqx')).toEqual([]);
		expect(await searchPlaces(placesHarness!, '...')).toEqual([]);
	});
});
