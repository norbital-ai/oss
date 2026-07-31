import type { PodSyncClient } from './pod-sync-client.js';
import { SubscriptionRegistry } from './subscription-registry.js';
import { decodeBase64Url, encodeBase64Url } from './base64url.js';
import type { MutationResult, WireMutation } from './types.js';
import {
	isTemporalOperand,
	isUtcIsoInstant,
	temporalKindForFieldKind
} from '@norbital-ai/std/date';

const PKEY = 'norbital_id';

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

function localCollection(collection: string): LocalCollectionSchema | undefined {
	return schema.get(collection);
}

function localRelationship(collection: string, relation: string): LocalRelationship | undefined {
	return schema.get(collection)?.relationships.find((entry) => entry.name === relation);
}


/**
 * The client-sync layer: reads resolve from the local PGlite replica, writes route through the
 * authoritative `/_runtime/sync/mutate` endpoint.
 *
 * The sync unit is the collection (README §3.1), but a collection is only *resident* — fully
 * local — when its policy-scoped row count fits the residency cap. Large collections are
 * *windowed*: the replica holds the working set and reads that provably fall inside it are local,
 * while reads reaching past it return `null` so the caller asks the server. Server answers are
 * folded back into the replica, so a windowed collection converges on local as it is used.
 *
 * A `null` return therefore means "this specific read reaches past what is local", not "local
 * reads are unsupported".
 */
export type ClientSync = {
	readonly client: PodSyncClient;
	readonly registry: SubscriptionRegistry;
};

let active: ClientSync | undefined;
let invalidateAll: (collection: string) => void = () => {};

export function setSyncInvalidator(fn: (collection: string) => void): void {
	invalidateAll = fn;
}

export function enableClientSync(
	client: PodSyncClient,
	options?: { readonly residencyBytes?: number }
): ClientSync {
	if (active) return active;
	const registry = new SubscriptionRegistry(client, options);
	// Nothing special for approvals any more. Records whose visibility changes without themselves
	// being written are announced on the feed by the server (`announceVisibilityChange`), so they
	// arrive as ordinary diffs — `insert` for a client that can now see them, `leave` for one that
	// cannot. This used to trigger a re-read of every collection the replica held, then of the
	// related ones; both were scans standing in for a delta the server is better placed to emit.
	client.onChange((collection) => invalidateAll(collection));
	active = { client, registry };
	return active;
}

export function getClientSync(): ClientSync | undefined {
	return active;
}

/**
 * Pull every collection the workspace declares into the replica, in the background.
 *
 * Without this the replica only holds what has been looked at: the first visit to any page pays a
 * catch-up for its collections, so "slow the first time" repeats once per page rather than once
 * per device. Warming everything up front turns that into a single cost paid while the user is
 * reading the page they already opened.
 *
 * Sequential, and started only after the foreground has had its turn. The collections a page is
 * waiting on go through `ensureCollections`, which shares the same in-flight map — a warm pass
 * running concurrently would put 40 catch-ups on the wire ahead of the one blocking first paint,
 * and the residency budget would then be spent in arrival order rather than on what is used.
 */
export async function warmAllCollections(sync: ClientSync): Promise<void> {
	for (const collection of schema.keys()) {
		if (sync.registry.hasSynced(collection)) continue;
		await sync.registry.register(collection).catch(() => undefined);
	}
}

export function disableClientSync(): void {
	active = undefined;
}

export type LocalPage = { rows: Record<string, unknown>[]; nextCursor: string | null };

// ── read entry points ──────────────────────────────────────────────────────────
//
// `columns` is deliberately not honoured locally. It exists to keep rows off the wire, and there
// is no wire here — the replica already holds the complete row, policy-filtered, so projecting it
// away would hide nothing and cost a pass over every result. Callers read named fields.

