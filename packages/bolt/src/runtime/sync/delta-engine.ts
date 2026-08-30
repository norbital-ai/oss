import { Effect } from 'effect';
import {
	EffectId,
	MAX_SYNC_HELD_IDS,
	type StoredRecord,
	type SyncAdvanceSubscription,
	type SyncAdvanceUpdate,
	type SyncChange,
	type SyncHeldCoordinate,
	type SyncPatch,
	type SyncQueryInput
} from '@norbital-ai/bolt-protocol';
import * as Collections from '#lib/runtime/collections/collections.js';
import type { Subject } from '#lib/runtime/identity/identity.js';
import {
	contentDigest,
	contentDigestFromHeldCoordinates,
	heldCoordinatesOf,
	heldIdsOf
} from './digest.js';
import { describeSyncQuery, resolveSyncQuery } from './resolver.js';

type ResolvedSubscription = Readonly<{
	readonly state: SyncAdvanceSubscription;
	readonly subject: Subject;
}>;
type OrderTerm = Readonly<{ readonly column: string; readonly direction: 'asc' | 'desc' }>;
type Description = Effect.Success<ReturnType<typeof describeSyncQuery>>;
type PointResult = Readonly<
	| { readonly supported: false }
	| { readonly supported: true; readonly update?: SyncAdvanceUpdate | undefined }
>;

const jsonObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const orderTermsOf = (input: SyncQueryInput): ReadonlyArray<OrderTerm> => {
	const authored: ReadonlyArray<OrderTerm> = jsonObject(input.orderBy)
		? Object.entries(input.orderBy).flatMap(([column, direction]) =>
				direction === 'asc' || direction === 'desc'
					? [{ column, direction } satisfies OrderTerm]
					: []
			)
		: [];
	return authored.some(({ column }) => column === 'id')
		? authored
		: [...authored, { column: 'id', direction: 'asc' as const }];
};

const scalarOrderValue = (value: unknown): value is string | number | boolean =>
	['string', 'number', 'boolean'].includes(typeof value);

const andWhere = (...clauses: ReadonlyArray<unknown>): unknown => {
	const present = clauses.filter((clause) => clause !== undefined);
	if (present.length === 0) return undefined;
	if (present.length === 1) return present[0];
	return { AND: present };
};

/** A lexicographic predicate using the same total order as the authoritative read. */
const positionalWhere = (
	terms: ReadonlyArray<OrderTerm>,
	values: ReadonlyArray<unknown>,
	position: 'before' | 'after'
): unknown | undefined => {
	if (terms.length !== values.length || values.some((value) => !scalarOrderValue(value)))
		return undefined;
	return {
		OR: terms.map((term, index) => ({
			AND: [
				...terms
					.slice(0, index)
					.map((prior, priorIndex) => ({ [prior.column]: { eq: values[priorIndex] } })),
				{
					[term.column]: {
						[position === 'before'
							? term.direction === 'asc'
								? 'lt'
								: 'gt'
							: term.direction === 'asc'
								? 'gt'
								: 'lt']: values[index]
					}
				}
			]
		}))
	};
};

const coordinateOf = (
	row: StoredRecord,
	terms: ReadonlyArray<OrderTerm>
): SyncHeldCoordinate | undefined => {
	const id = row['id'];
	const version = row['row_version'];
	const order = terms.map(({ column }) => row[column]);
	if (
		typeof id !== 'string' ||
		id.length === 0 ||
		(typeof version !== 'number' && typeof version !== 'string') ||
		order.some((value) => value === undefined || !scalarOrderValue(value))
	)
		return undefined;
	return { id, rowVersion: version, order: order as SyncHeldCoordinate['order'] };
};

const queryOptions = (input: SyncQueryInput): Collections.QueryInput => ({
	collection: input.collection,
	...(input.where === undefined ? {} : { where: input.where }),
	...(input.userFilter === undefined ? {} : { userFilter: input.userFilter }),
	...(input.orderBy === undefined ? {} : { orderBy: input.orderBy }),
	...('limit' in input && input.limit !== undefined ? { limit: input.limit } : {}),
	...(input.with === undefined ? {} : { with: input.with }),
	...(input.columns === undefined
		? {}
		: { columns: input.columns as Readonly<Record<string, boolean>> }),
	...(input.search === undefined ? {} : { search: input.search })
});

const fullAdvance = Effect.fn('Sync.fullAdvance')(function* (
	effectId: EffectId,
	entry: ResolvedSubscription,
	described: Description
) {
	const answer = yield* resolveSyncQuery(effectId, entry.subject, entry.state.input);
	const resolvedIds = heldIdsOf(answer);
	const digestOnly = resolvedIds.length > MAX_SYNC_HELD_IDS;
	const heldIds = digestOnly ? [] : resolvedIds;
	const heldCoordinates = digestOnly ? [] : heldCoordinatesOf(answer, entry.state.input);
	const digest = yield* Effect.promise(() => contentDigest(answer));
	if (digest === entry.state.digest && described.policyHash === entry.state.policyHash)
		return undefined;
	const patch: SyncPatch =
		entry.state.input.kind === 'count'
			? { op: 'scalar', value: typeof answer === 'number' ? answer : 0 }
			: { op: 'answer', answer };
	return {
		subId: entry.state.subId,
		from: entry.state.digest,
		to: digest,
		patch,
		heldIds,
		heldCoordinates,
		digestOnly,
		policyHash: described.policyHash,
		dependencies: described.dependencies,
		policyDependencies: described.policyDependencies
	} satisfies SyncAdvanceUpdate;
});

