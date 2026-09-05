import { Effect, Result, Schema } from 'effect';
import {
	DEFAULT_SYNC_LOADED_KEYS,
	EffectId,
	MAX_SYNC_INITIAL_ANSWER_BYTES,
	MAX_SYNC_LOADED_KEYS,
	MAX_SYNC_RETAINED_PREFIX_BYTES,
	SyncResetReason,
	compactSyncChanges,
	syncJsonByteLength,
	syncRetainedPrefixBytes,
	type ChangeBatch,
	type LinkAndRouteValues,
	type StoredRecord,
	type SyncAdvanceSubscription,
	type SyncAdvanceUpdate,
	type SyncExtendPrefixEvaluation,
	type SyncExtendPrefixRequest,
	type SyncPrefixDelta,
	type SyncPrefixKey,
	type SyncQueryInput,
	type SyncResetReason as SyncResetReasonType,
	type SyncViewerPrefixDelta
} from '@norbital-ai/bolt-protocol';
import type { CollectionReversePath } from '@norbital-ai/bolt-protocol/collections';
import * as AccessControl from '#lib/runtime/access/access-control.js';
import {
	EffectivePlanError,
	effectiveOrderTerms,
	narrowEffectiveQuery,
	type EffectiveQueryPlan
} from '#lib/runtime/access/effective-plan.js';
import * as Collections from '#lib/runtime/collections/collections.js';
import { encodeCollectionCursor } from '#lib/runtime/collections/read/cursor.js';
import type { Subject } from '#lib/runtime/identity/identity.js';
import * as Workspace from '#lib/runtime/workspace.js';

const MAX_REVERSE_ROOTS = 10_000;
const MAX_IDS_PER_QUERY = 500;
const MAX_SQL_CALLS_PER_PLAN = 32;

export class SyncPrefixResolutionError extends Schema.TaggedError<SyncPrefixResolutionError>()(
	'Bolt.Sync.PrefixResolutionError',
	{ reason: SyncResetReason, message: Schema.NonEmptyString }
) {
	readonly retryable = false;
}

type SyncLivePlan = Readonly<{
	readonly subject: Subject;
	readonly effectivePlan: EffectiveQueryPlan;
}>;
type ResolvedPrefix = Readonly<{
	readonly plan: SyncLivePlan;
	readonly keys: ReadonlyArray<SyncPrefixKey>;
	readonly rows: ReadonlyArray<StoredRecord>;
	readonly retainedBytes: number;
}>;

type SyncDescribeRequirements = Workspace.Interface | AccessControl.Interface;
type SyncEngineRequirements = SyncDescribeRequirements | Collections.Interface;
type SyncEngineError = EffectivePlanError | SyncPrefixResolutionError | Collections.QueryError;

type Graph = 'old' | 'new';
type GraphRow = Readonly<{ readonly id: string; readonly values: LinkAndRouteValues }>;

const ReversePathRowShape = Schema.Struct({
	id: Schema.optionalKey(Schema.Unknown),
	value: Schema.optionalKey(Schema.Unknown)
});
const decodeReversePathRowShape = Schema.decodeUnknownResult(ReversePathRowShape);
const decodeReversePathValue = Schema.decodeUnknownResult(Schema.Json);
const isString = Schema.is(Schema.String);
const isNumber = Schema.is(Schema.Number);
const isBoolean = Schema.is(Schema.Boolean);

const reset = (reason: SyncResetReasonType, message: string): SyncPrefixResolutionError =>
	new SyncPrefixResolutionError({ reason, message });

const chunksOf = <A>(values: ReadonlyArray<A>): ReadonlyArray<ReadonlyArray<A>> => {
	const chunks: Array<ReadonlyArray<A>> = [];
	for (let index = 0; index < values.length; index += MAX_IDS_PER_QUERY)
		chunks.push(values.slice(index, index + MAX_IDS_PER_QUERY));
	return chunks;
};