export async function localFindMany(
	sync: ClientSync,
	collection: string,
	query: Record<string, unknown>
): Promise<LocalPage | null> {
	if (!(await ensureCollections(sync, collection, query))) return null;
	// Search over a windowed collection would silently miss matches outside the window; the
	// server owns it (and has the trigram indexes for it).
	if (hasSearch(query) && !sync.registry.isResident(collection)) return null;

	const limit = typeof query.limit === 'number' ? query.limit : null;
	// Over-fetch by one, exactly like the server's findManyPage. Without the probe row a page that
	// happens to land on a multiple of the page size looks full, and the UI offers a next page
	// that turns out to be empty.
	const built = buildSelect(collection, limit === null ? query : { ...query, limit: limit + 1 });
	if (!built) return null;

	const fetched = await sync.client.queryLocal<Record<string, unknown>>(built.sql, built.params);
	const hasMore = limit !== null && fetched.length > limit;
	const rows = hasMore ? fetched.slice(0, limit) : fetched;

	const hydrated = await hydrateRelations(sync, collection, rows, query.with);
	if (hydrated === null) return null;

	// One rule decides whether this answer may be served: can the replica PROVE it is the same
	// answer the server would give? Anything less is a partial result presented as a complete one,
	// which is worse than a round trip — the user cannot tell that rows are missing.
	//
	// Exactly two things constitute proof.
	//
	// 1. The collection is resident: every policy-visible row is local, so any filter, sort or page
	//    over it is computed on the same data the server holds.
	//
	// 2. The query pins primary keys and all of them resolved. `norbital_id` is unique, so a full
	//    set of hits IS the complete answer however much else is missing. This is the common read —
	//    opening a record, filling a relationship cell — and keeping it local is why a windowed
	//    collection still feels instant.
	//
	// Note what is deliberately NOT proof: a page that came back full. It is tempting, because a
	// full page looks like a complete page, but on a partially-synced collection a matching row
	// that sorts earlier may simply not have arrived yet — and the user would be shown page 1 of a
	// filter with rows silently absent from it. Search is refused earlier for the same reason.
	if (sync.registry.isResident(collection)) {
		if (hasMore) {
			const cursor = encodeLocalCursor(rows[rows.length - 1]!, normalizeOrder(query.orderBy));
			return { rows: hydrated, nextCursor: cursor };
		}
		return { rows: hydrated, nextCursor: null };
	}

	const pinned = pinnedKeyCount(query.where);
	if (pinned !== null && rows.length === pinned) return { rows: hydrated, nextCursor: null };

	// Not provable. The server answers, and the query reports itself as loading until it does —
	// which is the honest state, and the one the loader is for.
	return null;
}

/**
 * How many distinct `norbital_id` values the filter pins, or null if it doesn't pin any. Only a
 * bare equality or `in` on the primary key counts — anything else could match rows beyond the
 * window.
 */
function pinnedKeyCount(where: unknown): number | null {
	if (!where || typeof where !== 'object' || Array.isArray(where)) return null;
	const condition = (where as Record<string, unknown>)[PKEY];
	if (condition === undefined) return null;
	if (typeof condition === 'string') return 1;
	if (!condition || typeof condition !== 'object' || Array.isArray(condition)) return null;
	const entries = Object.entries(condition as Record<string, unknown>);
	if (entries.length !== 1) return null;
	const [operator, value] = entries[0]!;
	if (operator === 'eq' && typeof value === 'string') return 1;
	if (operator === 'in' && Array.isArray(value)) return new Set(value).size;
	return null;
}

export async function localFindFirst(
	sync: ClientSync,
	collection: string,
	query: Record<string, unknown>
): Promise<Record<string, unknown> | null | undefined> {
	if (query.after != null) return undefined;
	if (!(await ensureCollections(sync, collection, query))) return undefined;
	if (hasSearch(query) && !sync.registry.isResident(collection)) return undefined;

	const built = buildSelect(collection, { ...query, limit: 1 });
	if (!built) return undefined;
	const rows = await sync.client.queryLocal<Record<string, unknown>>(built.sql, built.params);
	const hydrated = await hydrateRelations(sync, collection, rows, query.with);
	if (hydrated === null) return undefined;
	// A miss is not proof of absence while the collection is windowed (the row may lie beyond the
	// window) or still catching up (it may not have arrived). A hit is always trustworthy: the
	// replica only ever holds real, policy-scoped rows.
	if (
		hydrated.length === 0 &&
		(!sync.registry.isResident(collection) || !sync.registry.hasSynced(collection))
	) {
		return undefined;
	}
	return hydrated[0] ?? null;
}

export async function localCount(
	sync: ClientSync,
	collection: string,
	query: Record<string, unknown>
): Promise<number | null> {
	// A count over a window is a wrong answer, not a stale one — and so is a count taken before the
	// collection finished arriving.
	if (!(await ensureCollections(sync, collection, query))) return null;
	if (!sync.registry.isResident(collection) || !sync.registry.hasSynced(collection)) return null;

	const where = buildWhereClause(collection, query);
	if (where === null) return null;
	const rows = await sync.client.queryLocal<{ n: string }>(
		`SELECT count(*)::text AS n FROM ${ident(collection)}${where.sql}`,
		where.params
	);
	return Number(rows[0]?.n ?? 0);
}

