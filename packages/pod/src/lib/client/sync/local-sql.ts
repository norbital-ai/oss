import {
	isTemporalOperand,
	isUtcIsoInstant,
	temporalKindForFieldKind
} from '@norbital-ai/std/date';
import { decodeBase64Url, encodeBase64Url } from './base64url.js';

const PKEY = 'norbital_id';

/**
 * Compiling a collection query into local SQL.
 *
 * Split out of `client-sync.ts`, which had grown to ~900 lines doing two unrelated jobs: this,
 * and deciding when a local answer may be served at all. Nothing here touches the replica or the
 * network — every function takes a query and returns SQL and bound parameters, or null when the
 * query cannot be expressed locally and the server must answer. That makes the whole compiler
 * testable without a database, and makes the read path short enough to read in one sitting.
 *
 * The published schema lives here too, because it is what the compiler compiles against: which
 * columns exist, which are searchable, and how collections join.
 */
// ── schema facts ───────────────────────────────────────────────────────────────

/**
 * The client's view of the tenant schema — just enough to compile relations, search and
 * relation-path filters into local SQL. Published once by `runtime/client.ts` from the manifest
 * the runtime already has, so the executor never needs a round-trip to learn the shape of the data.
 *
 * Only *direct* relationships (a real foreign key on one side) appear here. A through/join
 * relationship has no single join field to compile against, so the local executor declines those
 * queries and the server answers them.
 */
export type LocalRelationship = {
	readonly name: string;
	/** The collection on the other end. */
	readonly target: string;
	readonly cardinality: 'one' | 'many';
	/** Join field on this collection. */
	readonly localField: string;
	/** Join field on the target collection. */
	readonly targetField: string;
};

export type LocalCollectionSchema = {
	readonly name: string;
	readonly columns: readonly string[];
	readonly fieldKinds: Readonly<Record<string, string>>;
	/** Non-array text-ish fields the server would include in a search. */
	readonly searchFields: readonly string[];
	readonly relationships: readonly LocalRelationship[];
};

let schema: ReadonlyMap<string, LocalCollectionSchema> = new Map();

export function setLocalSchema(next: ReadonlyMap<string, LocalCollectionSchema>): void {
	schema = next;
}

export function localCollection(collection: string): LocalCollectionSchema | undefined {
	return schema.get(collection);
}

export function localRelationship(
	collection: string,
	relation: string
): LocalRelationship | undefined {
	return schema.get(collection)?.relationships.find((entry) => entry.name === relation);
}

// ── SQL construction ───────────────────────────────────────────────────────────

type Built = { sql: string; params: unknown[] };

/**
 * A name scope. `alias` is how columns of `collection` are addressed in the SQL being built.
 * Every column reference is qualified with it so a correlated EXISTS can name an outer column
 * without the inner table shadowing it — which is not hypothetical: a self-relation puts the same
 * table on both sides.
 */
export type Scope = { readonly collection: string; readonly alias: string };

/** Mutable compile state: bound parameters and a counter for unique subquery aliases. */
export type Build = { readonly params: unknown[]; aliases: number };

export function column(scope: Scope, field: string): string {
	return `${scope.alias}.${ident(field)}`;
}

export function buildSelect(collection: string, query: Record<string, unknown>): Built | null {
	const where = buildWhereClause(collection, query);
	if (where === null) return null;

	// Order by the *normalised* order, exactly as the server's findManyPage does. Ordering by the
	// raw `orderBy` is a keyset-pagination bug: the cursor is encoded against the normalised order
	// (which appends `norbital_id` as a tiebreaker), so without the tiebreaker in the SQL the row
	// order is unstable across pages. With rows that share a sort value — a freshly seeded table
	// where every `norbital_created_at` is identical — page 2 can filter out everything and render
	// empty while page 1 looked fine.
	const order = buildOrderBy(normalizeOrder(query.orderBy));
	if (order === null) return null;

	const params = [...where.params];
	const keyset = buildKeysetWhere(query.after, query.orderBy, params);
	if (keyset === null) return null;

	const conditions = [where.sql.replace(/^ WHERE /, ''), keyset].filter(Boolean);
	const whereClause = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
	const limit =
		typeof query.limit === 'number' ? ` LIMIT ${Math.max(0, Math.floor(query.limit))}` : '';

	return {
		sql: `SELECT ${ident(collection)}.* FROM ${ident(collection)}${whereClause}${order}${limit}`,
		params
	};
}