class SyncPlanWork {
	#calls = 0;
	claimSqlCall(): void {
		if (++this.#calls > MAX_SQL_CALLS_PER_PLAN)
			throw reset(
				'inconsistent-prefix',
				`The live transition exceeded its ${MAX_SQL_CALLS_PER_PLAN}-statement ceiling.`
			);
	}
}

export const describeSyncQuery: (
	subject: Subject,
	input: SyncQueryInput
) => Effect.Effect<
	SyncLivePlan,
	EffectivePlanError | SyncPrefixResolutionError,
	SyncDescribeRequirements
> = Effect.fn('Sync.describeQuery')(function* (subject: Subject, input: SyncQueryInput) {
	const workspace = yield* Workspace.Service;
	const access = yield* AccessControl.Service;
	const compiled = AccessControl.compileEffectiveQueryPlan({
		definition: workspace.definition,
		rootCollection: input.collection,
		where: input.where,
		userFilter: input.userFilter,
		orderBy: input.orderBy,
		with: input.with,
		columns: input.columns,
		...(input.limit === undefined ? {} : { limit: input.limit }),
		...(input.search === undefined ? {} : { search: input.search }),
		kind: input.kind,
		subject,
		policyFor: (collection) => access.invocation().predicate(subject, 'read', collection)
	});
	if (Result.isFailure(compiled)) return yield* Effect.fail(compiled.failure);
	if (compiled.success.mode !== 'live-prefix')
		return yield* Effect.fail(
			reset(
				'inconsistent-prefix',
				compiled.success.oneShotReason ?? 'The query is not admitted as a live contiguous prefix.'
			)
		);
	return { subject, effectivePlan: compiled.success } satisfies SyncLivePlan;
});

const queryInput = (
	plan: SyncLivePlan,
	narrowing: Readonly<{
		readonly where?: unknown;
		readonly limit?: number;
		readonly after?: string;
	}>
): Collections.QueryInput => {
	const execution = narrowEffectiveQuery(plan.effectivePlan, narrowing);
	return {
		collection: execution.collection,
		limit: execution.limit,
		...(execution.where === undefined ? {} : { where: execution.where }),
		...(execution.userFilter === undefined ? {} : { userFilter: execution.userFilter }),
		...(execution.orderBy === undefined ? {} : { orderBy: execution.orderBy }),
		...(execution.with === undefined ? {} : { with: execution.with }),
		...(execution.columns === undefined
			? {}
			: { columns: execution.columns as Collections.QueryInput['columns'] }),
		...(execution.after === undefined ? {} : { after: execution.after }),
		...(execution.search === undefined
			? {}
			: { search: execution.search as Collections.QueryInput['search'] })
	};
};

const findMany = Effect.fn('Sync.findMany')(function* (
	effectId: EffectId,
	work: SyncPlanWork,
	plan: SyncLivePlan,
	narrowing: Parameters<typeof queryInput>[1]
) {
	work.claimSqlCall();
	return (yield* (yield* Collections.Service).findMany(
		effectId,
		plan.subject,
		queryInput(plan, narrowing)
	)) as ReadonlyArray<StoredRecord>;
});

const recordId = (row: StoredRecord): string => {
	const id = row['id'];
	if (!isString(id) || id.length === 0)
		throw reset('inconsistent-prefix', 'A keyed prefix body did not expose its id.');
	return id;
};

const prefixKeyOf = (row: StoredRecord, plan: EffectiveQueryPlan): SyncPrefixKey => {
	const id = row['id'];
	if (!isString(id) || id.length === 0)
		throw reset('inconsistent-prefix', 'An admitted live row did not expose its string id.');
	const order = plan.order.map(({ field }) => row[field]);
	if (
		order.some((value) => value !== null && !['string', 'number', 'boolean'].includes(typeof value))
	)
		throw reset(
			'inconsistent-prefix',
			'An admitted live row omitted an ordering field or returned a non-scalar ordering value.'
		);
	return { id, order: order as SyncPrefixKey['order'] };
};

const retainedPrefixBytes = syncRetainedPrefixBytes;

const uniqueRows = (rows: ReadonlyArray<StoredRecord>): ReadonlyArray<StoredRecord> => {
	const byId = new Map<string, StoredRecord>();
	for (const row of rows) byId.set(recordId(row), row);
	return [...byId.values()];
};

const bodyMap = (rows: ReadonlyArray<StoredRecord>): ReadonlyMap<string, StoredRecord> =>
	new Map(rows.map((row) => [recordId(row), row]));

export const resolveInitialPrefix: (
	effectId: EffectId,
	subject: Subject,
	input: SyncQueryInput,
	requestedPrefix?: number
) => Effect.Effect<ResolvedPrefix, SyncEngineError, SyncEngineRequirements> = Effect.fn(
	'Sync.resolveInitialPrefix'
)(function* (
	effectId: EffectId,
	subject: Subject,
	input: SyncQueryInput,
	requestedPrefix: number = DEFAULT_SYNC_LOADED_KEYS
) {
	const plan = yield* describeSyncQuery(subject, input);
	const limit = Math.min(requestedPrefix, plan.effectivePlan.limit);
	if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SYNC_LOADED_KEYS)
		return yield* Effect.fail(
			reset(
				'prefix-limit',
				`A live prefix must contain between 1 and ${MAX_SYNC_LOADED_KEYS} rows.`
			)
		);
	const rows = uniqueRows(yield* findMany(effectId, new SyncPlanWork(), plan, { limit }));
	const retainedBytes = retainedPrefixBytes(rows);
	if (
		syncJsonByteLength(rows) > MAX_SYNC_INITIAL_ANSWER_BYTES ||
		retainedBytes > MAX_SYNC_RETAINED_PREFIX_BYTES
	)
		return yield* Effect.fail(
			reset('prefix-bytes', 'The initial live prefix exceeds its encoded byte ceiling.')
		);
	return {
		plan,
		keys: rows.map((row) => prefixKeyOf(row, plan.effectivePlan)),
		rows,
		retainedBytes
	} satisfies ResolvedPrefix;
});