export async function syncMutate(
	sync: ClientSync,
	mutations: readonly WireMutation[]
): Promise<MutationResult[]> {
	return sync.client.mutate(mutations);
}

/**
 * Fold a server answer into the replica. Every fallback response is data this device has now
 * seen, so caching it means a windowed collection converges on local with use instead of paying
 * the same round-trip again. Rows arriving this way are kept fresh by the stream like any other.
 */
export async function absorbServerRows(
	sync: ClientSync,
	collection: string,
	rows: readonly unknown[]
): Promise<void> {
	const records = rows.filter(
		(row): row is Record<string, unknown> =>
			!!row && typeof row === 'object' && typeof (row as Record<string, unknown>)[PKEY] === 'string'
	);
	if (records.length === 0) return;
	// Relation payloads from `with` are nested objects, not columns of this table — strip them so
	// the upsert only names real columns. Without a published schema we cannot tell columns from
	// relations, and guessing would push a malformed INSERT at the replica; skip instead.
	const columns = new Set(localCollection(collection)?.columns ?? []);
	if (columns.size === 0) return;
	const flat = records.map((row) =>
		Object.fromEntries(Object.entries(row).filter(([key]) => columns.has(key)))
	);
	await sync.client.upsertRows(collection, flat).catch(() => undefined);
}

function hasSearch(query: Record<string, unknown>): boolean {
	return typeof query.search === 'string' && query.search.trim().length > 0;
}

// ── collection readiness ───────────────────────────────────────────────────────

/**
 * Make sure the base collection and every collection the query reaches into — relations in
 * `with`, relation-path filters, and search across direct relations — are registered before
 * compiling SQL.
 *
 * Registration resolves on the first page, so this is one round-trip the first time a collection
 * is touched and zero after that, including across reloads (the registry restores persisted
 * state at boot).
 */
async function ensureCollections(
	sync: ClientSync,
	collection: string,
	query: Record<string, unknown>
): Promise<boolean> {
	const needed = new Set<string>([collection]);

	if (query.with && typeof query.with === 'object' && !Array.isArray(query.with)) {
		for (const relation of Object.keys(query.with as Record<string, unknown>)) {
			const rel = localRelationship(collection, relation);
			if (!rel) return false;
			needed.add(rel.target);
		}
	}
	for (const filter of readFilters(query.filters)) {
		if (filter.path.length < 2) continue;
		const rel = localRelationship(collection, filter.path[0]!);
		if (!rel) return false;
		needed.add(rel.target);
	}
	if (hasSearch(query)) {
		for (const rel of searchRelations(collection)) needed.add(rel.target);
	}

	await sync.registry.restore();
	await Promise.all([...needed].map((name) => sync.registry.register(name)));
	return [...needed].every((name) => sync.registry.has(name));
}

// ── SQL construction ───────────────────────────────────────────────────────────

type Built = { sql: string; params: unknown[] };

/**
 * A name scope. `alias` is how columns of `collection` are addressed in the SQL being built.
 * Every column reference is qualified with it so a correlated EXISTS can name an outer column
 * without the inner table shadowing it — which is not hypothetical: a self-relation puts the same
 * table on both sides.
 */
type Scope = { readonly collection: string; readonly alias: string };

/** Mutable compile state: bound parameters and a counter for unique subquery aliases. */
type Build = { readonly params: unknown[]; aliases: number };

function column(scope: Scope, field: string): string {
	return `${scope.alias}.${ident(field)}`;
}

