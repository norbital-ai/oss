import { Effect, Fiber, Schema } from 'effect';
import type { RemoteQuery } from '@norbital-ai/std/collection';
import type { ClientState } from '#lib/client/sync/machine.js';
import type { MountedLiveQuery, SyncClient } from '#lib/client/sync/client.js';

const asError = (cause: unknown): Error =>
	cause instanceof Error
		? cause
		: new Error(cause == null ? 'Remote invocation failed' : String(cause));

/**
 * One reload attempt's publication fence.
 *
 * Transport cancellation is an optimisation, not a correctness boundary: a response may win the
 * network race after a newer search/filter request has already started. Callers use this fence
 * before installing any durable proof, while this module uses the same fence before changing the
 * reactive value. That makes "request 10 cannot publish over request 11" one invariant rather than
 * two best-effort checks.
 */
type RemoteQueryAttempt = Readonly<{
	readonly generation: number;
	readonly isCurrent: () => boolean;
}>;

/** Holds one in-flight command so `$derived` / CollectionTable see rows after the response lands. */
class ReactiveRemoteQuery<Value extends Schema.Json> implements RemoteQuery<Value> {
	current = $state.raw<Value | undefined>(undefined);
	error = $state.raw<Error | undefined>(undefined);
	loading = $state(false);
	readonly #pending: Fiber.Fiber<Value, unknown>;
	readonly #fetch: (attempt: RemoteQueryAttempt) => Effect.Effect<Value, unknown>;
	#requestGeneration = 0;