/** The complete predicate: `where` + interactive `filters` + `search`, ANDed like the server does. */
export function buildWhereClause(collection: string, query: Record<string, unknown>): Built | null {
	const build: Build = { params: [], aliases: 0 };
	const scope: Scope = { collection, alias: ident(collection) };
	const clauses: string[] = [];

	const where = buildWhere(scope, query.where, build);
	if (where === null) return null;
	if (where) clauses.push(where);

	// `filters` ride in the same wire payload as `where` but are a separate, relation-aware
	// dialect. Ignoring them would silently return unfiltered rows.
	for (const filter of readFilters(query.filters)) {
		const clause = buildFilter(scope, filter, build);
		if (clause === null) return null;
		clauses.push(clause);
	}

	if (hasSearch(query)) {
		const clause = buildSearch(scope, String(query.search).trim(), build);
		if (clause === null) return null;
		clauses.push(clause);
	}

	return { sql: clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '', params: build.params };
}

const OPERATORS: Record<string, string> = {
	eq: '=',
	ne: '<>',
	gt: '>',
	gte: '>=',
	lt: '<',
	lte: '<=',
	like: 'LIKE',
	ilike: 'ILIKE'
};

export function buildWhere(scope: Scope, where: unknown, build: Build): string | null {
	if (where == null) return '';
	if (typeof where !== 'object' || Array.isArray(where)) return null;
	const clauses: string[] = [];

	for (const [field, condition] of Object.entries(where as Record<string, unknown>)) {
		if ((field === 'AND' || field === 'OR') && Array.isArray(condition)) {
			const parts: string[] = [];
			for (const entry of condition) {
				const clause = buildWhere(scope, entry, build);
				if (clause === null) return null;
				if (clause) parts.push(`(${clause})`);
			}
			if (parts.length) clauses.push(`(${parts.join(field === 'AND' ? ' AND ' : ' OR ')})`);
			continue;
		}
		if (field === 'NOT') {
			const clause = buildWhere(scope, condition, build);
			if (clause === null) return null;
			if (clause) clauses.push(`NOT (${clause})`);
			continue;
		}

		// A relation name in `where` filters by the existence of a matching related row.
		const relation = localRelationship(scope.collection, field);
		if (relation) {
			const clause = buildRelationExists(scope, relation, condition, build);
			if (clause === null) return null;
			clauses.push(clause);
			continue;
		}

		if (!isIdent(field)) return null;
		const clause = buildCondition(scope, field, condition, build);
		if (clause === null) return null;
		clauses.push(clause);
	}

	return clauses.join(' AND ');
}

function buildRelationExists(
	outer: Scope,
	relation: LocalRelationship,
	condition: unknown,
	build: Build
): string | null {
	if (typeof condition === 'boolean') {
		const exists = existsSubquery(outer, relation, build, () => '');
		return condition ? exists : `NOT ${exists}`;
	}
	let failed = false;
	const sql = existsSubquery(outer, relation, build, (inner) => {
		const clause = buildWhere(inner, condition, build);
		if (clause === null) {
			failed = true;
			return '';
		}
		return clause;
	});
	return failed ? null : sql;
}

/**
 * `EXISTS (SELECT 1 FROM target AS __rN WHERE __rN.key = outer.key AND (...))`.
 *
 * The alias is what makes this safe: without it a self-relation's inner table would shadow the
 * outer one and the correlation would silently compare a row to itself.
 */
