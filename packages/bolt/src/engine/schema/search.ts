// The multilingual search tokenizer (rules 16, L-BOLT-121/122), ported as is: installed as SQL functions by the schema
// plan, so the stored document (a generated column) and the typed query are folded and tokenized by one implementation.
import { ROMANIZATION } from './romanization.ts';

/** Han, kana, bopomofo and Hangul: scripts written without spaces between words. */
const CJK = String.raw`⺀-⿟぀-ヿ㄀-ㄯ㆐-ㇿ㐀-䶿一-鿿가-힯豈-﫿`;
/** Separators after NFKC: ASCII/Latin-1, general and CJK punctuation, symbols, full-width forms. */
const SEPARATOR = String.raw`\x01-\x2f\x3a-\x40\x5b-\x60\x7b-\xbf\xd7\xf7 -⯿　-〿︐-﹯＀-／：-＠［-｀｛-･`;

/**
 * The romanization lookup: two bytes per code point of the table's span naming the glyph's
 * reading, so each glyph is one `get_byte` pair and one jsonb array index — constant time, no scan.
 * An unmapped glyph (ASCII, digits) reads as itself.
 */
const romanizeFunction = (): string => {
	const readings: Array<string> = [];
	const indexOf = new Map<number, number>();
	for (const group of ROMANIZATION.split('|')) {
		const colon = group.indexOf(':');
		readings.push(group.slice(0, colon));
		for (const glyph of group.slice(colon + 1))
			indexOf.set(glyph.codePointAt(0) ?? 0, readings.length);
	}
	let first = Infinity;
	let last = 0;
	for (const code of indexOf.keys()) {
		first = Math.min(first, code);
		last = Math.max(last, code);
	}
	const codes = new Uint16Array(last - first + 1);
	for (const [code, index] of indexOf) codes[code - first] = index;
	const hex = Array.from(codes, (code) => code.toString(16).padStart(4, '0')).join('');
	return `create or replace function bolt_search_romanize(run text) returns text[] language plpgsql immutable strict parallel safe as $bolt_search$ begin return array(select coalesce(case when code between 0 and ${codes.length - 1} then readings ->> (nullif(get_byte(codes, 2 * code) * 256 + get_byte(codes, 2 * code + 1), 0) - 1) end, glyph) from (select decode('${hex}', 'hex') as codes, '${JSON.stringify(readings)}'::jsonb as readings) as lookup, regexp_split_to_table(run, '') with ordinality as t(glyph, position), lateral (select ascii(glyph) - ${first} as code) as offsets order by position); end $bolt_search$`;
};

/**
 * The database half of lexical search, installed by the schema plan's foundation.
 *
 * One implementation folds and tokenises both the stored document and the query, so the two can
 * never disagree. `bolt_search_fold`: NFKD, combining marks (accents, pinyin tones) removed, NFKC
 * (full-width to half-width), lower case, apostrophes dropped, punctuation to spaces, CJK runs set
 * apart. `bolt_search_terms` then emits two forms of every word, both in the one document:
 *
 * - native: the word (`w`); for CJK runs every suffix of up to eight characters (`r` for the whole
 *   run, `c` for the rest), so any partial phrase is a prefix of some lexeme;
 * - Latin sounds: a word in any other script romanized glyph by glyph (`a`: Москва → moskva, دبي →
 *   dby); a CJK run's syllables (`p`: pinyin for Han with a second reading, kana, Hangul), every
 *   reading pair (`j`) and the common-reading join of each suffix up to eight syllables (`j`:
 *   北京市 → beijingshi, 서울 → seoul);
 *
 * and for every Latin word, native or romanized, a consonant skeleton (`s`, `#`-prefixed) so vowel
 * slips, doubled letters and c/k, z/s, ph/f spellings meet. Romanization happens when the row is
 * written, never per stored row at query time.
 */
