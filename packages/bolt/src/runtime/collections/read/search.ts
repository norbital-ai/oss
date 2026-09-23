import { sql, type SQL } from 'drizzle-orm';
import { Result, Schema } from 'effect';
import type { FieldDefinition } from '#lib/authoring/workspace-schema.js';
import {
	RECORD_EMBEDDING_COLUMN,
	SEARCH_DOCUMENT_COLUMN,
	searchableColumns
} from '#lib/authoring/model-introspection.js';

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

const prefixTsquery = (term: string): string =>
	term
		.normalize('NFKC')
		.split(/\s+/u)
		.map((token) => token.replaceAll(/[^\p{L}\p{N}_-]/gu, ''))
		.filter((token) => token !== '')
		.map((token) => `${token}:*`)
		.join(' & ');

/** Compiles indexed multilingual lexical matching and its deterministic rank expression. */
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
	const text = searchableText(context, names);
	const webQuery = sql`websearch_to_tsquery('simple', ${term})`;
	const prefix = prefixTsquery(term);
	const prefixMatch =
		prefix === '' ? sql`false` : sql`${document} @@ to_tsquery('simple', ${prefix})`;
	const match = sql`(${document} @@ ${webQuery} or ${prefixMatch} or similarity(${text}, ${term}) > 0.2 or word_similarity(${term}, ${text}) > 0.35)`;
	const rank = sql<number>`(
		ts_rank_cd(${document}, ${webQuery}) * 0.7 +
		greatest(similarity(${text}, ${term}), word_similarity(${term}, ${text})) * 0.3
	)`;
	return Result.succeed({
		mode: 'lexical',
		term,
		predicate: conjunction([context.basePredicate, match]),
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