function existsSubquery(
	outer: Scope,
	relation: LocalRelationship,
	build: Build,
	inner: (scope: Scope) => string
): string {
	build.aliases += 1;
	const scope: Scope = { collection: relation.target, alias: `"__r${build.aliases}"` };
	const clause = inner(scope);
	const correlation = `${column(scope, relation.targetField)} = ${column(outer, relation.localField)}`;
	return `EXISTS (SELECT 1 FROM ${ident(relation.target)} AS ${scope.alias} WHERE ${correlation}${clause ? ` AND (${clause})` : ''})`;
}

function buildCondition(
	scope: Scope,
	field: string,
	condition: unknown,
	build: Build
): string | null {
	if (condition === null) return `${column(scope, field)} IS NULL`;
	if (typeof condition !== 'object') {
		if (!validTemporalOperand(scope.collection, field, condition)) return null;
		build.params.push(condition);
		return `${column(scope, field)} = $${build.params.length}`;
	}
	if (Array.isArray(condition)) return null;

	const clauses: string[] = [];
	for (const [op, value] of Object.entries(condition as Record<string, unknown>)) {
		const clause = buildOperator(scope, field, op, value, build);
		if (clause === null) return null;
		clauses.push(clause);
	}
	return clauses.length ? clauses.join(' AND ') : null;
}

/** One operator predicate, covering the vocabulary the collection table emits. */
function buildOperator(
	scope: Scope,
	field: string,
	op: string,
	value: unknown,
	build: Build
): string | null {
	if (!isIdent(field)) return null;
	const col = column(scope, field);
	const params = build.params;

	if (op === 'isNull') return value === false ? `${col} IS NOT NULL` : `${col} IS NULL`;
	if (op === 'isNotNull') return value === false ? `${col} IS NULL` : `${col} IS NOT NULL`;
	if (!validTemporalOperand(scope.collection, field, value)) return null;

	if (op === 'in' || op === 'notIn') {
		if (!Array.isArray(value)) return null;
		if (value.length === 0) return op === 'in' ? 'false' : 'true';
		params.push(value);
		return `${col} ${op === 'notIn' ? '<> ALL' : '= ANY'}($${params.length})`;
	}

	if (op === 'arrayContains') {
		params.push(Array.isArray(value) ? value : [value]);
		return `${col} @> $${params.length}`;
	}
	if (op === 'arrayOverlaps') {
		params.push(Array.isArray(value) ? value : [value]);
		return `${col} && $${params.length}`;
	}

	if (op === 'contains') {
		// On text this is a substring match; on json it is containment. The column type is not
		// known here, so pick the form that is valid for the operand that was supplied.
		if (typeof value === 'string') {
			params.push(`%${escapeLikePattern(value)}%`);
			return `${col}::text ILIKE $${params.length}`;
		}
		params.push(JSON.stringify(value));
		return `${col}::jsonb @> $${params.length}::jsonb`;
	}

	if (op === 'contains_date') {
		if (typeof value !== 'string' || !isUtcIsoInstant(value)) return null;
		params.push(value);
		const ref = `$${params.length}::timestamptz`;
		return `((${col}->>'start')::timestamptz <= ${ref} AND (${col}->>'end')::timestamptz >= ${ref})`;
	}
	if (op === 'overlaps') {
		const range = value as { start?: unknown; end?: unknown } | null;
		if (
			!range ||
			typeof range.start !== 'string' ||
			typeof range.end !== 'string' ||
			!isUtcIsoInstant(range.start) ||
			!isUtcIsoInstant(range.end)
		) {
			return null;
		}
		params.push(range.end);
		const end = `$${params.length}::timestamptz`;
		params.push(range.start);
		const start = `$${params.length}::timestamptz`;
		return `((${col}->>'start')::timestamptz <= ${end} AND ${start} <= (${col}->>'end')::timestamptz)`;
	}

	const sqlOp = OPERATORS[op];
	if (!sqlOp) return null;
	params.push(value);
	return `${col} ${sqlOp} $${params.length}`;
}

