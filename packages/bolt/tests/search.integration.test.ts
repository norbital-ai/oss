// The multilingual search tokenizer (L-BOLT-121/122), ported case for case: the SQL the schema plan installs folds and
// tokenizes both the stored document and the typed query, so these pin what a row and a term turn into.
import { Effect, Schema } from 'effect';
import { PgliteDb, Pristine } from '../src/engine/db/pglite.ts';
import type { TenantDbShape } from '../src/engine/db/tenant-db.ts';
import { describe, expect, it } from '@effect/vitest';
import { SEARCH_FUNCTIONS } from '../src/engine/schema/search.ts';
describe('lexical tokenizer', () => {
	let database: TenantDbShape;
	const setup = Effect.fnUntraced(function* () {
		database = PgliteDb.make(yield* PgliteDb.open());
		for (const step of SEARCH_FUNCTIONS) yield* database.write({ text: step.sql, params: [] });
	});
	const value = (statement: string, parameter: string) =>
		database.value(Schema.Json, { text: `select ${statement} as value`, params: [parameter] });
	const lexemes = Effect.fnUntraced(function* (text: string) {
		return (yield* database.rows(Schema.Struct({ lexeme: Schema.String }), {
			text: 'select lexeme from bolt_search_terms($1) order by kind, lexeme',
			params: [text]
		})).map((row) => row.lexeme);
	});
	it.live('folds width, case, accents, tones and punctuation the same way everywhere', () =>
		Effect.gen(function* () {
			yield* setup();
			expect(
				yield* value('bolt_search_fold($1)', "Ｂｅｄｏｋ Nth. Ave-3, Café O'Brien Běijīng")
			).toBe('bedok nth ave 3 cafe obrien beijing');
			expect(yield* value('bolt_search_fold($1)', 'Jalan《北京》路ｶﾀｶﾅ')).toBe(
				'jalan 北京 路カタカナ'
			);
		}).pipe(Effect.provide(Pristine.layer))
	);
	it.live('romanizes every script to Latin, keeping a second Han reading', () =>
		Effect.gen(function* () {
			yield* setup();
			expect(yield* value('bolt_search_romanize($1)', '北京厦门')).toEqual([
				'bei',
				'jing',
				'sha xia',
				'men'
			]);
			const latin = Effect.fnUntraced(function* (text: string) {
				return (yield* lexemes(text)).filter((lexeme) => /^[a-z0-9]+$/.test(lexeme));
			});
			expect(yield* latin('Москва')).toContain('moskva');
			expect(yield* latin('دبي')).toContain('dby');
			expect(yield* latin('東京')).toContain('dongjing');
			expect(yield* latin('とうきょう')).toContain('toukiyou');
			expect(yield* latin('トウキョウ')).toContain('toukiyou');
			expect(yield* latin('서울')).toContain('seoul');
			expect(yield* latin('नमस्ते')).toContain('nmste');
			expect(yield* latin('Αθήνα')).toContain('athina');
			expect(yield* latin('Straße')).toContain('strasse');
		}).pipe(Effect.provide(Pristine.layer))
	);
	it.live('indexes CJK suffixes, pinyin syllables and joins, and Latin skeletons', () =>
		Effect.gen(function* () {
			yield* setup();
			expect(yield* lexemes('北京市 Kismis')).toEqual(
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
			expect(yield* lexemes('厦门')).toEqual(expect.arrayContaining(['xiamen', 'shamen']));
			// a romanized word gets its skeleton too, so a vowel-full spelling meets an abjad or abugida
			expect(yield* lexemes('नमस्ते')).toContain('#nmst');
			expect(yield* lexemes('Москва')).toContain('#mskv');
		}).pipe(Effect.provide(Pristine.layer))
	);
	it.live('builds a prefix query from the same terms', () =>
		Effect.gen(function* () {
			yield* setup();
			expect(yield* value('bolt_search_query($1, false)::text', 'kizmi')).toBe(
				"'#ksm':* | 'kizmi':*"
			);
			expect(yield* value('bolt_search_query($1, true)::text', 'bei jing')).toBe(
				"'bei':* & 'jing':*"
			);
			expect(yield* value('bolt_search_query($1, false)', '...')).toBeNull();
		}).pipe(Effect.provide(Pristine.layer))
	);
	it.live(
		"finds a document by pinyin, by a partial Chinese phrase, by any script's Latin spelling and by a slipped spelling",
		() =>
			Effect.gen(function* () {
				yield* setup();
				const hit = Effect.fnUntraced(function* (doc: string, term: string) {
					return yield* value(
						`bolt_search_document($1) @@ bolt_search_query('${term}', false)`,
						doc
					);
				});
				expect(yield* hit('北京市朝阳区建国路', 'beijing')).toBe(true);
				expect(yield* hit('北京市朝阳区建国路', '朝阳')).toBe(true);
				expect(yield* hit('Москва', 'moskva')).toBe(true);
				expect(yield* hit('Kismis Raya Bakery', 'kizmis')).toBe(true);
				expect(yield* hit('Kimchi House', 'zzqx')).toBe(false);
				// a possessive names its owner ("Bob's jobs" found no Bob Tan), and still prefixes a stored possessive
				const found = Effect.fnUntraced(function* (doc: string, term: string) {
					return yield* database.value(Schema.Boolean, {
						text: 'select bolt_search_document($1) @@ bolt_search_query($2, false) as value',
						params: [doc, term]
					});
				});
				expect(yield* found('Bob Tan', "Bob's jobs")).toBe(true);
				expect(yield* found("Bob's Plumbing", 'bob’s')).toBe(true);
				expect(yield* found("O'Brien", "o'brien")).toBe(true);
			}).pipe(Effect.provide(Pristine.layer))
	);
});
