import { sql, type SQL } from 'drizzle-orm';
import { Result, Schema } from 'effect';
import { parseCollectionSearch } from '@norbital-ai/std/collection';
import type { FieldDefinition } from '#lib/authoring/workspace-schema.js';
import {
	RECORD_EMBEDDING_COLUMN,
	SEARCH_DOCUMENT_COLUMN,
	searchableColumns
} from '#lib/authoring/model-introspection.js';
import { ROMANIZATION } from './romanization.js';

export { RECORD_EMBEDDING_COLUMN, SEARCH_DOCUMENT_COLUMN };

/** Plain text, `/semantic <text>` or `/<index> <json>`; see `CollectionSearch` in std. */
export type SearchInput = string | null | undefined;

/** What the planner needs of a declared similarity index: the column, the operator, the probe. */
export type NearestProbe = Readonly<{
	readonly column: string;
	readonly operator: '<->' | '<=>' | '<#>';
	readonly probe: ReadonlyArray<number>;
	/** Equalities on the collection's own columns the target narrows by, beside the ranking. */
	readonly where?: Readonly<Record<string, string | number | boolean | null>>;
}>;

export type SearchContext = Readonly<{
	readonly collection: string;
	readonly fields: Readonly<Record<string, FieldDefinition>>;
	readonly qualifier?: string | undefined;
	/** Schema-plan witness that the generated lexical document exists. */
	readonly searchDocumentColumn?: typeof SEARCH_DOCUMENT_COLUMN | undefined;
	/** Model/schema witness that the platform-owned vector column exists. */
	readonly embeddingColumn?: typeof RECORD_EMBEDDING_COLUMN | undefined;
	/** Ordinary query narrowing and policy, already compiled for this level. */
	readonly basePredicate?: SQL | undefined;
}>;

class SearchCompileError extends Schema.TaggedError<SearchCompileError>()(
	'Bolt.Collections.Read.SearchCompileError',
	{
		collection: Schema.NonEmptyString,
		field: Schema.NonEmptyString,
		message: Schema.NonEmptyString
	}
) {}

/**
 * One planned search. `ordering` is the whole ranking (closest first); the read path appends its
 * own terms and the id, so ties are deterministic. Only the lexical plan is live: a vector rank is
 * measured once against the probe.
 */
type SearchPlan =
	| Readonly<{ readonly mode: 'none'; readonly predicate: SQL }>
	| Readonly<{
			readonly mode: 'lexical' | 'semantic';
			readonly predicate: SQL;
			readonly ordering: SQL;
	  }>
	| Readonly<{
			readonly mode: 'nearest';
			readonly index: string;
			readonly target: Readonly<Record<string, unknown>>;
			readonly column: string;
			readonly probe: ReadonlyArray<number>;
			readonly predicate: SQL;
			readonly ordering: SQL;
	  }>;

type LexicalParts = Readonly<{ readonly match: SQL; readonly rank: SQL<number> }>;

const failure = (
	context: SearchContext,
	field: string,
	message: string
): Result.Result<never, SearchCompileError> =>
	Result.fail(new SearchCompileError({ collection: context.collection, field, message }));

const qualifiedColumn = (context: SearchContext, name: string): SQL =>
	context.qualifier === undefined
		? sql`${sql.identifier(name)}`
		: sql`${sql.identifier(context.qualifier)}.${sql.identifier(name)}`;

const conjunction = (clauses: ReadonlyArray<SQL | undefined>): SQL => {
	const present = clauses.filter((clause): clause is SQL => clause !== undefined);
	if (present.length === 0) return sql`true`;
	if (present.length === 1) return present[0] ?? sql`true`;
	return sql`(${sql.join(present, sql` and `)})`;
};

const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Unknown));