function buildSelect(collection: string, query: Record<string, unknown>): Built | null {
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
function buildWhereClause(collection: string, query: Record<string, unknown>): Built | null {
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

function buildWhere(scope: Scope, where: unknown, build: Build): string | null {
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

function readFilters(filters: unknown): LocalFilter[] {
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
function searchRelations(collection: string): LocalRelationship[] {
	return (localCollection(collection)?.relationships ?? []).filter(
		(relation) => relation.cardinality === 'one'
	);
}

/**
 * Local search over the collection's own text fields plus the text of its directly related
 * records, matching the server's field selection.
 *
 * Divergence worth knowing: the server also does trigram (typo-tolerant) matching through
 * pg_trgm, which PGlite does not ship. Local search is substring-only, so for a *misspelled*
 * term it is a strict subset of the server's answer. That is why local search is only used for
 * resident collections — where a windowed collection is involved the server owns search outright.
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

// ── relation hydration ─────────────────────────────────────────────────────────

/**
 * Attach `with` relations by reading the related collections locally — one batched lookup per
 * relation, not one query per row. This is what replaces the per-cell request storm a table of
 * relationship columns used to produce.
 *
 * Returns null when a needed related row is missing from a windowed collection, so the caller
 * falls back to the server rather than rendering a hole.
 */
async function hydrateRelations(
	sync: ClientSync,
	collection: string,
	rows: Record<string, unknown>[],
	withClause: unknown
): Promise<Record<string, unknown>[] | null> {
	if (!withClause || typeof withClause !== 'object' || Array.isArray(withClause)) return rows;
	if (rows.length === 0) return rows;

	const hydrated = rows.map((row) => ({ ...row }));
	for (const [relationName, selection] of Object.entries(withClause as Record<string, unknown>)) {
		if (selection === false) continue;
		const relation = localRelationship(collection, relationName);
		if (!relation) return null;
		const attached = await attachRelation(sync, hydrated, relationName, relation, selection);
		if (!attached) return null;
	}
	return hydrated;
}

/** Load one relation for every row in the page and attach it. Mutates `rows`. */
async function attachRelation(
	sync: ClientSync,
	rows: Record<string, unknown>[],
	relationName: string,
	relation: LocalRelationship,
	selection: unknown
): Promise<boolean> {
	const nested =
		selection && typeof selection === 'object' ? (selection as Record<string, unknown>) : {};
	const empty = relation.cardinality === 'many' ? [] : null;

	const keys = [
		...new Set(
			rows
				.map((row) => row[relation.localField])
				.filter((value): value is string | number => value !== null && value !== undefined)
		)
	];
	if (keys.length === 0) {
		for (const row of rows) row[relationName] = empty;
		return true;
	}

	const related = await loadRelated(sync, relation, nested, keys);
	if (related === null) return false;
	if (!relatedIsComplete(sync, relation, related, keys.length)) return false;

	const deep = await hydrateRelations(sync, relation.target, related, nested.with);
	if (deep === null) return false;

	const byKey = new Map<string, Record<string, unknown>[]>();
	for (const record of deep) {
		const key = String(record[relation.targetField] ?? '');
		const bucket = byKey.get(key);
		if (bucket) bucket.push(record);
		else byKey.set(key, [record]);
	}

	const limit = typeof nested.limit === 'number' ? nested.limit : null;
	for (const row of rows) {
		const matches = byKey.get(String(row[relation.localField] ?? '')) ?? [];
		if (relation.cardinality !== 'many') row[relationName] = matches[0] ?? null;
		else row[relationName] = limit === null ? matches : matches.slice(0, limit);
	}
	return true;
}

/** The related rows for a set of join keys, or null when the query can't be compiled locally. */
async function loadRelated(
	sync: ClientSync,
	relation: LocalRelationship,
	nested: Record<string, unknown>,
	keys: readonly (string | number)[]
): Promise<Record<string, unknown>[] | null> {
	const build: Build = { params: [keys], aliases: 0 };
	const scope: Scope = { collection: relation.target, alias: ident(relation.target) };
	const conditions = [`${column(scope, relation.targetField)} = ANY($1)`];

	const nestedWhere = buildWhere(scope, nested.where, build);
	if (nestedWhere === null) return null;
	if (nestedWhere) conditions.push(nestedWhere);

	const order = buildOrderBy(nested.orderBy);
	if (order === null) return null;

	return sync.client.queryLocal<Record<string, unknown>>(
		`SELECT ${ident(relation.target)}.* FROM ${ident(relation.target)} WHERE ${conditions.join(' AND ')}${order}`,
		build.params
	);
}

/**
 * Whether what we found locally can be trusted as the whole answer. A resident target always can.
 * A windowed one can only satisfy a to-one whose every key resolved — a to-many can never be
 * proven complete from a window, and a missing to-one key means the row is out there but not here.
 */
function relatedIsComplete(
	sync: ClientSync,
	relation: LocalRelationship,
	related: readonly Record<string, unknown>[],
	keyCount: number
): boolean {
	if (sync.registry.isResident(relation.target)) return true;
	if (relation.cardinality === 'many') return false;
	const resolved = new Set(related.map((record) => String(record[relation.targetField])));
	return resolved.size >= keyCount;
}

// ── ordering + keyset pagination ───────────────────────────────────────────────

function buildOrderBy(orderBy: unknown): string | null {
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
function normalizeOrder(orderBy: unknown): Record<string, 'asc' | 'desc'> {
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

function encodeLocalCursor(
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

function isIdent(value: string): boolean {
	return /^[a-z_][a-z0-9_]*$/i.test(value);
}

function ident(value: string): string {
	if (!isIdent(value)) throw new Error(`Unsafe SQL identifier: ${value}`);
	return `"${value}"`;
}