const resolveRowsByIds = Effect.fn('Sync.resolveRowsByIds')(function* (
	effectId: EffectId,
	work: SyncPlanWork,
	plan: SyncLivePlan,
	ids: ReadonlyArray<string>
) {
	const distinct = [...new Set(ids)];
	if (distinct.length > MAX_REVERSE_ROOTS)
		return yield* Effect.fail(
			reset('inconsistent-prefix', `A live point probe exceeded ${MAX_REVERSE_ROOTS} root ids.`)
		);
	const rows: StoredRecord[] = [];
	for (const [index, chunk] of chunksOf(distinct).entries())
		rows.push(
			...(yield* findMany(EffectId.make(`${effectId}:chunk:${index}`), work, plan, {
				where: { id: { in: chunk } },
				limit: chunk.length
			}))
		);
	return uniqueRows(rows);
});

const boundaryCursor = (plan: SyncLivePlan, boundary: SyncPrefixKey): string => {
	if (boundary.order.length !== plan.effectivePlan.order.length)
		throw reset('inconsistent-prefix', 'The retained boundary does not match the effective order.');
	const row = Object.fromEntries(
		plan.effectivePlan.order.map(({ field }, index) => [field, boundary.order[index] ?? null])
	);
	const cursor = encodeCollectionCursor(effectiveOrderTerms(plan.effectivePlan), row);
	if (cursor === null)
		throw reset(
			'inconsistent-prefix',
			'The retained boundary cannot be encoded as a keyset cursor.'
		);
	return cursor;
};

const resolveBoundaryRows = Effect.fn('Sync.resolveBoundaryRows')(function* (
	effectId: EffectId,
	work: SyncPlanWork,
	plan: SyncLivePlan,
	boundary: SyncPrefixKey | undefined,
	excludedIds: ReadonlyArray<string>,
	limit: number
) {
	if (boundary === undefined || limit <= 0) return [] as ReadonlyArray<StoredRecord>;
	if (plan.effectivePlan.execution.search !== undefined)
		return yield* Effect.fail(
			reset(
				'inconsistent-prefix',
				'Live search prefix continuation requires an ordering cursor owned by the search planner.'
			)
		);
	return yield* findMany(effectId, work, plan, {
		...(excludedIds.length === 0 ? {} : { where: { id: { notIn: [...new Set(excludedIds)] } } }),
		after: boundaryCursor(plan, boundary),
		limit
	});
});

