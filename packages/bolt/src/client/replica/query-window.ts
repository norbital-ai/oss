import { Effect, Result, Schema } from 'effect';
import type {
	CollectionCountWindow,
	CollectionGroupedWindow,
	CollectionHydrationRow,
	CollectionQueryPage,
	CollectionQueryReproducibility,
	CollectionRelationshipMembership,
	StoredRecord
} from '@norbital-ai/bolt-protocol';
import {
	canonicalQueryJson,
	canonicalizeCollectionQuery,
	collectionQueryKey,
	type CanonicalCollectionQueryResult,
	type CollectionQueryIdentity,
	type CollectionQueryKind,
	type CollectionQueryMetadata
} from '#lib/runtime/collections/canonical-query.js';
import { SYSTEM_COLUMN_NAMES } from '#lib/authoring/system-row-model.js';

/** The relation-bearing subset of the generated catalog needed to canonicalize browser queries. */
export type QueryWindowCatalog = Readonly<
	Record<
		string,
		Readonly<{
			readonly fields: ReadonlyArray<
				Readonly<{
					readonly name: string;
					readonly kind: string;
					readonly relation?: Readonly<{ readonly targets: ReadonlyArray<string> }>;
				}>
			>;
			readonly relationships?: ReadonlyArray<
				Readonly<{ readonly name: string; readonly target: string }>
			>;
		}>
	>
>;

const catalogMetadata = (catalog: QueryWindowCatalog): CollectionQueryMetadata => {
	const systemKinds: Readonly<Record<string, string>> = {
		id: 'uuid',
		created_at: 'instant',
		updated_at: 'instant',
		row_version: 'number',
		approval_id: 'uuid',
		sys_period: 'json'
	};
	return {
		hasField: (collection, field) =>
			SYSTEM_COLUMN_NAMES.includes(field) ||
			(catalog[collection]?.fields.some(({ name }) => name === field) ?? false),
		fieldKind: (collection, field) =>
			catalog[collection]?.fields.find(({ name }) => name === field)?.kind ?? systemKinds[field],
		relationTargets: (collection, relation) => {
			const fieldTargets =
				catalog[collection]?.fields.find(({ name }) => name === relation)?.relation?.targets ?? [];
			return [
				...new Set([
					...(catalog[collection]?.relationships ?? [])
						.filter(({ name }) => name === relation)
						.map(({ target }) => target),
					...fieldTargets
				])
			].toSorted();
		}
	};
};

export type ClientQueryWindowDescription = CanonicalCollectionQueryResult &
	Readonly<{ readonly queryKey: string }>;

/** Canonicalizes and hashes the identity-bearing query once for the browser registry. */
export const describeClientQueryWindow = (
	kind: CollectionQueryKind,
	input: Readonly<Record<string, unknown>>,
	catalog: QueryWindowCatalog,
	identity: CollectionQueryIdentity,
	options: Readonly<{
		readonly pinnedCollation?: boolean;
		readonly localRelationships?: boolean;
		readonly localSearch?: boolean;
	}> = {}
): Effect.Effect<ClientQueryWindowDescription | undefined, Error> => {
	const described = canonicalizeCollectionQuery(kind, input, catalogMetadata(catalog), options);
	if (described === undefined) return Effect.succeed(undefined);
	return collectionQueryKey(identity, described.query).pipe(
		Effect.map((queryKey) => ({ ...described, queryKey }))
	);
};

export type ConfirmedQueryWindow = Readonly<{
	readonly partitionKey: string;
	readonly dependencies: ReadonlyArray<string>;
	readonly dependencyGenerations: Readonly<Record<string, number>>;
	readonly reproducibility: CollectionQueryReproducibility;
}>;

/**
 * Makes the server's dependency confirmation load-bearing.
 *
 * The server may conservatively add dependencies (for policy-link generations), but it may not omit
 * one derived from the canonical AST. Generation keys must be exactly the confirmed set so a proof
 * can never look current merely because one dependency had no stored generation.
 */
