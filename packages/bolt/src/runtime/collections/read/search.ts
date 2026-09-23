import { sql, type SQL } from 'drizzle-orm';
import { Result, Schema } from 'effect';
import type { FieldDefinition } from '#lib/authoring/workspace-schema.js';
import {
	RECORD_EMBEDDING_COLUMN,
	SEARCH_DOCUMENT_COLUMN,
	searchableColumns
} from '#lib/authoring/model-introspection.js';
import { PINYIN_READINGS } from './pinyin.js';

export { RECORD_EMBEDDING_COLUMN, SEARCH_DOCUMENT_COLUMN };

/** Search modes are explicit wire commands; only semantic mode may wake an embedder. */
type LexicalSearchCommand = Readonly<{
	readonly mode: 'lexical';
	readonly term: string;
}>;

type SemanticSearchCommand = Readonly<{
	readonly mode: 'semantic';
	readonly term: string;
}>;

/** A declared similarity index and a target in its capture form's shape. */
type NearestSearchCommand = Readonly<{
	readonly mode: 'nearest';
	readonly index: string;
	readonly target: Readonly<Record<string, unknown>>;
}>;

export type SearchInput =
	LexicalSearchCommand | SemanticSearchCommand | NearestSearchCommand | null | undefined;

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

type EmptySearchPlan = Readonly<{
	readonly mode: 'none';
	readonly predicate: SQL;
	readonly corpusRelative: false;
	readonly live: true;
}>;

type LexicalSearchPlan = Readonly<{
	readonly mode: 'lexical';
	readonly term: string;
	readonly predicate: SQL;
	readonly rank: SQL<number>;
	readonly orderBy: ReadonlyArray<
		Readonly<{ readonly expression: SQL; readonly direction: 'desc' }>
	>;
	readonly corpusRelative: true;
	readonly live: true;
}>;

type SemanticSearchPlan = Readonly<{
	readonly mode: 'semantic';
	readonly term: string;
	readonly probe: ReadonlyArray<number>;
	readonly predicate: SQL;
	readonly distance: SQL<number>;
	readonly orderBy: ReadonlyArray<
		Readonly<{ readonly expression: SQL; readonly direction: 'asc' }>
	>;
	readonly corpusRelative: true;
	readonly live: false;
}>;

type NearestSearchPlan = Readonly<{
	readonly mode: 'nearest';
	readonly index: string;
	readonly target: Readonly<Record<string, unknown>>;
	readonly column: string;
	readonly probe: ReadonlyArray<number>;
	readonly predicate: SQL;
	readonly distance: SQL<number>;
	readonly orderBy: ReadonlyArray<
		Readonly<{ readonly expression: SQL; readonly direction: 'asc' }>
	>;
	readonly corpusRelative: true;
	readonly live: false;
}>;

type SearchPlan = EmptySearchPlan | LexicalSearchPlan | SemanticSearchPlan | NearestSearchPlan;

type NormalizedSearch =
	| Readonly<{ readonly mode: 'none' }>
	| Readonly<{ readonly mode: 'lexical'; readonly term: string }>
	| Readonly<{ readonly mode: 'semantic'; readonly term: string }>
	| Readonly<{
			readonly mode: 'nearest';
			readonly index: string;
			readonly target: Readonly<Record<string, unknown>>;
	  }>;

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

const normalizeSearch = (
	input: SearchInput,
	context: SearchContext
): Result.Result<NormalizedSearch, SearchCompileError> => {
	if (input === undefined || input === null) return Result.succeed({ mode: 'none' });
	if (input.mode === 'nearest') {
		if (typeof input.index !== 'string' || input.index === '' || !isRecord(input.target)) {
			return failure(
				context,
				'search',
				"A nearest search requires { mode: 'nearest', index, target }."
			);
		}
		return Result.succeed({ mode: 'nearest', index: input.index, target: input.target });
	}
	if ((input.mode !== 'lexical' && input.mode !== 'semantic') || typeof input.term !== 'string') {
		return failure(
			context,
			'search',
			"Search requires { mode: 'lexical' | 'semantic', term } or { mode: 'nearest', index, target }."
		);
	}
	const term = input.term.trim();
	if (term === '') return failure(context, 'search.term', 'Search requires a non-empty term.');
	return Result.succeed({ mode: input.mode, term });
};

const searchableText = (context: SearchContext, names: ReadonlyArray<string>): SQL =>
	sql`concat_ws(' ', ${sql.join(
		names.map((name) => sql`coalesce(${qualifiedColumn(context, name)}::text, '')`),
		sql`, `
	)})`;

/** Han, kana, bopomofo and Hangul: scripts written without spaces between words. */
const CJK = String.raw`\u2e80-\u2fdf\u3040-\u30ff\u3100-\u312f\u3190-\u31ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff`;
/** Separators after NFKC: ASCII/Latin-1, general and CJK punctuation, symbols, full-width forms. */
const SEPARATOR = String.raw`\x01-\x2f\x3a-\x40\x5b-\x60\x7b-\xbf\xd7\xf7\u2000-\u2bff\u3000-\u303f\ufe10-\ufe6f\uff00-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65`;