const graphValues = (
	change: ChangeBatch['changes'][number],
	graph: Graph
): LinkAndRouteValues | null => {
	if (graph === 'old') return change.operation === 'insert' ? null : change.before;
	return change.operation === 'delete' ? null : change.after;
};

const valueAt = (
	change: ChangeBatch['changes'][number],
	graph: Graph,
	field: string
): Schema.Json | undefined => {
	const values = graphValues(change, graph);
	if (values === null) return undefined;
	if (field === 'id') return change.id;
	if (!Object.hasOwn(values, field))
		throw reset(
			'inconsistent-prefix',
			`ChangeBatch omitted required route field ${change.collection}.${field}.`
		);
	return values[field];
};

const decodeGraphRows = (
	rows: ReadonlyArray<Collections.QueryRow>,
	field: string
): ReadonlyArray<GraphRow> =>
	rows.map((row) => {
		const decoded = decodeReversePathRowShape({ id: row['id'], value: row[field] });
		if (Result.isFailure(decoded) || !isString(decoded.success.id))
			throw reset('inconsistent-prefix', 'A reverse-path lookup returned a malformed row.');
		const decodedValue = decodeReversePathValue(decoded.success.value);
		if (Result.isFailure(decodedValue))
			throw reset('inconsistent-prefix', 'A reverse-path lookup returned a malformed value.');
		return { id: decoded.success.id, values: { value: decodedValue.success } };
	});

const routeRows = Effect.fn('Sync.routeRows')(function* (
	effectId: EffectId,
	work: SyncPlanWork,
	subject: Subject,
	collection: string,
	field: string,
	whereField: string,
	values: ReadonlyArray<string>,
	limit = values.length
) {
	if (limit <= 0 || values.length === 0) return [] as ReadonlyArray<GraphRow>;
	const collections = yield* Collections.Service;
	const rows: GraphRow[] = [];
	for (const [index, chunk] of chunksOf([...new Set(values)]).entries()) {
		if (rows.length >= limit) break;
		work.claimSqlCall();
		rows.push(
			...decodeGraphRows(
				yield* collections.findMany(EffectId.make(`${effectId}:chunk:${index}`), subject, {
					collection,
					where: { [whereField]: { in: chunk } },
					columns: { id: true, [field]: true },
					limit: Math.min(limit - rows.length, MAX_REVERSE_ROOTS + 1 - rows.length)
				}),
				field
			)
		);
		if (rows.length > MAX_REVERSE_ROOTS)
			return yield* Effect.fail(
				reset('inconsistent-prefix', `Reverse-path lookup exceeded ${MAX_REVERSE_ROOTS} rows.`)
			);
	}
	return rows;
});

const valuesForGraphRows = Effect.fn('Sync.valuesForGraphRows')(function* (
	effectId: EffectId,
	work: SyncPlanWork,
	plan: SyncLivePlan,
	batch: ChangeBatch,
	collection: string,
	field: string,
	ids: ReadonlyArray<string>,
	graph: Graph
) {
	const current = new Map(
		(yield* routeRows(effectId, work, plan.subject, collection, field, 'id', ids)).map(
			({ id, values }) => [id, values['value']]
		)
	);
	const values: string[] = [];
	for (const id of ids) {
		const change = batch.changes.find(
			(entry) => entry.collection === collection && entry.id === id
		);
		const value = change === undefined ? current.get(id) : valueAt(change, graph, field);
		if (value === undefined || value === null) continue;
		if (!isString(value))
			return yield* Effect.fail(
				reset('inconsistent-prefix', `Relationship route ${collection}.${field} is not a string.`)
			);
		values.push(value);
	}
	return [...new Set(values)];
});

const matchingIdsForGraph = Effect.fn('Sync.matchingIdsForGraph')(function* (
	effectId: EffectId,
	work: SyncPlanWork,
	plan: SyncLivePlan,
	batch: ChangeBatch,
	collection: string,
	field: string,
	values: ReadonlyArray<string>,
	graph: Graph
) {
	if (values.length === 0) return [] as ReadonlyArray<string>;
	const wanted = new Set(values);
	const current = new Set(
		(yield* routeRows(
			effectId,
			work,
			plan.subject,
			collection,
			field,
			field,
			values,
			MAX_REVERSE_ROOTS + 1
		)).map(({ id }) => id)
	);
	for (const change of batch.changes) {
		if (change.collection !== collection) continue;
		const value = valueAt(change, graph, field);
		if (isString(value) && wanted.has(value)) current.add(change.id);
		else current.delete(change.id);
	}
	return [...current];
});

