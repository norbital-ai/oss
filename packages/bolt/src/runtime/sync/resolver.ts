import { Effect, Schema } from 'effect';
import {
	EffectId,
	type SyncAnswer,
	type SyncQueryInput,
	type SyncRoutingConstraint
} from '@norbital-ai/bolt-protocol';
import * as AccessControl from '#lib/runtime/access/access-control.js';
import * as Collections from '#lib/runtime/collections/collections.js';
import { encodeCollectionCursor } from '#lib/runtime/collections/read/cursor.js';
import { compileOrderTerms, makeWhereContext } from '#lib/runtime/collections/read/where.js';
import type { Subject } from '#lib/runtime/identity/identity.js';
import { IDENTITY_COLLECTIONS } from '#lib/runtime/schema/system-collections.js';
import * as Workspace from '#lib/runtime/workspace.js';
import { stableDigest } from './digest.js';

const JsonObject = Schema.Record(Schema.String, Schema.Json);

const isRoutingScalar = (value: unknown): value is string | number | boolean | null =>
	value === null || ['string', 'number', 'boolean'].includes(typeof value);

/** Necessary top-level equality predicates a blind host may use to rule a subscription out. */
export const syncQueryRouting = (input: SyncQueryInput): ReadonlyArray<SyncRoutingConstraint> => {
	if (!Schema.is(JsonObject)(input.where)) return [];
	return Object.entries(input.where).flatMap(([field, condition]) => {
		if (!Schema.is(JsonObject)(condition)) return [];
		const equal = condition['eq'];
		if (isRoutingScalar(equal)) return [{ field, values: [equal] }];
		const oneOf = condition['in'];
		return Array.isArray(oneOf) && oneOf.length > 0 && oneOf.every(isRoutingScalar)
			? [{ field, values: oneOf }]
			: [];
	});
};

/** The page size findMany answers when the caller sends no limit; kept identical to the read path. */
const DEFAULT_PAGE_LIMIT = 100;

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
	...(input.search === undefined ? {} : { search: input.search }),
	...('after' in input && input.after !== undefined ? { after: input.after } : {})
});

/** Calls the one authoritative collection resolver surface; no sync-specific evaluator exists. */
export const resolveSyncQuery = Effect.fn('Sync.resolveQuery')(function* (
	effectId: EffectId,
	subject: Subject,
	input: SyncQueryInput
) {
	const collections = yield* Collections.Service;
	if (input.kind === 'count')
		return (yield* collections.count(effectId, subject, queryOptions(input))) as SyncAnswer;
	if (input.kind === 'findFirst')
		return ((yield* collections.findFirst(effectId, subject, queryOptions(input))) ??
			null) as SyncAnswer;
	if (input.kind === 'findGrouped') {
		return (yield* collections.findGrouped(effectId, subject, {
			...queryOptions(input),
			groupBy: input.group.by,
			lanes: input.group.lanes ?? []
		})) as SyncAnswer;
	}
	const rows = yield* collections.findMany(effectId, subject, queryOptions(input));
	if (input.after === undefined) return rows as SyncAnswer;
	// A cursored read is one-shot, not live (§2.3), and §1.7 keeps `after`/`nextCursor` answered:
	// the page rides the cursored SyncAnswer arm, its continuation encoded over the same order
	// terms the read was seeked with. Null when this page is the last — or when the projection or
	// mask left an order column unreadable, which makes walking further impossible rather than
	// merely unaddressed.
	const workspace = yield* Workspace.Service;
	const definition = yield* workspace.collection(input.collection);
	const ordering = compileOrderTerms(
		input.orderBy,
		makeWhereContext(input.collection, definition.fields, workspace.definition)
	);
	const last = rows[rows.length - 1];
	return {
		rows: [...rows],
		nextCursor:
			rows.length < Math.max(1, input.limit ?? DEFAULT_PAGE_LIMIT) || last === undefined
				? null
				: encodeCollectionCursor(ordering, last)
	};
});

const relationKeys = (value: Schema.Json | undefined): ReadonlyArray<string> => {
	if (value === undefined || !Schema.is(JsonObject)(value)) return [];
	return Object.entries(value).flatMap(([name, nested]) => [name, ...relationKeys(nested)]);
};