	constructor(fetchValue: (attempt: RemoteQueryAttempt) => Effect.Effect<Value, unknown>) {
		this.#fetch = fetchValue;
		this.#pending = Effect.runFork(
			this.#reload().pipe(
				Effect.flatMap(() => {
					// Re-execution records failures in the reactive `error` cell; failing here is
					// what keeps the awaited half honest.
					if (this.error !== undefined) return Effect.fail(asError(this.error));
					if (this.current === undefined)
						return Effect.fail(new Error('Remote invocation completed without a value'));
					return Effect.succeed(this.current);
				})
			)
		);
	}

	/**
	 * Revalidates, painting the last known answer first when there is one.
	 *
	 * `loading` stays true across the cached paint on purpose: the answer on screen is real but not
	 * yet confirmed, and a spinner that cleared here would tell the reader the revalidation had
	 * finished. Callers that want "have I got anything to show" already ask `current !== undefined`.
	 *
	 * The whole flow is one Effect. `loading` is reset in the effect's own continuation rather than in
	 * a `finally`, because a failure above the fetch is left to propagate with the flag still
	 * true — the pending fiber surfaces that failure to its awaiter.
	 */
	readonly #reload = (): Effect.Effect<void, unknown> => {
		// Captured because `Effect.gen` bodies are plain generators, and `this` inside one is
		// whatever it was called with — not the query instance.
		const self = this;
		const generation = (this.#requestGeneration += 1);
		const attempt: RemoteQueryAttempt = {
			generation,
			isCurrent: () => self.#requestGeneration === generation
		};
		return Effect.gen(function* () {
			yield* Effect.sync(() => {
				self.loading = true;
				self.error = undefined;
			});
			yield* self.#fetch(attempt).pipe(
				Effect.match({
					onFailure: (cause) => {
						if (!attempt.isCurrent()) return;
						self.error = asError(cause);
					},
					onSuccess: (value) => {
						if (!attempt.isCurrent()) return;
						self.current = value;
					}
				})
			);
			yield* Effect.sync(() => {
				if (attempt.isCurrent()) self.loading = false;
			});
		});
	};

	then: RemoteQuery<Value>['then'] = (onfulfilled, onrejected) =>
		Effect.runPromise(Fiber.join(this.#pending)).then(onfulfilled, onrejected);
}

/** Starts a command and exposes its result as Svelte-tracked query state. */
export const createRemoteQuery = <Output extends Schema.ConstraintDecoder<Schema.Json>>(
	fetchValue: (attempt: RemoteQueryAttempt) => Effect.Effect<Output['Type'], unknown>,
	_schema: Output
): RemoteQuery<Output['Type']> => new ReactiveRemoteQuery(fetchValue);

type LiveQueryMachine = Readonly<{
	readonly subscribe: (listener: (state: ClientState) => void) => () => void;
}>;

/**
 * Releases a mounted query when nothing references its view any more.
 *
 * The subscription must not anchor the view: the listener reaches it through a WeakRef, so an
 * unreferenced query is collectable and this registry then unsubscribes it and releases the mount.
 * The Machine retains a released query for RETAIN_MS, so back-navigation repaints without a round
 * trip while the host stops computing for it afterwards.
 */
const liveQueryFinalizers = new FinalizationRegistry<() => void>((cleanup) => cleanup());

/**
 * A collection read answered by the Machine: `{ current, loading, error }` with the §1.7 semantics.
 *
 * `current` is projected once per Machine publication, so a frame, an outcome and a mount all land
 * as one paint. `loading` stays true while a revalidation repaints a retained answer, and
 * `current !== undefined` remains the readiness test. The awaited half resolves with the first
 * projected value, or rejects when a query fails before holding one — the same contract the
 * command-backed query above keeps.
 *
 * An authoritative answer that projects to nothing is also an answer: a `findFirst` over an empty
 * set is settled, not stuck, so the awaited half resolves `undefined` instead of hanging behind a
 * value that will never come. Pending is different — no answer yet — and keeps waiting. `oneshot`
 * marks a read answered once by contract (a cursored page, §2.3): the moment its awaited half
 * settles, the mount is released and the subscription dropped so the host stops computing for it.
 */
class MachineRemoteQuery<Value> implements RemoteQuery<Value> {
	current = $state.raw<Value | undefined>(undefined);
	error = $state.raw<Error | undefined>(undefined);
	loading = $state(true);
	readonly #key: string;
	readonly #project: (state: ClientState) => Value | undefined;
	readonly #awaited: Promise<Value>;
	readonly #resolve: (value: Value) => void;
	readonly #reject: (cause: unknown) => void;
	#release?: () => void;

	constructor(
		machine: LiveQueryMachine,
		mounted: MountedLiveQuery,
		project: (state: ClientState) => Value | undefined,
		oneshot = false
	) {
		this.#key = mounted.key;
		this.#project = project;
		let resolve!: (value: Value) => void;
		let reject!: (cause: unknown) => void;
		this.#awaited = new Promise<Value>((res, rej) => {
			resolve = res;
			reject = rej;
		});
		this.#resolve = resolve;
		this.#reject = reject;
		const weak = new WeakRef<MachineRemoteQuery<Value>>(this);
		const unsubscribe = machine.subscribe((state) => {
			const self = weak.deref();
			if (self !== undefined) self.#observe(state);
		});
		const cleanup = () => {
			unsubscribe();
			mounted.release();
		};
		if (oneshot) this.#release = cleanup;
		liveQueryFinalizers.register(this, cleanup);
	}

	readonly #observe = (state: ClientState): void => {
		const query = state.queries.get(this.#key);
		this.loading = query === undefined || query.phase === 'pending' || query.answer === undefined;
		this.error =
			query !== undefined && query.phase === 'failed' && query.error !== undefined
				? new Error(query.error)
				: undefined;
		const value = this.#project(state);
		let settled = false;
		if (value !== undefined) {
			this.#resolve(value);
			settled = true;
		} else if (this.error !== undefined) {
			this.#reject(this.error);
			settled = true;
		} else if (query !== undefined && query.phase !== 'pending' && query.answer !== undefined) {
			// The answer exists and the projection legitimately maps it to nothing — an empty
			// findFirst, an empty page. The wait is over; the emptiness is the answer.
			this.#resolve(undefined as Value);
			settled = true;
		}
		this.current = value;
		if (settled) this.#release?.();
	};

	then: RemoteQuery<Value>['then'] = (onfulfilled, onrejected) =>
		this.#awaited.then(onfulfilled, onrejected);
}

/**
 * Opens one Machine-backed view over a mounted live query.
 *
 * `oneshot` releases the mount once the read's awaited half settles, for reads answered once by
 * contract rather than held live.
 */
export const createMachineQuery = <Value>(
	sync: SyncClient,
	mounted: MountedLiveQuery,
	project: (state: ClientState) => Value | undefined,
	oneshot = false
): RemoteQuery<Value> => new MachineRemoteQuery<Value>(sync, mounted, project, oneshot);
