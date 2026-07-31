import type { PodSyncClient } from './pod-sync-client.js';
import { SubscriptionRegistry } from './subscription-registry.js';
import type { MutationResult, WireMutation } from './types.js';
import {
	buildOrderBy,
	clearLocalSchema,
	buildSelect,
	buildWhere,
	buildWhereClause,
	column,
	encodeLocalCursor,
	hasSearch,
	ident,
	localCollection,
	localRelationship,
	localSchemaCollections,
	normalizeOrder,
	readFilters,
	searchRelations,
	setLocalSchema,
	type Build,
	type LocalCollectionSchema,
	type LocalRelationship,
	type Scope
} from './local-sql.js';

export { setLocalSchema, type LocalCollectionSchema, type LocalRelationship };

const PKEY = 'norbital_id';

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
	for (const collection of localSchemaCollections()) {
		if (sync.registry.hasSynced(collection)) continue;
		await sync.registry.register(collection).catch(() => undefined);
	}
}

export function disableClientSync(): void {
	active = undefined;
	// The schema describes the tenant we are leaving. Left in place, the next tenant's first reads
	// would compile against another workspace's columns and relationships.
	clearLocalSchema();
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

/**
 * Replace one cached record with an authoritative point read, or evict it when that read says the
 * record is gone/outside policy. This is the bounded fallback for a command receipt whose outbox
 * watermark could not be observed in time; ordinary convergence continues to use the feed.
 */
export async function reconcileServerRow(
	sync: ClientSync,
	collection: string,
	id: string,
	row: Record<string, unknown> | null
): Promise<void> {
	if (row) await absorbServerRows(sync, collection, [row]);
	else await sync.client.deleteRow(collection, id);
	sync.client.notifyCollection(collection);
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
	return [...needed].every((name) => sync.registry.has(name) && sync.registry.isFresh(name));
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