/**
 * The pinyin lookup: two bytes per code point of U+4E00–U+9FFF naming the character's readings,
 * so each character is one `get_byte` pair and one jsonb array index — constant time, no scan.
 */
const pinyinFunction = (): string => {
	const codes = new Uint16Array(0xa000 - 0x4e00);
	const readings = PINYIN_READINGS.split('|').map((group, index) => {
		const [reading = '', characters = ''] = group.split(':');
		for (const character of characters) codes[(character.codePointAt(0) ?? 0) - 0x4e00] = index + 1;
		return reading;
	});
	const hex = Array.from(codes, (code) => code.toString(16).padStart(4, '0')).join('');
	return `create or replace function bolt_search_pinyin(run text) returns text[] language plpgsql immutable strict parallel safe as $bolt_search$ begin return array(select case when code between 0 and ${codes.length - 1} then readings ->> (nullif(get_byte(codes, 2 * code) * 256 + get_byte(codes, 2 * code + 1), 0) - 1) end from (select decode('${hex}', 'hex') as codes, '${JSON.stringify(readings)}'::jsonb as readings) as lookup, regexp_split_to_table(run, '') with ordinality as t(glyph, position), lateral (select ascii(glyph) - 19968 as code) as offsets order by position); end $bolt_search$`;
};

/**
 * The database half of lexical search, installed by the schema plan's foundation.
 *
 * One implementation folds and tokenises both the stored document and the query, so the two can
 * never disagree. `bolt_search_fold`: NFKD, combining marks (accents, pinyin tones) removed, NFKC
 * (full-width to half-width), lower case, apostrophes dropped, punctuation to spaces, CJK runs set
 * apart. `bolt_search_terms` then emits, per word: the word (`w`); for Latin words a consonant
 * skeleton (`s`, `#`-prefixed) so vowel slips, doubled letters and c/k, z/s, ph/f spellings meet;
 * for CJK runs every suffix of up to eight characters (`r` for the whole run, `c` for the rest),
 * so any partial phrase is a prefix of some lexeme; and for Han the toneless pinyin syllables
 * (`p`), every reading pair (`j`) and the common-reading join of each suffix up to eight syllables
 * (`j`). Pinyin is computed when the row is written, never per query.
 */