function validTemporalOperand(collection: string, field: string, operand: unknown): boolean {
	const fieldKind = localCollection(collection)?.fieldKinds[field];
	if (!fieldKind) return true;
	const temporalKind = temporalKindForFieldKind(fieldKind);
	return temporalKind ? isTemporalOperand(temporalKind, operand) : true;
}

// ── interactive filters ────────────────────────────────────────────────────────

type LocalFilter = { path: string[]; operator: string; operand: unknown };

export function readFilters(filters: unknown): LocalFilter[] {
	if (!Array.isArray(filters)) return [];
	return filters.flatMap((entry) => {
		if (!entry || typeof entry !== 'object') return [];
		const { path, operator, operand } = entry as Record<string, unknown>;
		if (!Array.isArray(path) || path.length === 0 || typeof operator !== 'string') return [];
		if (!path.every((segment): segment is string => typeof segment === 'string')) return [];
		return [{ path, operator, operand }];
	});
}

function buildFilter(scope: Scope, filter: LocalFilter, build: Build): string | null {
	const [first, second] = filter.path;
	if (!first) return null;

	if (second) {
		const relation = localRelationship(scope.collection, first);
		if (!relation) return null;
		let failed = false;
		const sql = existsSubquery(scope, relation, build, (inner) => {
			const clause = buildOperator(inner, second, filter.operator, filter.operand, build);
			if (clause === null) {
				failed = true;
				return '';
			}
			return clause;
		});
		return failed ? null : sql;
	}

	return buildOperator(scope, first, filter.operator, filter.operand, build);
}

// ── search ─────────────────────────────────────────────────────────────────────

/** Direct (single-valued) relations whose text the server folds into a search. */
export function searchRelations(collection: string): LocalRelationship[] {
	return (localCollection(collection)?.relationships ?? []).filter(
		(relation) => relation.cardinality === 'one'
	);
}

/**
 * Local search over the collection's own text fields plus the text of its directly related
 * records, matching the server's field selection.
 *
 * Search is case-insensitive literal substring matching on both client and server. Keeping one
 * definition is a correctness requirement: a collection must not change results merely because
 * it crossed the residency budget and moved from local execution to the server.
 */
function buildSearch(scope: Scope, search: string, build: Build): string | null {
	const pattern = `%${escapeLikePattern(search)}%`;
	const clauses: string[] = [];

	const own = localCollection(scope.collection);
	if (!own) return null;
	for (const field of own.searchFields) {
		build.params.push(pattern);
		clauses.push(`${column(scope, field)}::text ILIKE $${build.params.length}`);
	}

	for (const relation of searchRelations(scope.collection)) {
		const target = localCollection(relation.target);
		if (!target || target.searchFields.length === 0) continue;
		clauses.push(
			existsSubquery(scope, relation, build, (inner) =>
				target.searchFields
					.map((field) => {
						build.params.push(pattern);
						return `${column(inner, field)}::text ILIKE $${build.params.length}`;
					})
					.join(' OR ')
			)
		);
	}

	if (clauses.length === 0) return 'false';
	return `(${clauses.join(' OR ')})`;
}

function escapeLikePattern(value: string): string {
	return value.replace(/([\\%_])/g, '\\$1');
}

// ── ordering + keyset pagination ───────────────────────────────────────────────

export function buildOrderBy(orderBy: unknown): string | null {
	if (orderBy == null) return '';
	if (typeof orderBy !== 'object' || Array.isArray(orderBy)) return null;
	const parts: string[] = [];
	for (const [field, dir] of Object.entries(orderBy as Record<string, unknown>)) {
		if (!isIdent(field)) return null;
		parts.push(`${ident(field)} ${dir === 'desc' ? 'DESC' : 'ASC'}`);
	}
	return parts.length ? ` ORDER BY ${parts.join(', ')}` : '';
}