const traverseReversePath = Effect.fn('Sync.traverseReversePath')(function* (
	effectId: EffectId,
	work: SyncPlanWork,
	plan: SyncLivePlan,
	batch: ChangeBatch,
	path: CollectionReversePath,
	startIds: ReadonlyArray<string>,
	graph: Graph
) {
	let collection = path.collection;
	let ids = [...new Set(startIds)];
	for (const [index, segment] of path.segments.entries()) {
		if (segment.fromCollection !== collection)
			return yield* Effect.fail(
				reset('inconsistent-prefix', `Reverse path ${segment.relationship} is discontinuous.`)
			);
		ids = [
			...(yield* matchingIdsForGraph(
				EffectId.make(`${effectId}:targets:${index}`),
				work,
				plan,
				batch,
				segment.toCollection,
				segment.toField,
				yield* valuesForGraphRows(
					EffectId.make(`${effectId}:values:${index}`),
					work,
					plan,
					batch,
					collection,
					segment.fromField,
					ids,
					graph
				),
				graph
			))
		];
		collection = segment.toCollection;
		if (ids.length > MAX_REVERSE_ROOTS)
			return yield* Effect.fail(
				reset('inconsistent-prefix', `Reverse path ${segment.relationship} exceeded its bound.`)
			);
		if (ids.length === 0) break;
	}
	return ids;
});

const resolveAffectedRootIds = Effect.fn('Sync.resolveAffectedRootIds')(function* (
	effectId: EffectId,
	work: SyncPlanWork,
	plan: SyncLivePlan,
	batch: ChangeBatch
) {
	const roots = new Set(
		batch.changes
			.filter(({ collection }) => collection === plan.effectivePlan.rootCollection)
			.map(({ id }) => id)
	);
	for (const [pathIndex, path] of plan.effectivePlan.reversePaths.entries()) {
		const starts = batch.changes
			.filter(({ collection }) => collection === path.collection)
			.map(({ id }) => id);
		if (starts.length === 0) continue;
		for (const graph of ['old', 'new'] as const) {
			for (const id of yield* traverseReversePath(
				EffectId.make(`${effectId}:path:${pathIndex}:${graph}`),
				work,
				plan,
				batch,
				path,
				starts,
				graph
			))
				roots.add(id);
			if (roots.size > MAX_REVERSE_ROOTS)
				return yield* Effect.fail(
					reset('inconsistent-prefix', `The live transition exceeded ${MAX_REVERSE_ROOTS} roots.`)
				);
		}
	}
	return [...roots];
});

const sameKeys = (
	left: ReadonlyArray<SyncPrefixKey>,
	right: ReadonlyArray<SyncPrefixKey>
): boolean =>
	left.length === right.length &&
	left.every(
		(entry, index) =>
			entry.id === right[index]?.id &&
			entry.order.length === right[index]?.order.length &&
			entry.order.every((value, orderIndex) => Object.is(value, right[index]?.order[orderIndex]))
	);

/** The scalar kind two prefix-key order coordinates must share to be comparable. */
const scalarKind = (
	value: SyncPrefixKey['order'][number]
): 'string' | 'number' | 'boolean' | undefined =>
	isString(value)
		? 'string'
		: isNumber(value)
			? 'number'
			: isBoolean(value)
				? 'boolean'
				: undefined;

const compareScalar = (
	left: SyncPrefixKey['order'][number],
	right: SyncPrefixKey['order'][number],
	direction: 'asc' | 'desc'
): number => {
	if (Object.is(left, right)) return 0;
	if (left === null) return direction === 'asc' ? 1 : -1;
	if (right === null) return direction === 'asc' ? -1 : 1;
	if (scalarKind(left) === undefined || scalarKind(left) !== scalarKind(right))
		throw reset(
			'inconsistent-prefix',
			'An effective order produced incomparable runtime coordinates.'
		);
	const compared = left < right ? -1 : 1;
	return direction === 'asc' ? compared : -compared;
};