const pointAdvance = Effect.fn('Sync.pointAdvance')(function* (
	effectId: EffectId,
	entry: ResolvedSubscription,
	change: SyncChange,
	described: Description
) {
	const input = entry.state.input;
	const coordinates = entry.state.heldCoordinates;
	if (
		input.kind !== 'findMany' ||
		input.search !== undefined ||
		input.with !== undefined ||
		entry.state.digestOnly ||
		coordinates === undefined ||
		coordinates.length !== entry.state.heldIds.length ||
		coordinates.some(
			(coordinate, index) =>
				coordinate.id !== entry.state.heldIds[index] || coordinate.rowVersion === null
		)
	)
		return { supported: false } as PointResult;
	const terms = orderTermsOf(input);
	if (
		coordinates.some(
			(coordinate) =>
				coordinate.order.length !== terms.length ||
				coordinate.order.some((value) => !scalarOrderValue(value))
		)
	)
		return { supported: false } as PointResult;

	const collections = yield* Collections.Service;
	const options = queryOptions(input);
	const probeRows = yield* collections.findMany(EffectId.make(`${effectId}:probe`), entry.subject, {
		...options,
		where: andWhere(options.where, { id: { eq: change.recordId } }),
		limit: 1
	});
	const probe = probeRows[0];
	const incoming = probe === undefined ? undefined : coordinateOf(probe, terms);
	if (probe !== undefined && incoming === undefined) return { supported: false } as PointResult;

	const oldIndex = coordinates.findIndex(({ id }) => id === change.recordId);
	let rank: number | undefined;
	if (incoming !== undefined) {
		const before = positionalWhere(terms, incoming.order, 'before');
		if (before === undefined) return { supported: false } as PointResult;
		rank = yield* collections.count(EffectId.make(`${effectId}:rank`), entry.subject, {
			...options,
			where: andWhere(options.where, before)
		});
	}
	const limit = Math.max(1, input.limit ?? 100);
	const next = [...coordinates];
	let patch: SyncPatch | undefined;

	if (oldIndex < 0) {
		if (probe === undefined || incoming === undefined || rank === undefined || rank >= limit)
			return { supported: true } as PointResult;
		if (next.length < limit) {
			next.splice(rank, 0, incoming);
			patch = { op: 'insert', index: rank, row: probe };
		} else {
			const displaced = next.pop();
			if (displaced === undefined) return { supported: false } as PointResult;
			next.splice(rank, 0, incoming);
			patch = {
				op: 'replace',
				recordId: incoming.id,
				index: rank,
				displaces: displaced.id,
				row: probe
			};
		}
	} else if (probe !== undefined && incoming !== undefined && rank !== undefined && rank < limit) {
		next.splice(oldIndex, 1);
		next.splice(rank, 0, incoming);
		patch = {
			op: 'replace',
			recordId: incoming.id,
			...(rank === oldIndex ? {} : { index: rank }),
			row: probe
		};
	} else {
		next.splice(oldIndex, 1);
		if (coordinates.length >= limit) {
			const anchor = next[next.length - 1];
			const after =
				anchor === undefined ? undefined : positionalWhere(terms, anchor.order, 'after');
			if (anchor !== undefined && after === undefined) return { supported: false } as PointResult;
			const boundaryRows = yield* collections.findMany(
				EffectId.make(`${effectId}:boundary`),
				entry.subject,
				{
					...options,
					where: andWhere(options.where, after, { id: { ne: change.recordId } }),
					limit: 1
				}
			);
			const boundary = boundaryRows[0];
			const seated = boundary === undefined ? undefined : coordinateOf(boundary, terms);
			if (boundary !== undefined && seated === undefined)
				return { supported: false } as PointResult;
			if (boundary !== undefined && seated !== undefined) {
				const index = next.length;
				next.push(seated);
				patch = {
					op: 'replace',
					recordId: seated.id,
					index,
					displaces: change.recordId,
					row: boundary
				};
			}
		}
		patch ??= { op: 'remove', recordId: change.recordId };
	}

	if (patch === undefined) return { supported: false } as PointResult;
	const digest = yield* Effect.promise(() => contentDigestFromHeldCoordinates(next));
	return {
		supported: true,
		update: {
			subId: entry.state.subId,
			from: entry.state.digest,
			to: digest,
			patch,
			heldIds: next.map(({ id }) => id),
			heldCoordinates: next,
			digestOnly: false,
			policyHash: described.policyHash,
			dependencies: described.dependencies,
			policyDependencies: described.policyDependencies
		}
	} as PointResult;
});

/** Exact point/rank patches for simple windows; complex shapes retain the full-answer safety valve. */
export const advanceSubscription = Effect.fn('Sync.advanceSubscription')(function* (
	effectId: EffectId,
	entry: ResolvedSubscription,
	changes: ReadonlyArray<SyncChange> = []
) {
	const described = yield* describeSyncQuery(entry.subject, entry.state.input);
	const rootChanges = changes.filter(
		({ collection }) => collection === entry.state.input.collection
	);
	const fast =
		described.policyHash === entry.state.policyHash &&
		changes.length === 1 &&
		rootChanges.length === 1
			? yield* pointAdvance(
					EffectId.make(`${effectId}:point`),
					entry,
					rootChanges[0] as SyncChange,
					described
				)
			: ({ supported: false } as const);
	if (fast.supported) return fast.update;
	return yield* fullAdvance(EffectId.make(`${effectId}:resolve`), entry, described);
});
