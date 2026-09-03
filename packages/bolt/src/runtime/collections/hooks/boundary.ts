import { Effect, Schema } from 'effect';
import { EffectId, type EffectId as EffectIdType } from '@norbital-ai/bolt-protocol';
import * as InvocationBudget from '#lib/runtime/budget.js';
import type * as Identity from '#lib/runtime/identity/identity.js';
import type {
	NearestQueryInput,
	QueryInput
} from '#lib/runtime/collections/collections.contract.js';
import {
	type AuthoringOps,
	type AuthoringReadOps
} from '#lib/runtime/collections/authored.js';
import { nearestQueryInput, queryInput } from '#lib/runtime/collections/query-input.js';

/** The hook shape the collection lifecycle is allowed to inspect. */
type CollectionHookPoint = Readonly<{
	readonly description?: string;
	readonly handler: (context: unknown) => unknown;
}>;

type CollectionPerRecordHooks = Readonly<{
	readonly before?: CollectionHookPoint;
	readonly after?: CollectionHookPoint;
}>;

/**
 * The authored hook structure admitted across the collection boundary.
 *
 * Write preparation needs the input codec and hook phases, but it must not depend on the broader
 * authored-runtime facade. Keeping that exact structural contract here lets the lifecycle remain a
 * collection implementation rather than a second consumer of authored runtime internals.
 */
export type CollectionHookModule = Readonly<{
	readonly input?: Schema.Codec<unknown, unknown>;
	readonly mutate?: Readonly<{
		readonly prepare?: (context: unknown) => unknown;
		readonly perRecord?: CollectionPerRecordHooks;
	}>;
	readonly delete?: Readonly<{
		readonly prepare?: (context: unknown) => unknown;
		readonly perRecord?: CollectionPerRecordHooks;
	}>;
}>;

type HookPhase = 'prepare' | 'before' | 'after' | 'delete.before' | 'delete.after';
/** A hook-issued write is labelled by the boundary too, distinct from the phase that issued it. */
type HookWritePhase = HookPhase | 'mutate';

const effectLabel = (value: string): string => encodeURIComponent(value).replaceAll('%', '_');

type HookEffectCoordinate = Readonly<{
	readonly phase: HookWritePhase;
	readonly collection: string;
	readonly recordId?: string | undefined;
}>;

/**
 * Invocation-local issuer for hook writes.
 *
 * Even two writes to the same record receive different child ids, preventing facility deduplication
 * from silently collapsing the second write. The ordinal is state owned by the boundary, not by an
 * author who could accidentally reuse it.
 */
export class HookEffectIds {
	#issued = 0;
	readonly parent: EffectIdType;

	constructor(parent: EffectIdType) {
		this.parent = parent;
	}