const compareKeys = (left: SyncPrefixKey, right: SyncPrefixKey, plan: SyncLivePlan): number => {
	if (
		left.order.length !== plan.effectivePlan.order.length ||
		right.order.length !== plan.effectivePlan.order.length
	)
		throw reset('inconsistent-prefix', 'A retained prefix key does not match its effective order.');
	for (const [index, term] of plan.effectivePlan.order.entries()) {
		const compared = compareScalar(
			left.order[index] ?? null,
			right.order[index] ?? null,
			term.direction
		);
		if (compared !== 0) return compared;
	}
	return 0;
};

const validateState = (state: SyncAdvanceSubscription): void => {
	if (!Number.isSafeInteger(state.version) || state.version < 0)
		throw reset('stale-version', 'The retained prefix version is not a non-negative integer.');
	if (
		state.prefixKeys.length > MAX_SYNC_LOADED_KEYS ||
		new Set(state.prefixKeys.map(({ id }) => id)).size !== state.prefixKeys.length
	)
		throw reset(
			'inconsistent-prefix',
			'The retained prefix is duplicated or exceeds its row ceiling.'
		);
	if (
		!Number.isSafeInteger(state.prefixBytes) ||
		state.prefixBytes < 0 ||
		state.prefixBytes > MAX_SYNC_RETAINED_PREFIX_BYTES
	)
		throw reset('prefix-bytes', 'The retained prefix byte receipt is outside its ceiling.');
	if (
		state.viewerPrefixes.length === 0 ||
		state.viewerPrefixes.some(
			(loadedPrefix) =>
				!Number.isSafeInteger(loadedPrefix) ||
				loadedPrefix < 0 ||
				loadedPrefix > MAX_SYNC_LOADED_KEYS
		)
	)
		throw reset('inconsistent-prefix', 'The active prefix has no valid attached viewer.');
};

const requirePlan = Effect.fn('Sync.requirePlan')(function* (
	subject: Subject,
	state: SyncAdvanceSubscription,
	message: string
) {
	const plan = yield* describeSyncQuery(subject, state.input);
	if (plan.effectivePlan.fingerprint !== state.planKey)
		return yield* Effect.fail(
			reset(
				plan.effectivePlan.authority.fingerprint === state.authorityFingerprint
					? 'plan-changed'
					: 'policy-changed',
				message
			)
		);
	return plan;
});

const derivePrefixDelta = (
	oldPrefix: ReadonlyArray<SyncPrefixKey>,
	newPrefix: ReadonlyArray<SyncPrefixKey>,
	affectedIds: ReadonlySet<string>,
	bodies: ReadonlyMap<string, StoredRecord>
): SyncPrefixDelta => {
	const oldIds = new Set(oldPrefix.map(({ id }) => id));
	const newIds = new Set(newPrefix.map(({ id }) => id));
	return {
		removeIds: oldPrefix.flatMap(({ id }) => (newIds.has(id) ? [] : [id])),
		put: newPrefix.flatMap(({ id }, index) => {
			if (oldIds.has(id) && !affectedIds.has(id)) return [];
			const row = bodies.get(id);
			if (row === undefined)
				throw reset('inconsistent-prefix', `Prefix transition has no body for entering row ${id}.`);
			return [{ id, index, row }];
		})
	};
};

const rowsByKeyOrder = (
	rows: ReadonlyArray<StoredRecord>,
	plan: SyncLivePlan,
	limit: number
): ReadonlyArray<StoredRecord> =>
	[...bodyMap(rows).values()]
		.map((row) => ({ row, key: prefixKeyOf(row, plan.effectivePlan) }))
		.sort((left, right) => compareKeys(left.key, right.key, plan))
		.slice(0, limit)
		.map(({ row }) => row);

