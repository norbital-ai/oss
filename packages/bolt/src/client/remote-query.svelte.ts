import { Effect, Fiber, Schema } from 'effect';
import type { RemoteQuery } from '@norbital-ai/std/collection';
import { createSubscriber } from 'svelte/reactivity';
import type { ClientState, QueryState } from '#lib/client/sync/machine.js';
import type { MountedLiveQuery, SyncClient } from '#lib/client/sync/client.js';

const asError = (cause: unknown): Error =>
	cause instanceof Error
		? cause
		: new Error(cause == null ? 'Remote invocation failed' : String(cause));

type RemoteQueryAttempt = Readonly<{
	readonly generation: number;
	readonly isCurrent: () => boolean;
}>;

class ReactiveRemoteQuery<Value> implements RemoteQuery<Value> {
	current = $state.raw<Value | undefined>(undefined);
	error = $state.raw<Error | undefined>(undefined);
	loading = $state(false);
	readonly #pending: Fiber.Fiber<Value, unknown>;
	readonly #fetch: (attempt: RemoteQueryAttempt) => Effect.Effect<Value, unknown>;
	#requestGeneration = 0;

	constructor(fetchValue: (attempt: RemoteQueryAttempt) => Effect.Effect<Value, unknown>) {
		this.#fetch = fetchValue;
		this.#pending = Effect.runFork(
			this.#execute().pipe(
				Effect.flatMap(() => {
					if (this.error !== undefined) return Effect.fail(asError(this.error));
					if (this.current === undefined)
						return Effect.fail(new Error('Remote invocation completed without a value'));
					return Effect.succeed(this.current);
				})
			)
		);
	}

	readonly #execute = (): Effect.Effect<void, unknown> => {
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

export const createRemoteQuery = <Output extends Schema.Top>(
	fetchValue: (attempt: RemoteQueryAttempt) => Effect.Effect<Schema.Schema.Type<Output>, unknown>,
	_schema: Output
): RemoteQuery<Schema.Schema.Type<Output>> => new ReactiveRemoteQuery(fetchValue);

type LiveQueryMachine = Readonly<{
	readonly subscribe: (listener: (state: ClientState) => void) => () => void;
}>;

const liveQueryFinalizers = new FinalizationRegistry<() => void>((cleanup) => cleanup());

const sameWrites = (
	left: ClientState['writes'] | undefined,
	right: ClientState['writes']
): boolean => {
	if (left === right) return true;
	if (left === undefined || left.size !== right.size) return false;
	for (const [id, write] of left) if (right.get(id) !== write) return false;
	return true;
};

class MachineRemoteQuery<Value> implements RemoteQuery<Value> {
	#current: Value | undefined = undefined;
	#error: Error | undefined = undefined;
	#loading = true;
	readonly #track: () => void;
	#notify: (() => void) | undefined;
	#notifyQueued = false;
	#observed = false;
	#observedPrefix: QueryState['prefix'] | undefined = undefined;
	#observedPhase: QueryState['phase'] | undefined = undefined;
	#observedError: string | undefined = undefined;
	#observedWrites: ClientState['writes'] | undefined = undefined;
	readonly #key: string;
	readonly #project: (state: ClientState) => Value | undefined;
	readonly #awaited: Promise<Value>;
	readonly #resolve: (value: Value) => void;
	readonly #reject: (cause: unknown) => void;

	constructor(
		machine: LiveQueryMachine,
		mounted: MountedLiveQuery,
		project: (state: ClientState) => Value | undefined
	) {
		this.#key = mounted.key;
		this.#project = project;
		this.#track = createSubscriber((update) => {
			this.#notify = update;
			return () => {
				if (this.#notify === update) this.#notify = undefined;
			};
		});
		let resolve!: (value: Value) => void;
		let reject!: (cause: unknown) => void;
		this.#awaited = new Promise<Value>((res, rej) => {
			resolve = res;
			reject = rej;
		});
		this.#resolve = resolve;
		this.#reject = reject;
		let released = false;
		let unsubscribe: () => void = () => undefined;
		const cleanup = () => {
			if (released) return;
			released = true;
			unsubscribe();
			mounted.detach();
		};
		const weak = new WeakRef<MachineRemoteQuery<Value>>(this);
		unsubscribe = machine.subscribe((state) => {
			const self = weak.deref();
			if (self !== undefined) self.#observe(state);
		});
		liveQueryFinalizers.register(this, cleanup);
	}

	get current(): Value | undefined {
		this.#track();
		return this.#current;
	}

	get error(): Error | undefined {
		this.#track();
		return this.#error;
	}

	get loading(): boolean {
		this.#track();
		return this.#loading;
	}

	readonly #observe = (state: ClientState): void => {
		const query = state.queries.get(this.#key);
		if (
			this.#observed &&
			query?.prefix === this.#observedPrefix &&
			query?.phase === this.#observedPhase &&
			query?.error === this.#observedError &&
			sameWrites(this.#observedWrites, state.writes)
		)
			return;
		this.#observed = true;
		this.#observedPrefix = query?.prefix;
		this.#observedPhase = query?.phase;
		this.#observedError = query?.error;
		this.#observedWrites = state.writes;
		this.#loading = query === undefined || query.phase === 'pending' || query.prefix === undefined;
		this.#error =
			query !== undefined && query.phase === 'failed' && query.error !== undefined
				? new Error(query.error)
				: undefined;
		const value = this.#project(state);
		if (value !== undefined) {
			this.#resolve(value);
		} else if (this.#error !== undefined) {
			this.#reject(this.#error);
		} else if (query !== undefined && query.phase !== 'pending' && query.prefix !== undefined) {
			this.#resolve(undefined as Value);
		}
		this.#current = value;
		if (this.#notify === undefined || this.#notifyQueued) return;
		this.#notifyQueued = true;
		queueMicrotask(() => {
			this.#notifyQueued = false;
			this.#notify?.();
		});
	};

	then: RemoteQuery<Value>['then'] = (onfulfilled, onrejected) =>
		this.#awaited.then(onfulfilled, onrejected);
}

export const createMachineQuery = <Value>(
	sync: SyncClient,
	mounted: MountedLiveQuery,
	project: (state: ClientState) => Value | undefined
): RemoteQuery<Value> => new MachineRemoteQuery<Value>(sync, mounted, project);