export const lexicalSearchSteps = (): ReadonlyArray<Readonly<{ id: string; sql: string }>> => [
	{
		id: 'bolt:function-search-1-fold',
		sql: String.raw`create or replace function bolt_search_fold(value text) returns text language sql immutable strict parallel safe return btrim(regexp_replace(regexp_replace(regexp_replace(lower(case when octet_length(value) = char_length(value) then value else normalize(regexp_replace(normalize(value, NFKD), '[\u0300-\u036f]', '', 'g'), NFKC) end), '[''\u2019]', '', 'g'), '[${SEPARATOR}]+|([${CJK}]+)', ' \1 ', 'g'), '\s+', ' ', 'g'))`
	},
	{ id: 'bolt:function-search-2-pinyin', sql: pinyinFunction() },
	{
		id: 'bolt:function-search-3-terms',
		sql: String.raw`create or replace function bolt_search_terms(value text) returns table(kind text, lexeme text) language plpgsql immutable strict parallel safe set jit = off as $bolt_search$ begin return query
with words as (select word from regexp_split_to_table(bolt_search_fold(value), ' ') as word where word <> ''),
runs as (select distinct word, bolt_search_pinyin(word) as readings from words where word ~ '^[${CJK}]'),
latin as (select regexp_replace(translate(replace(replace(word, 'ph', 'f'), 'ck', 'k'), 'cqzx', 'kkss'), '(.)\1+', '\1', 'g') as folded from words where word ~ '^[a-z]{3,}$')
select 'w', word from words where word !~ '^[${CJK}]'
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
		// `every`: each query word and CJK run, as a prefix. Otherwise any lexeme that can place a row.
		id: 'bolt:function-search-5-query',
		sql: "create or replace function bolt_search_query(term text, every boolean) returns tsquery language plpgsql immutable strict parallel safe as $bolt_search$ begin return (select string_agg(distinct quote_literal(lexeme) || case when kind = 'j' then '' else ':*' end, case when every then ' & ' else ' | ' end)::tsquery from bolt_search_terms(term) where lexeme <> '' and (kind in ('w', 'r') or (not every and (kind = 'j' or (kind = 's' and char_length(lexeme) >= 4))))); end $bolt_search$"
	}
];

/**
 * Compiles indexed multilingual lexical matching and its deterministic rank.
 *
 * A row is a candidate when any query lexeme meets its document (GIN). The rank puts rows holding
 * every query word first, then orders by how much of the query landed and how closely the folded
 * text resembles the folded term; the read path breaks ties by id.
 */
export const compileLexicalSearch = (
	term: string,
	context: SearchContext
): Result.Result<LexicalSearchPlan, SearchCompileError> => {
	const names = searchableColumns(context.fields);
	if (names.length === 0) {
		return Result.succeed({
			mode: 'lexical',
			term,
			predicate: conjunction([context.basePredicate, sql`false`]),
			// Cast, because a bare `0` in ORDER BY is an ordinal and PostgreSQL refuses position zero.
			// The read path orders by this expression whenever the plan is lexical, so a collection
			// that opted no column in answered `ORDER BY position 0 is not in select list` instead of
			// the empty page its `false` predicate already guarantees.
			rank: sql<number>`0::double precision`,
			orderBy: [],
			corpusRelative: true,
			live: true
		});
	}
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
	const rank = sql<number>`(
		(${document} @@ bolt_search_query(${term}, true))::int * 2 +
		ts_rank('{1,1,1,1}', ${document}, ${any}) +
		word_similarity(${folded}, ${text}) +
		0.1 / (1 + length(${document}))
	)`;
	return Result.succeed({
		mode: 'lexical',
		term,
		predicate: conjunction([context.basePredicate, sql`${document} @@ ${any}`]),
		rank,
		orderBy: [{ expression: rank, direction: 'desc' }],
		corpusRelative: true,
		live: true
	});
};

const vectorLiteral = (probe: ReadonlyArray<number>): string => `[${probe.join(',')}]`;

/** Compiles the one-shot vector probe after the explicit semantic command has been embedded. */
export const compileSemanticSearch = (
	term: string,
	probe: ReadonlyArray<number>,
	context: SearchContext
): Result.Result<SemanticSearchPlan, SearchCompileError> => {
	if (probe.length === 0 || !probe.every((value) => Number.isFinite(value))) {
		return failure(context, 'search.probe', 'The embedder returned no finite vector probe.');
	}
	const embeddingName = context.embeddingColumn;
	if (embeddingName === undefined) {
		return failure(
			context,
			'search',
			`Collection '${context.collection}' does not declare a semantic embedding.`
		);
	}
	const embedding = qualifiedColumn(context, embeddingName);
	const probeSql = sql`${vectorLiteral(probe)}::vector`;
	const distance = sql<number>`${embedding} <=> ${probeSql}`;
	return Result.succeed({
		mode: 'semantic',
		term,
		probe,
		predicate: conjunction([context.basePredicate, sql`${embedding} is not null`]),
		distance,
		orderBy: [{ expression: distance, direction: 'asc' }],
		corpusRelative: true,
		live: false
	});
};

/** Compiles the probe of a declared similarity index: the index's own column and operator. */
const compileNearestSearch = (
	index: string,
	target: Readonly<Record<string, unknown>>,
	nearest: NearestProbe,
	context: SearchContext
): Result.Result<NearestSearchPlan, SearchCompileError> => {
	if (nearest.probe.length === 0 || !nearest.probe.every((value) => Number.isFinite(value))) {
		return failure(context, 'search.target', `Index '${index}' produced no finite probe.`);
	}
	const column = qualifiedColumn(context, nearest.column);
	const probeSql = sql`${vectorLiteral(nearest.probe)}::vector`;
	const distance = sql<number>`${column} ${sql.raw(nearest.operator)} ${probeSql}`;
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
		distance,
		orderBy: [{ expression: distance, direction: 'asc' }],
		corpusRelative: true,
		live: false
	});
};

/**
 * Runtime branch point for search.
 *
 * The embedder callback is reached only by the structurally distinct semantic command; the
 * declared-index callback only by a nearest command, which names the index it wants.
 */
export const prepareSearchPlan = async (
	input: SearchInput,
	context: SearchContext,
	embed: (term: string) => Promise<ReadonlyArray<number>>,
	nearest?: (index: string, target: Readonly<Record<string, unknown>>) => Promise<NearestProbe>
): Promise<Result.Result<SearchPlan, SearchCompileError>> => {
	const normalized = normalizeSearch(input, context);
	if (Result.isFailure(normalized)) return Result.fail(normalized.failure);
	if (normalized.success.mode === 'none') {
		return Result.succeed({
			mode: 'none',
			predicate: context.basePredicate ?? sql`true`,
			corpusRelative: false,
			live: true
		});
	}
	if (normalized.success.mode === 'lexical') {
		return compileLexicalSearch(normalized.success.term, context);
	}
	if (normalized.success.mode === 'nearest') {
		if (nearest === undefined)
			return failure(context, 'search', 'This read surface offers no similarity indexes.');
		try {
			const probe = await nearest(normalized.success.index, normalized.success.target);
			return compileNearestSearch(
				normalized.success.index,
				normalized.success.target,
				probe,
				context
			);
		} catch (cause) {
			return failure(
				context,
				'search',
				cause instanceof Error ? cause.message : 'The target could not be embedded.'
			);
		}
	}
	try {
		// Exactly one model call per explicit semantic request.
		const probe = await embed(normalized.success.term);
		return compileSemanticSearch(normalized.success.term, probe, context);
	} catch {
		/* best effort */
		return failure(context, 'search', 'The semantic query could not be embedded.');
	}
};