export const advanceActivePrefix: (
	effectId: EffectId,
	subject: Subject,
	state: SyncAdvanceSubscription,
	batch: ChangeBatch
) => Effect.Effect<SyncAdvanceUpdate | undefined, SyncEngineError, SyncEngineRequirements> =
	Effect.fn('Sync.advanceActivePrefix')(function* (
		effectId: EffectId,
		subject: Subject,
		state: SyncAdvanceSubscription,
		batch: ChangeBatch
	) {
		validateState(state);
		const plan = yield* requirePlan(
			subject,
			state,
			'The effective plan key changed before this commit was applied.'
		);
		const targetLimit = Math.min(plan.effectivePlan.limit, Math.max(...state.viewerPrefixes));
		if (targetLimit < state.prefixKeys.length)
			return yield* Effect.fail(
				reset('inconsistent-prefix', 'The retained prefix exceeds every attached viewer bound.')
			);
		if (state.version >= Number.MAX_SAFE_INTEGER)
			return yield* Effect.fail(reset('stale-version', 'The live prefix version is exhausted.'));

		const compacted: ChangeBatch = { changes: [...compactSyncChanges(batch.changes)] };
		const work = new SyncPlanWork();
		const affectedRootIds = yield* resolveAffectedRootIds(
			EffectId.make(`${effectId}:reverse`),
			work,
			plan,
			compacted
		);
		const affected = new Set(affectedRootIds);
		const oldPrefix = [...state.prefixKeys];
		const survivors = oldPrefix.filter(({ id }) => !affected.has(id));
		const probeRows = yield* resolveRowsByIds(
			EffectId.make(`${effectId}:probe`),
			work,
			plan,
			affectedRootIds
		);
		const boundaryRows = yield* resolveBoundaryRows(
			EffectId.make(`${effectId}:boundary`),
			work,
			plan,
			oldPrefix.at(-1),
			affectedRootIds,
			oldPrefix.length - survivors.length
		);
		const proposedRows = rowsByKeyOrder([...probeRows, ...boundaryRows], plan, targetLimit);
		const proposedById = bodyMap(proposedRows);
		const proposedKeys = [
			...survivors,
			...proposedRows.map((row) => prefixKeyOf(row, plan.effectivePlan))
		]
			.toSorted((left, right) => compareKeys(left, right, plan))
			.filter((key, index, values) => index === 0 || key.id !== values[index - 1]?.id)
			.slice(0, targetLimit);
		const prefixChanged = !sameKeys(oldPrefix, proposedKeys);
		const affectedHeldBody = oldPrefix.some(({ id }) => affected.has(id) && proposedById.has(id));
		if (!prefixChanged && !affectedHeldBody) return undefined;
		const survivorRows = yield* resolveRowsByIds(
			EffectId.make(`${effectId}:survivors`),
			work,
			plan,
			proposedKeys.filter(({ id }) => !proposedById.has(id)).map(({ id }) => id)
		);
		const allBodies = bodyMap([...probeRows, ...boundaryRows, ...survivorRows]);
		const retainedRows: StoredRecord[] = [];
		for (const { id } of proposedKeys) {
			const row = allBodies.get(id);
			if (row === undefined)
				return yield* Effect.fail(
					reset('inconsistent-prefix', `The proposed prefix has no authoritative body for ${id}.`)
				);
			retainedRows.push(row);
		}
		const retainedBytes = retainedPrefixBytes(retainedRows);
		if (retainedBytes > MAX_SYNC_RETAINED_PREFIX_BYTES)
			return yield* Effect.fail(
				reset('prefix-bytes', 'The committed prefix exceeds its cumulative encoded byte ceiling.')
			);
		const toVersion = state.version + 1;
		return {
			subId: state.subId,
			fromVersion: state.version,
			toVersion,
			prefixKeys: proposedKeys,
			prefixBytes: retainedBytes,
			deltas: [...new Set(state.viewerPrefixes)]
				.toSorted((left, right) => left - right)
				.map(
					(loadedPrefix) =>
						({
							loadedPrefix,
							delta: derivePrefixDelta(
								oldPrefix.slice(0, loadedPrefix),
								proposedKeys.slice(0, loadedPrefix),
								affected,
								allBodies
							)
						}) satisfies SyncViewerPrefixDelta
				),
			authorityFingerprint: plan.effectivePlan.authority.fingerprint,
			dependencies: plan.effectivePlan.dependencies
		} satisfies SyncAdvanceUpdate;
	});