type CollectionQueryProof = Readonly<{
	readonly readCursor: CollectionQueryPage['readCursor'];
	readonly partitionKey: string;
	readonly confirmedDependencies: ReadonlyArray<string>;
	readonly dependencyGenerations: Readonly<Record<string, number>>;
	readonly reproducibility: CollectionQueryReproducibility;
}>;

const confirmCollectionQueryProof = (
	derived: CanonicalCollectionQueryResult,
	proof: CollectionQueryProof
): Result.Result<ConfirmedQueryWindow, Error> => {
	const confirmed = new Set(proof.confirmedDependencies);
	if (confirmed.size !== proof.confirmedDependencies.length) {
		return Result.fail(new Error('The query server confirmed one dependency more than once.'));
	}
	for (const dependency of derived.dependencies) {
		if (!confirmed.has(dependency)) {
			return Result.fail(
				new Error(`The query server omitted canonical dependency ${dependency}.`)
			);
		}
	}
	const generationKeys = Object.keys(proof.dependencyGenerations).toSorted();
	const dependencies = [...confirmed].toSorted();
	if (
		generationKeys.length !== dependencies.length ||
		generationKeys.some((dependency, index) => dependency !== dependencies[index])
	) {
		return Result.fail(
			new Error('The query response generations do not exactly cover its confirmed dependencies.')
		);
	}
	if (
		derived.reproducibility._tag === 'LocalExact' &&
		proof.reproducibility._tag === 'LocalExact' &&
		canonicalQueryJson(derived.reproducibility.semantics) !==
			canonicalQueryJson(proof.reproducibility.semantics)
	) {
		return Result.fail(
			new Error('The query server and local evaluator reported different exact semantics.')
		);
	}
	return Result.succeed({
		partitionKey: proof.partitionKey,
		dependencies,
		dependencyGenerations: proof.dependencyGenerations,
		// Local exactness is a conjunction. Either evaluator declining it makes the window server-proof.
		reproducibility:
			derived.reproducibility._tag === 'ServerProof'
				? derived.reproducibility
				: proof.reproducibility
	});
};

export const confirmCollectionQueryPage = (
	derived: CanonicalCollectionQueryResult,
	page: CollectionQueryPage
): Result.Result<ConfirmedQueryWindow, Error> => {
	if (page.lookahead > page.rows.length) {
		return Result.fail(new Error('The query response lookahead exceeds its returned row count.'));
	}
	const hydration = confirmCollectionHydration(
		derived.query.collection,
		page.rows,
		page.baseRows,
		page.relationshipRefs
	);
	return Result.isFailure(hydration)
		? Result.fail(hydration.failure)
		: confirmCollectionQueryProof(derived, page);
};

export const confirmCollectionCountWindow = (
	derived: CanonicalCollectionQueryResult,
	window: CollectionCountWindow
): Result.Result<ConfirmedQueryWindow, Error> =>
	derived.query.kind !== 'count'
		? Result.fail(new Error('A count proof cannot be installed under another query kind.'))
		: confirmCollectionQueryProof(derived, window);

export const confirmCollectionGroupedWindow = (
	derived: CanonicalCollectionQueryResult,
	window: CollectionGroupedWindow
): Result.Result<ConfirmedQueryWindow, Error> => {
	if (derived.query.kind !== 'findGrouped') {
		return Result.fail(new Error('A grouped proof cannot be installed under another query kind.'));
	}
	const hydration = confirmCollectionHydration(
		derived.query.collection,
		Object.values(window.groups).flat(),
		window.baseRows,
		window.relationshipRefs
	);
	return Result.isFailure(hydration)
		? Result.fail(hydration.failure)
		: confirmCollectionQueryProof(derived, window);
};

const rowId = (row: Readonly<Record<string, Schema.Json>>): string | undefined => {
	const id = row['id'];
	return typeof id === 'string' && id.length > 0 ? id : undefined;
};

const baseRowKey = (collection: string, recordId: string): string =>
	`${collection}\u0000${recordId}`;

const relationshipKey = (relationship: CollectionRelationshipMembership): string =>
	`${relationship.sourceCollection}\u0000${relationship.sourceRecordId}\u0000${relationship.relation}\u0000${relationship.targetCollection}\u0000${relationship.targetRecordId}`;