/**
 * The predicate graph, §2.2 — the collections a compiled read predicate, or the subject it was
 * compiled from, can depend on. A subject's shape (team path, held policies) is derived from
 * `user` and `team` rows and from nothing else, and the approval-entitlement branch subqueries
 * open `approval_request` rows. These are the only system collections whose policy surface
 * belongs in a policy hash: the surface of `chat_message` or `bolt_notifications` has nothing to
 * do with a query about `people`, and folding it in makes every subscription's hash answer for
 * grants that can never touch its answer. An authored `policySql` predicate that subqueries another
 * table is outside what any compile-time graph can see; the digest chain and reconnect
 * revalidation remain its backstop.
 */
const POLICY_GRAPH_COLLECTIONS: ReadonlyArray<string> = ['approval_request', 'team', 'user'];

/**
 * §2.2.3: identity and policy collections are dependencies of every SubState (I2), so the write
 * that drifts a subject reaches the registry and the host can re-key each connection whose hash
 * moved. Deliberately wider than the hash surface: an identity write wakes subscriptions, and the
 * unchanged policy hash each re-registration reports is what keeps connections that answer
 * identically attached — a wake costs re-resolution, a moved hash costs a detach and a full
 * answer.
 */
const POLICY_DEPENDENCIES: ReadonlyArray<string> = [
	'approval_request',
	...IDENTITY_COLLECTIONS.map(({ name }) => name)
].toSorted((left, right) => left.localeCompare(right));

/**
 * Conservative query dependency derivation.
 *
 * The dependency set is the query's own collections (root plus every `with` relation target, with
 * an unknown relation falling back to every collection) unioned with {@link POLICY_DEPENDENCIES};
 * the policy hash narrows to the query's collections unioned with the predicate graph. Under-
 * reporting either costs liveness or sharing safety, so both err wide; over-reporting costs only
 * probes. Relation names are resolved through the authored graph.
 */
export const describeSyncQuery = Effect.fn('Sync.describeQuery')(function* (
	subject: Subject,
	input: SyncQueryInput
) {
	const workspace = yield* Workspace.Service;
	const access = yield* AccessControl.Service;
	const dependencies = new Set<string>([input.collection]);
	const hashCollections = new Set<string>([input.collection]);
	let frontier = [input.collection];
	for (const relationName of relationKeys(input.with)) {
		const relation = workspace.definition.relations.find(
			(candidate) => frontier.includes(candidate.source) && candidate.name === relationName
		);
		if (relation === undefined) {
			for (const collection of workspace.definition.collections) {
				dependencies.add(collection.name);
				hashCollections.add(collection.name);
			}
			frontier = workspace.definition.collections.map(({ name }) => name);
			continue;
		}
		dependencies.add(relation.target);
		hashCollections.add(relation.target);
		frontier = [relation.target];
	}
	// The identity graph rides the dependency set — an identity write must wake every subscription
	// (§2.2.3) — but NOT the hash: those collections' own read surfaces bind `requestor.id`, so
	// hashing them would give every subject a different hash and defeat SubState sharing entirely.
	// Sharing stays safe without them: the hash covers the query's own predicate surface, and a
	// grant edit changes that surface's SQL text (or bound team), which moves the hash.
	for (const collection of POLICY_DEPENDENCIES) dependencies.add(collection);
	// The policy hash, §2.2: the subject's compiled read surface narrowed to the query's own
	// collections, as executed — SQL text, bound parameters and the field grant per collection
	// (`policyHashSource`). Parameters are in the hash, which is the narrow holder coarsening: a
	// team-scoped grant binds the team name, so two members of one team compile identical surfaces
	// and collapse to one hash, while an actor-bound grant binds the user id and splits. Collapsing
	// two *different* compiled surfaces that happen to answer alike would need a holder coordinate
	// the access layer does not expose; until one exists the hash stays the compiled surface, and
	// sharing degrades per policy-shape, never wrongly.
	//
	// The hash is a pure function of (query input, subject surface), never of approval state or
	// wall-clock: the approval-entitlement branch is compiled unconditionally (constant `false`
	// for a team-less subject) and an empty `in` collapses to a constant, so approval rows change
	// answers, not hashes — their wake rides `approval_request` in the dependency set.
	const invocation = access.invocation();
	const policySource = [...hashCollections]
		.toSorted((left, right) => left.localeCompare(right))
		.map((collection) => invocation.policyHashSource(subject, 'read', collection));
	const cursored = 'after' in input && input.after !== undefined;
	return {
		dependencies: cursored
			? []
			: [...dependencies].toSorted((left, right) => left.localeCompare(right)),
		policyDependencies: cursored ? [] : [...POLICY_DEPENDENCIES],
		routing: cursored ? [] : syncQueryRouting(input),
		policyHash: yield* Effect.promise(() => stableDigest(policySource))
	};
});