	next(coordinate: HookEffectCoordinate): EffectIdType {
		this.#issued += 1;
		return EffectId.make(
			[
				this.parent,
				'hook',
				effectLabel(coordinate.phase),
				effectLabel(coordinate.collection),
				effectLabel(coordinate.recordId ?? 'root'),
				String(this.#issued)
			].join(':')
		);
	}
}

/**
 * How many levels of hook-caused writes one originating write may set off.
 *
 * Separate from `InvocationBudget`'s limit even though the number matches, because they bound
 * different things: that one counts *enqueued* work, which the host runs later on its own
 * invocation, and this counts writes nested inside one invocation's own fiber tree. They share the
 * error type because they are the same message to whoever reads it — something recursed — and
 * nothing is served by two codes for it.
 */
const HOOK_NESTING_LIMIT = 8;

export type HookWriteOps<E = never> = Pick<AuthoringOps<E>, 'mutate'>;

/**
 * Refuses a hook chain that has stopped going anywhere.
 *
 * Hooks nest by design — a write runs hooks, and a hook may write, which runs more hooks — and
 * that is how `employments` creates `employment_terms`. The shape has no natural floor: a hook
 * that writes back to its own collection recurses until something stops it, and until this
 * existed the only thing that did was the invocation deadline, by which point the chain had
 * committed every write it managed to fit inside it. There is no transaction to roll those
 * back, so "eventually times out" is not a bound worth having.
 *
 * Checked on the way *in* to a write, so the refusal names the collection whose hook went too
 * deep. The limit is deliberately far above the real chains, which are two or three levels: it
 * is here to catch a loop, not to shape a design.
 */
export const refuseRunawayHooks = (
	action: string,
	collection: string,
	depth: number,
	limit: number = HOOK_NESTING_LIMIT
): Effect.Effect<void, InvocationBudget.NestingLimitExceeded> =>
	depth > limit
		? Effect.fail(
				InvocationBudget.NestingLimitExceeded.at(
					`${action} on ${collection}, from a hook`,
					depth,
					limit
				)
			)
		: Effect.void;

type AuthoringReadPorts<E = never> = Readonly<{
	readonly allowedCollections: ReadonlySet<string>;
	readonly findMany: (
		effectId: EffectIdType,
		subject: Identity.Subject,
		input: QueryInput
	) => Effect.Effect<ReadonlyArray<Readonly<Record<string, unknown>>>, E>;
	readonly count: (
		effectId: EffectIdType,
		subject: Identity.Subject,
		input: QueryInput
	) => Effect.Effect<number, E>;
	readonly findNearest: (
		effectId: EffectIdType,
		subject: Identity.Subject,
		input: NearestQueryInput
	) => Effect.Effect<ReadonlyArray<Readonly<Record<string, unknown>>>, E>;
}>;

type AuthoringWritePorts<
	ReadE = never,
	MutateE = never,
	AutoE = never,
	InferE = never
> = AuthoringReadPorts<ReadE> &
	Readonly<{
		readonly mutate: (
			effectId: EffectIdType,
			subject: Identity.Subject,
			collection: string,
			values: ReadonlyArray<Readonly<Record<string, unknown>>>,
			elevated: boolean,
			depth: number
		) => Effect.Effect<unknown, MutateE>;
		readonly startAutomation: (
			effectId: EffectIdType,
			name: string,
			input: Schema.Json,
			scope: Readonly<Record<string, Schema.Json>>,
			options?: Readonly<{
				readonly after?: string | number;
				readonly taskId?: string;
				readonly parentDepth?: number;
			}>
		) => Effect.Effect<{ readonly taskId: string }, AutoE>;
		readonly infer: AuthoringOps<InferE>['infer'];
		readonly readFileAsset: AuthoringOps<InferE>['readFileAsset'];
	}>;

/**
 * Builds the invocation-bound authoring api from explicit ports.
 *
 * After hooks use the same singular `db.<collection>.mutate` surface as every other context.
 * Their bound operation is elevated because the record already passed authorization; authority
 * changes, while vocabulary does not.
 */
export const buildReadOps = <E>(
	ports: AuthoringReadPorts<E>,
	effectId: EffectIdType,
	subject: Identity.Subject
): AuthoringReadOps<E> => ({
	allowedCollections: ports.allowedCollections,
	findMany: (collection, input) =>
		ports.findMany(effectId, subject, queryInput(collection, input)),
	findFirst: (collection, input) =>
		ports
			.findMany(effectId, subject, { ...queryInput(collection, input), limit: 1 })
			.pipe(Effect.map((rows) => rows[0])),
	count: (collection, input) => ports.count(effectId, subject, queryInput(collection, input)),
	findNearest: (collection, input) =>
		ports.findNearest(effectId, subject, nearestQueryInput(collection, input))
});

export const buildOps = <ReadE, MutateE, AutoE, InferE, StagedE = never>(
	ports: AuthoringWritePorts<ReadE, MutateE, AutoE, InferE>,
	effectId: EffectIdType,
	subject: Identity.Subject,
	elevated = false,
	/**
	 * How many hooks deep the write that produced this api already is.
	 *
	 * A hook that writes runs the hooks of what it wrote, and those may write again. That is a
	 * legitimate and common shape — an employment's `mutate.after` creates its terms — but it is
	 * also a loop the moment a hook writes back to its own collection, and nothing else bounds
	 * it. The invocation deadline eventually would, by which time the chain has done however
	 * many writes it could fit into thirty seconds and every one of them is a fact.
	 */
	depth = 0,
	staged?: HookWriteOps<StagedE>,
	automationDepth?: number
): AuthoringOps<ReadE | MutateE | AutoE | InferE | StagedE> => {
	/**
	 * One fresh child effect id per hook-issued write.
	 *
	 * The facility dedups on effectId, so two writes sharing one id silently became one — a
	 * hook that created a row and then updated it committed only the second. The boundary's
	 * issuer owns the ordinal so an author cannot reuse or reset it, and the coordinate keeps
	 * the id readable in a ledger.
	 */
	const hookEffectIds = new HookEffectIds(effectId);
	const hookWrite = (collection: string, values: Readonly<Record<string, unknown>>) => {
		const childEffectId = hookEffectIds.next({ phase: 'mutate', collection });
		return staged?.mutate === undefined
			? ports
					.mutate(childEffectId, subject, collection, [values], elevated, depth)
					.pipe(Effect.asVoid)
			: staged.mutate(collection, values);
	};
	return {
		...buildReadOps(ports, effectId, subject),
		runAutomation: (name, input, options) =>
			ports.startAutomation(
				effectId,
				name,
				input,
				{},
				{
					...options,
					...(automationDepth === undefined ? {} : { parentDepth: automationDepth })
				}
			),
		mutate: hookWrite,
		infer: ports.infer,
		readFileAsset: ports.readFileAsset
	};
};
