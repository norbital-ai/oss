// The multilingual search tokenizer (L-BOLT-121/122), ported case for case: the SQL the schema plan installs folds and
// tokenizes both the stored document and the typed query, so these pin what a row and a term turn into.
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEARCH_FUNCTIONS } from '../src/engine/schema/search.ts';

describe('lexical tokenizer', () => {
	const database = new PGlite();
	beforeAll(async () => {
		for (const step of SEARCH_FUNCTIONS) await database.exec(step.sql);
	});
	afterAll(() => database.close());
	const value = async (statement: string, parameter: string): Promise<unknown> =>
		(await database.query<{ value: unknown }>(`select ${statement} as value`, [parameter])).rows[0]?.value;
	const lexemes = async (text: string): Promise<readonly string[]> =>
		(await database.query<{ lexeme: string }>('select lexeme from bolt_search_terms($1) order by kind, lexeme', [text])).rows.map((row) => row.lexeme);

	it('folds width, case, accents, tones and punctuation the same way everywhere', async () => {
		expect(await value('bolt_search_fold($1)', "Ｂｅｄｏｋ Nth. Ave-3, Café O'Brien Běijīng")).toBe('bedok nth ave 3 cafe obrien beijing');
		expect(await value('bolt_search_fold($1)', 'Jalan《北京》路ｶﾀｶﾅ')).toBe('jalan 北京 路カタカナ');
	});

	it('romanizes every script to Latin, keeping a second Han reading', async () => {
		expect(await value('bolt_search_romanize($1)', '北京厦门')).toEqual(['bei', 'jing', 'sha xia', 'men']);
		const latin = async (text: string) => (await lexemes(text)).filter((lexeme) => /^[a-z0-9]+$/.test(lexeme));
		expect(await latin('Москва')).toContain('moskva');
		expect(await latin('دبي')).toContain('dby');
		expect(await latin('東京')).toContain('dongjing');
		expect(await latin('とうきょう')).toContain('toukiyou');
		expect(await latin('トウキョウ')).toContain('toukiyou');
		expect(await latin('서울')).toContain('seoul');
		expect(await latin('नमस्ते')).toContain('nmste');
		expect(await latin('Αθήνα')).toContain('athina');
		expect(await latin('Straße')).toContain('strasse');
	});

	it('indexes CJK suffixes, pinyin syllables and joins, and Latin skeletons', async () => {
		expect(await lexemes('北京市 Kismis')).toEqual(expect.arrayContaining(['北京市', '京市', '市', 'bei', 'beijing', 'beijingshi', 'kismis', '#ksms']));
		expect(await lexemes('厦门')).toEqual(expect.arrayContaining(['xiamen', 'shamen']));
		// a romanized word gets its skeleton too, so a vowel-full spelling meets an abjad or abugida
		expect(await lexemes('नमस्ते')).toContain('#nmst');
		expect(await lexemes('Москва')).toContain('#mskv');
	});

	it('builds a prefix query from the same terms', async () => {
		expect(await value('bolt_search_query($1, false)::text', 'kizmi')).toBe("'#ksm':* | 'kizmi':*");
		expect(await value('bolt_search_query($1, true)::text', 'bei jing')).toBe("'bei':* & 'jing':*");
		expect(await value('bolt_search_query($1, false)', '...')).toBeNull();
	});

	it('finds a document by pinyin, by a partial Chinese phrase, by any script\'s Latin spelling and by a slipped spelling', async () => {
		const hit = async (doc: string, term: string) => value(`bolt_search_document($1) @@ bolt_search_query('${term}', false)`, doc);
		expect(await hit('北京市朝阳区建国路', 'beijing')).toBe(true);
		expect(await hit('北京市朝阳区建国路', '朝阳')).toBe(true);
		expect(await hit('Москва', 'moskva')).toBe(true);
		expect(await hit('Kismis Raya Bakery', 'kizmis')).toBe(true);
		expect(await hit('Kimchi House', 'zzqx')).toBe(false);
	});
});