const searchableText = (context: SearchContext, names: ReadonlyArray<string>): SQL =>
	sql`concat_ws(' ', ${sql.join(
		names.map((name) => sql`coalesce(${qualifiedColumn(context, name)}::text, '')`),
		sql`, `
	)})`;

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
export const lexicalSearchSteps = (): ReadonlyArray<Readonly<{ id: string; sql: string }>> => [
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
		// `every`: each native query word and CJK run, as a prefix. Otherwise any lexeme that can place a row.
		id: 'bolt:function-search-5-query',
		sql: "create or replace function bolt_search_query(term text, every boolean) returns tsquery language plpgsql immutable strict parallel safe as $bolt_search$ begin return (select string_agg(distinct quote_literal(lexeme) || case when kind = 'j' then '' else ':*' end, case when every then ' & ' else ' | ' end)::tsquery from bolt_search_terms(term) where lexeme <> '' and (kind in ('w', 'r') or (not every and (kind in ('a', 'j') or (kind = 's' and char_length(lexeme) >= 4))))); end $bolt_search$"
	}
];

/**
 * Indexed multilingual lexical matching and its deterministic rank, or nothing when no text column
 * is searchable.
 *
 * A row matches when any query lexeme meets its document (GIN). The rank puts rows holding every
 * query word first, then orders by how much of the query landed and how closely the folded text
 * resembles the folded term.
 */
const lexicalParts = (
	term: string,
	context: SearchContext
): Result.Result<LexicalParts | undefined, SearchCompileError> => {
	const names = searchableColumns(context.fields);
	if (names.length === 0) return Result.succeed(undefined);
	if (context.searchDocumentColumn === undefined) {
		return failure(
			context,
			'search',
			`Collection '${context.collection}' has no generated lexical search document.`
		);
	}
	const document = qualifiedColumn(context, context.searchDocumentColumn);
	const text = sql`bolt_search_fold(${searchableText(context, names)})`;
	const folded = sql`bolt_search_fold(${term})`;
	const any = sql`bolt_search_query(${term}, false)`;
	return Result.succeed({
		match: sql`${document} @@ ${any}`,
		rank: sql<number>`(
		(${document} @@ bolt_search_query(${term}, true))::int * 2 +
		ts_rank('{1,1,1,1}', ${document}, ${any}) +
		word_similarity(${folded}, ${text}) +
		0.1 / (1 + length(${document}))
	)`
	});
};

/** Plain text: deterministic search, ranked closest first. No text column searchable, no rows. */
export const compileLexicalSearch = (
	term: string,
	context: SearchContext
): Result.Result<SearchPlan, SearchCompileError> => {
	const parts = lexicalParts(term, context);
	if (Result.isFailure(parts)) return Result.fail(parts.failure);
	return Result.succeed(
		parts.success === undefined
			? {
					mode: 'lexical',
					predicate: conjunction([context.basePredicate, sql`false`]),
					// Cast, because a bare `0` in ORDER BY is an ordinal and PostgreSQL refuses position zero.
					ordering: sql`0::double precision`
				}
			: {
					mode: 'lexical',
					predicate: conjunction([context.basePredicate, parts.success.match]),
					ordering: sql`${parts.success.rank} desc`
				}
	);
};

const vectorLiteral = (probe: ReadonlyArray<number>): string => `[${probe.join(',')}]`;

/** Reciprocal-rank fusion's damping constant: the standard 60, so no one list's head dominates. */
const FUSION_K = sql.raw('60');

/**
 * `/semantic`: the deterministic ranking and the record embedding's, fused by reciprocal rank.
 *
 * A row is a candidate when it matches lexically or has a vector. Each list contributes
 * `1 / (60 + rank)` for the rows it placed and nothing for the rest, so the lexical head scores at
 * least `1/61 + 1/(60 + n)` and outranks every row only the vector found: an exact or slipped hit
 * is never lost to meaning, and meaning still orders everything else.
 */