function confirmCollectionHydration(
	rootCollection: string,
	rows: ReadonlyArray<StoredRecord>,
	base: ReadonlyArray<CollectionHydrationRow>,
	references: ReadonlyArray<CollectionRelationshipMembership>
): Result.Result<void, Error> {
	const baseRows = new Map<string, CollectionHydrationRow>();
	for (const row of base) {
		const key = baseRowKey(row.collection, row.recordId);
		if (baseRows.has(key)) {
			return Result.fail(
				new Error(`The query response repeated base row ${row.collection} ${row.recordId}.`)
			);
		}
		baseRows.set(key, row);
	}

	const rootMembership = new Set<string>();
	for (const row of rows) {
		const recordId = rowId(row);
		if (recordId === undefined) {
			return Result.fail(new Error(`Authoritative ${rootCollection} page row is missing id.`));
		}
		if (rootMembership.has(recordId)) {
			return Result.fail(
				new Error(`The query response repeated root row ${rootCollection} ${recordId}.`)
			);
		}
		rootMembership.add(recordId);
		const base = baseRows.get(baseRowKey(rootCollection, recordId));
		if (base === undefined || base.rowVersion !== row['row_version']) {
			return Result.fail(
				new Error(
					`Authoritative ${rootCollection} page row ${recordId} has no matching versioned base row.`
				)
			);
		}
	}

	const relationships = new Set<string>();
	for (const relationship of references) {
		const key = relationshipKey(relationship);
		if (relationships.has(key)) {
			return Result.fail(new Error('The query response repeated one relationship membership.'));
		}
		relationships.add(key);
		if (
			!baseRows.has(
				baseRowKey(relationship.sourceCollection, relationship.sourceRecordId)
			) ||
			!baseRows.has(
				baseRowKey(relationship.targetCollection, relationship.targetRecordId)
			)
		) {
			return Result.fail(
				new Error('The query response contains a relationship with a missing base-row endpoint.')
			);
		}
	}
	return Result.succeed(undefined);
}

export type AuthoritativeCollectionBaseRow = Readonly<{
	readonly collection: string;
	readonly recordId: string;
	readonly rowVersion: number;
	readonly row: Readonly<Record<string, Schema.Json>>;
}>;

/**
 * Converts a proven page into version-gated O3 base rows.
 *
 * Missing identity/version is a malformed authoritative response, never a row to skip: silently
 * omitting it would let the window membership point at data the base store cannot version-gate.
 */
export const authoritativeBaseRowsFromPage = (
	collection: string,
	page: CollectionQueryPage
): Result.Result<ReadonlyArray<AuthoritativeCollectionBaseRow>, Error> => {
	const confirmed = confirmCollectionHydration(
		collection,
		page.rows,
		page.baseRows,
		page.relationshipRefs
	);
	return Result.isFailure(confirmed)
		? Result.fail(confirmed.failure)
		: Result.succeed(page.baseRows);
};

export const authoritativeBaseRowsFromGroupedWindow = (
	collection: string,
	window: CollectionGroupedWindow
): Result.Result<ReadonlyArray<AuthoritativeCollectionBaseRow>, Error> => {
	const confirmed = confirmCollectionHydration(
		collection,
		Object.values(window.groups).flat(),
		window.baseRows,
		window.relationshipRefs
	);
	return Result.isFailure(confirmed)
		? Result.fail(confirmed.failure)
		: Result.succeed(window.baseRows);
};

/** Durable grouped results store ordered root identities, never a second copy of row payloads. */
export const groupedRowIdsFromWindow = (
	window: CollectionGroupedWindow
): Result.Result<Readonly<Record<string, ReadonlyArray<string>>>, Error> => {
	const grouped: Record<string, ReadonlyArray<string>> = {};
	for (const [lane, rows] of Object.entries(window.groups)) {
		const ids: Array<string> = [];
		for (const row of rows) {
			const id = rowId(row);
			if (id === undefined) {
				return Result.fail(new Error(`Authoritative grouped lane ${lane} contains a row without id.`));
			}
			ids.push(id);
		}
		grouped[lane] = ids;
	}
	return Result.succeed(grouped);
};