type OrderEntry = { field: string; direction: 'asc' | 'desc'; value: unknown };

/** Mirrors the server's `normalizeCursorOrder`, which appends `norbital_id ASC` as a tiebreaker. */
export function normalizeOrder(orderBy: unknown): Record<string, 'asc' | 'desc'> {
	const entries: Record<string, 'asc' | 'desc'> = {};
	if (orderBy && typeof orderBy === 'object' && !Array.isArray(orderBy)) {
		for (const [field, dir] of Object.entries(orderBy as Record<string, unknown>)) {
			if (dir === 'asc' || dir === 'desc') entries[field] = dir;
		}
	}
	if (!(PKEY in entries)) entries[PKEY] = 'asc';
	return entries;
}

function buildKeysetWhere(after: unknown, orderBy: unknown, params: unknown[]): string | null {
	if (after == null || typeof after !== 'string') return '';

	const order = normalizeOrder(orderBy);
	let cursorEntries: OrderEntry[];
	try {
		const raw = JSON.parse(decodeBase64Url(after));
		if (!raw || raw.v !== 1 || !Array.isArray(raw.order)) return null;
		cursorEntries = raw.order as OrderEntry[];
	} catch {
		return null;
	}

	const expected = Object.entries(order);
	if (
		cursorEntries.length !== expected.length ||
		cursorEntries.some(
			(entry, i) => entry.field !== expected[i]?.[0] || entry.direction !== expected[i]?.[1]
		)
	) {
		return null;
	}

	const branches: string[] = [];
	for (let i = 0; i < cursorEntries.length; i++) {
		const entry = cursorEntries[i]!;
		const prefixClauses: string[] = [];
		for (let j = 0; j < i; j++) {
			const prior = cursorEntries[j]!;
			params.push(prior.value);
			prefixClauses.push(`${ident(prior.field)} = $${params.length}`);
		}
		params.push(entry.value);
		const valueRef = `$${params.length}`;

		if (entry.direction === 'asc') {
			if (entry.value === null) continue;
			branches.push(`(${[...prefixClauses, `${ident(entry.field)} > ${valueRef}`].join(' AND ')})`);
		} else if (entry.value === null) {
			branches.push(`(${[...prefixClauses, `${ident(entry.field)} IS NOT NULL`].join(' AND ')})`);
		} else {
			branches.push(`(${[...prefixClauses, `${ident(entry.field)} < ${valueRef}`].join(' AND ')})`);
		}
	}

	return branches.length ? `(${branches.join(' OR ')})` : '';
}

export function encodeLocalCursor(
	row: Record<string, unknown>,
	orderBy: Record<string, 'asc' | 'desc'>
): string {
	const order = Object.entries(orderBy).map(([field, direction]) => ({
		field,
		direction,
		value: row[field] ?? null
	}));
	return encodeBase64Url(JSON.stringify({ v: 1, order }));
}

// ── identifier helpers ─────────────────────────────────────────────────────────

export function isIdent(value: string): boolean {
	return /^[a-z_][a-z0-9_]*$/i.test(value);
}

export function ident(value: string): string {
	if (!isIdent(value)) throw new Error(`Unsafe SQL identifier: ${value}`);
	return `"${value}"`;
}

/** Whether this query carries a non-empty search term. */
export function hasSearch(query: Record<string, unknown>): boolean {
	return typeof query.search === 'string' && query.search.trim().length > 0;
}

/** Every collection name the published schema knows about. */
export function localSchemaCollections(): Iterable<string> {
	return schema.keys();
}

/**
 * Forget the published schema.
 *
 * Called when leaving a tenant: the schema describes that workspace's columns and relationships,
 * and left in place the next tenant's first reads would compile against it.
 */
export function clearLocalSchema(): void {
	schema = new Map();
}