export const compileSemanticSearch = (
	term: string,
	probe: ReadonlyArray<number>,
	context: SearchContext
): Result.Result<SearchPlan, SearchCompileError> => {
	if (probe.length === 0 || !probe.every((value) => Number.isFinite(value))) {
		return failure(context, 'search.probe', 'The embedder returned no finite vector probe.');
	}
	if (context.embeddingColumn === undefined) {
		return failure(
			context,
			'search',
			`Collection '${context.collection}' has no searchable column to embed.`
		);
	}
	const lexical = lexicalParts(term, context);
	if (Result.isFailure(lexical)) return Result.fail(lexical.failure);
	const embedding = qualifiedColumn(context, context.embeddingColumn);
	const distance = sql`${embedding} <=> ${vectorLiteral(probe)}::vector`;
	const vectorScore = sql`case when ${embedding} is not null then 1.0 / (${FUSION_K} + rank() over (order by ${distance})) else 0 end`;
	// ponytail: fusion ranks every candidate (window over the whole narrowed collection); bound the
	// vector list with an HNSW top-k subquery if collections outgrow a sequential rank.
	if (lexical.success === undefined) {
		return Result.succeed({
			mode: 'semantic',
			predicate: conjunction([context.basePredicate, sql`${embedding} is not null`]),
			ordering: sql`${vectorScore} desc`
		});
	}
	const { match, rank } = lexical.success;
	const lexicalScore = sql`case when ${match} then 1.0 / (${FUSION_K} + rank() over (order by (${match}) desc, ${rank} desc)) else 0 end`;
	return Result.succeed({
		mode: 'semantic',
		predicate: conjunction([context.basePredicate, sql`(${match} or ${embedding} is not null)`]),
		ordering: sql`(${lexicalScore} + ${vectorScore}) desc`
	});
};

/** Compiles the probe of a declared similarity index: the index's own column and operator. */
const compileNearestSearch = (
	index: string,
	target: Readonly<Record<string, unknown>>,
	nearest: NearestProbe,
	context: SearchContext
): Result.Result<SearchPlan, SearchCompileError> => {
	if (nearest.probe.length === 0 || !nearest.probe.every((value) => Number.isFinite(value))) {
		return failure(context, 'search.target', `Index '${index}' produced no finite probe.`);
	}
	const column = qualifiedColumn(context, nearest.column);
	const probeSql = sql`${vectorLiteral(nearest.probe)}::vector`;
	const narrowed = Object.entries(nearest.where ?? {}).map(([name, value]) =>
		value === null
			? sql`${qualifiedColumn(context, name)} is null`
			: sql`${qualifiedColumn(context, name)} = ${value}`
	);
	return Result.succeed({
		mode: 'nearest',
		index,
		target,
		column: nearest.column,
		probe: nearest.probe,
		predicate: conjunction([context.basePredicate, sql`${column} is not null`, ...narrowed]),
		ordering: sql`${column} ${sql.raw(nearest.operator)} ${probeSql} asc`
	});
};

const errorMessage = (cause: unknown, fallback: string): string =>
	cause instanceof Error ? cause.message : fallback;

/**
 * Runtime branch point for search: one grammar for every read surface.
 *
 * Plain text never wakes a model. `/semantic <text>` embeds the text once and fuses; `/<index>
 * <json>` hands the parsed capture form to the declared index, which answers the probe.
 */
export const prepareSearchPlan = async (
	input: SearchInput,
	context: SearchContext,
	embed: (term: string) => Promise<ReadonlyArray<number>>,
	nearest?: (index: string, target: Readonly<Record<string, unknown>>) => Promise<NearestProbe>
): Promise<Result.Result<SearchPlan, SearchCompileError>> => {
	const { command, term } = parseCollectionSearch(input ?? '');
	if (command === undefined) {
		return term === ''
			? Result.succeed({ mode: 'none', predicate: context.basePredicate ?? sql`true` })
			: compileLexicalSearch(term, context);
	}
	if (term === '') return failure(context, 'search', `/${command} needs something to search for.`);
	if (command === 'semantic') {
		try {
			// Exactly one model call per explicit semantic request.
			return compileSemanticSearch(term, await embed(term), context);
		} catch (cause) {
			return failure(
				context,
				'search',
				errorMessage(cause, 'The semantic query could not be embedded.')
			);
		}
	}
	if (nearest === undefined)
		return failure(context, 'search', 'This read surface offers no similarity indexes.');
	let target: unknown;
	try {
		target = JSON.parse(term);
	} catch {
		target = undefined;
	}
	if (!isRecord(target))
		return failure(
			context,
			'search.target',
			`/${command} takes its capture form as a JSON object, e.g. /${command} {"field": value}.`
		);
	try {
		return compileNearestSearch(command, target, await nearest(command, target), context);
	} catch (cause) {
		return failure(context, 'search', errorMessage(cause, 'The target could not be embedded.'));
	}
};