export const SEARCH_FUNCTIONS: readonly { id: string; sql: string }[] = [
	{
		// a list field's words for the document: array_to_string is only stable, and a generated column needs immutable
		id: 'bolt:function-search-0-join',
		sql: "create or replace function bolt_search_join(value text[]) returns text language sql immutable strict parallel safe return array_to_string(value, ' ')",
	},
	{
		id: 'bolt:function-search-1-fold',
		sql: String.raw`create or replace function bolt_search_fold(value text) returns text language sql immutable strict parallel safe return btrim(regexp_replace(regexp_replace(regexp_replace(lower(case when octet_length(value) = char_length(value) then value else normalize(regexp_replace(normalize(value, NFKD), '[̀-ͯ]', '', 'g'), NFKC) end), '[''’]', '', 'g'), '[${SEPARATOR}]+|([${CJK}]+)', ' \1 ', 'g'), '\s+', ' ', 'g'))`
	},
	{ id: 'bolt:function-search-2-romanize', sql: romanizeFunction() },
	{
		id: 'bolt:function-search-3-terms',
		sql: String.raw`create or replace function bolt_search_terms(value text) returns table(kind text, lexeme text) language plpgsql immutable strict parallel safe set jit = off as $bolt_search$ begin return query
with words as (select word from regexp_split_to_table(bolt_search_fold(value), ' ') as word where word <> ''),
runs as (select distinct word, bolt_search_romanize(word) as readings from words where word ~ '^[${CJK}]'),
romanized as (select distinct array_to_string(array(select split_part(reading, ' ', 1) from unnest(bolt_search_romanize(word)) with ordinality as t(reading, position) order by position), '') as word from words where word !~ '^[${CJK}]' and word ~ '[^\x01-\x7f]'),
latin as (select regexp_replace(translate(replace(replace(word, 'ph', 'f'), 'ck', 'k'), 'cqzx', 'kkss'), '(.)\1+', '\1', 'g') as folded from (select word from words union select word from romanized) as spelled where word ~ '^[a-z]{3,}$')
select 'w', word from words where word !~ '^[${CJK}]'
union all select 'a', romanized.word from romanized where romanized.word not in (select word from words)
union all select 's', '#' || left(folded, 1) || regexp_replace(substr(folded, 2), '[aeiouyhw]', '', 'g') from latin
union all select case when position = 1 then 'r' else 'c' end, substr(word, position, 8) from runs, generate_series(1, char_length(word)) as position
union all select 'p', syllable from runs, unnest(readings) as reading, unnest(string_to_array(reading, ' ')) as syllable
union all select 'j', head || tail from runs, generate_series(1, cardinality(readings) - 1) as position, unnest(string_to_array(readings[position], ' ')) as head, unnest(string_to_array(readings[position + 1], ' ')) as tail
union all select 'j', string_agg(split_part(readings[position + step], ' ', 1), '' order by step) from runs, generate_series(1, cardinality(readings) - 2) as position, generate_series(0, least(7, cardinality(readings) - position)) as step group by word, position;
end $bolt_search$`
	},
	{
		id: 'bolt:function-search-4-document',
		sql: "create or replace function bolt_search_document(value text) returns tsvector language plpgsql immutable strict parallel safe as $bolt_search$ begin return array_to_tsvector(array(select distinct lexeme from bolt_search_terms(value) where lexeme <> '' and octet_length(lexeme) <= 256)); end $bolt_search$"
	},
	{
		// `every`: each native query word and CJK run, as a prefix. Otherwise any lexeme that can place a row. A possessive
		// `'s` is dropped from the query only ("Bob's jobs" → bob:*, which still prefixes a stored "bobs")
		id: 'bolt:function-search-5-query',
		sql: "create or replace function bolt_search_query(term text, every boolean) returns tsquery language plpgsql immutable strict parallel safe as $bolt_search$ begin return (select string_agg(distinct quote_literal(lexeme) || case when kind = 'j' then '' else ':*' end, case when every then ' & ' else ' | ' end)::tsquery from bolt_search_terms(regexp_replace(term, '[''’]s\\M', '', 'gi')) where lexeme <> '' and (kind in ('w', 'r') or (not every and (kind in ('a', 'j') or (kind = 's' and char_length(lexeme) >= 4))))); end $bolt_search$"
	},
	{
		// `$search` as a filter: every word of the term, each by any of its lexemes (a prefix, a romanization, a skeleton)
		id: 'bolt:function-search-6-filter',
		sql: "create or replace function bolt_search_filter(term text) returns tsquery language plpgsql immutable strict parallel safe as $bolt_search$ begin return (select string_agg('(' || q::text || ')', ' & ')::tsquery from regexp_split_to_table(bolt_search_fold(regexp_replace(term, '[''’]s\\M', '', 'gi')), ' ') as word, bolt_search_query(word, false) as q where q is not null); end $bolt_search$"
	}
];