export const extendActivePrefix: (
	effectId: EffectId,
	subject: Subject,
	state: SyncAdvanceSubscription,
	request: SyncExtendPrefixRequest
) => Effect.Effect<SyncExtendPrefixEvaluation, SyncEngineError, SyncEngineRequirements> = Effect.fn(
	'Sync.extendActivePrefix'
)(function* (
	effectId: EffectId,
	subject: Subject,
	state: SyncAdvanceSubscription,
	request: SyncExtendPrefixRequest
) {
	validateState(state);
	if (
		!state.viewerPrefixes.some(
			(prefix) => Math.min(prefix, state.prefixKeys.length) === request.loadedPrefix
		)
	)
		return yield* Effect.fail(reset('stale-version', 'The prefix viewer is no longer attached.'));
	if (request.version !== state.version)
		return yield* Effect.fail(reset('stale-version', 'The prefix extension base is stale.'));
	if (request.requestedPrefix <= request.loadedPrefix)
		return yield* Effect.fail(
			reset('stale-version', 'A live prefix extension must be strictly monotonic.')
		);
	const plan = yield* requirePlan(
		subject,
		state,
		'The effective plan changed before prefix extension.'
	);
	if (
		request.requestedPrefix > MAX_SYNC_LOADED_KEYS ||
		request.requestedPrefix > plan.effectivePlan.limit
	)
		return yield* Effect.fail(
			reset('prefix-limit', 'The requested prefix exceeds plan admission.')
		);

	const work = new SyncPlanWork();
	const oldLength = state.prefixKeys.length;
	const extensionRows =
		request.requestedPrefix <= oldLength
			? []
			: state.prefixKeys.at(-1) === undefined
				? yield* findMany(EffectId.make(`${effectId}:extend`), work, plan, {
						limit: request.requestedPrefix - oldLength
					})
				: yield* resolveBoundaryRows(
						EffectId.make(`${effectId}:extend`),
						work,
						plan,
						state.prefixKeys.at(-1),
						[],
						request.requestedPrefix - oldLength
					);
	const nextKeys = [
		...state.prefixKeys,
		...extensionRows.map((row) => prefixKeyOf(row, plan.effectivePlan))
	];
	if (
		new Set(nextKeys.map(({ id }) => id)).size !== nextKeys.length ||
		nextKeys.some((key, index, keys) => {
			const previous = keys[index - 1];
			return previous !== undefined && compareKeys(previous, key, plan) >= 0;
		})
	)
		return yield* Effect.fail(
			reset(
				'inconsistent-prefix',
				'The extension is not a strict continuation of the retained prefix.'
			)
		);
	const toPrefix = Math.min(request.requestedPrefix, nextKeys.length);
	const requestedKeys = nextKeys.slice(request.loadedPrefix, toPrefix);
	const newBodies = bodyMap(extensionRows);
	const bodies = bodyMap([
		...extensionRows,
		...(yield* resolveRowsByIds(
			EffectId.make(`${effectId}:bodies`),
			work,
			plan,
			requestedKeys.filter(({ id }) => !newBodies.has(id)).map(({ id }) => id)
		))
	]);
	const rows = requestedKeys.map(({ id }) => {
		const row = bodies.get(id);
		if (row === undefined)
			throw reset('inconsistent-prefix', `Prefix extension has no body for ${id}.`);
		return row;
	});
	const retainedBytes = state.prefixBytes + retainedPrefixBytes(rows);
	if (retainedBytes > MAX_SYNC_RETAINED_PREFIX_BYTES)
		return yield* Effect.fail(
			reset('prefix-bytes', 'The extended prefix exceeds its cumulative encoded byte ceiling.')
		);
	return {
		queryKey: request.queryKey,
		version: state.version,
		fromPrefix: request.loadedPrefix,
		toPrefix,
		rows,
		retainedBytes,
		prefixKeys: nextKeys
	} satisfies SyncExtendPrefixEvaluation;
});
