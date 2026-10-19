// `@norbital-ai/ui/effect` (D9): the one Svelte edge. A page's Effects run on the browser runtime its mount creates
// (`mountEdge(ManagedRuntime.make(ShellLive))` in the shell, the root layout in a host app): `run` hands `{#await}` a
// Promise, `fork` runs an event handler's effect, `live` makes a Svelte store of a Stream and `attach` runs a scoped
// fiber for an element's lifetime. Every fiber runs in the mounted runtime's scope, so unmounting interrupts them all.
import {
	Cause,
	Effect,
	Exit,
	Option,
	Predicate,
	Stream,
	type Fiber,
	type ManagedRuntime,
	type Scope
} from 'effect';
import * as AsyncResult from 'effect/unstable/reactivity/AsyncResult';
import { watch } from 'runed';
import { untrack } from 'svelte';
import type { Attachment } from 'svelte/attachments';
import { createSubscriber } from 'svelte/reactivity';

let edge: ManagedRuntime.ManagedRuntime<never, unknown> | null = null;
let running = 0;

/**
 * Binds the edge to a mount's runtime (the latest mount wins). The returned function disposes the runtime, which
 * interrupts every fiber still running on it and waits for them.
 */
export function mountEdge<R, E>(runtime: ManagedRuntime.ManagedRuntime<R, E>): () => Promise<void> {
	edge = runtime;
	return () => {
		if (edge === runtime) edge = null;
		return runtime.dispose();
	};
}

/** Fibers started through any edge and not yet ended: the mount/unmount leak check reads it. */
export const runningFibers = (): number => running;

function forked<A, E>(effect: Effect.Effect<A, E>): Fiber.Fiber<A, unknown> {
	if (edge === null)
		throw new Error(
			'No ui edge is mounted: the shell mount (or the host layout) calls mountEdge first.'
		);
	// a defect has no handler here: it is logged, then ends the fiber
	const runtime = edge;
	// Effect execution may start synchronously. Only the attachment/source factory declares
	// Svelte dependencies; reads inside its fiber must not restart the attachment or stream.
	const fiber = untrack(() =>
		runtime.runFork(effect.pipe(Effect.tapDefect((defect) => Effect.logError(defect))))
	);
	running++;
	fiber.addObserver(() => {
		running--;
	});
	return fiber;
}

/** For `{#await run(effect)}`: resolves with the success, rejects with the tagged failure for `{:catch}` to render. */
export const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => {
	const fiber = forked(effect);
	// repository-health:allow EFF2 -- D9's rendering edge exposes this owned fiber as a Promise for Svelte await blocks.
	return new Promise((resolve, reject) => {
		fiber.addObserver((exit) =>
			Exit.isSuccess(exit) ? resolve(exit.value) : reject(Cause.squash(exit.cause))
		);
	});
};

/** For an event handler: runs the effect; `onFailure` receives its failure, and the type requires it when one can occur. */
export function fork<A>(effect: Effect.Effect<A>): void;
export function fork<A, E>(effect: Effect.Effect<A, E>, onFailure: (error: E) => void): void;
export function fork<A, E>(effect: Effect.Effect<A, E>, onFailure?: (error: E) => void): void {
	forked(
		onFailure === undefined
			? effect
			: Effect.catch(effect, (error) => Effect.sync(() => onFailure(error)))
	);
}

/** Component-owned query state shared by one-shot Effects and live Streams. */
export type QueryState<A, E> = {
	readonly result: AsyncResult.AsyncResult<A, E>;
	readonly current: A | undefined;
	readonly error: E | undefined;
	/** Waiting for the first answer, rather than for an open subscription to end. */
	readonly loading: boolean;
	/** Restarts the source; its answer or failure is delivered through this state. */
	refetch(): Effect.Effect<void>;
	subscribe(run: (value: A | undefined) => void): () => void;
};
/** A server answer may seed the first render and hydration, never a later query scope. */
export type QueryOptions<A> = { readonly initial?: NoInfer<A> };
/** `$state` ignores a same-reference assign (memory svelte-state-ignores-same-reference): each value is a new array or object. */
const fresh = <A>(value: A): A =>
	(Array.isArray(value)
		? [...value]
		: Predicate.isObject(value) && Object.getPrototypeOf(value) === Object.prototype
			? { ...value }
			: value) as A;

/**
 * A live read in a component (call it while the component initializes): the stream `source()` names, or none for
 * `null`. A change of its reactive inputs subscribes the new stream from empty; teardown interrupts the fiber.
 */
export function live<A, E>(
	source: () => Stream.Stream<A, E> | null,
	options: QueryOptions<A> = {}
): QueryState<A, E> {
	let result: AsyncResult.AsyncResult<A, E> =
		options.initial === undefined
			? AsyncResult.initial(true)
			: AsyncResult.success(options.initial, { waiting: true });
	let first = true;
	let notify: (() => void) | undefined;
	let refresh: (() => void) | undefined;
	const track = createSubscriber((update) => {
		notify = update;
		return () => {
			notify = undefined;
		};
	});
	const trackRefresh = createSubscriber((update) => {
		refresh = update;
		return () => {
			refresh = undefined;
		};
	});
	const readers = new Set<(value: A | undefined) => void>();
	const current = () => Option.getOrUndefined(AsyncResult.value(result));
	const emit = (next: AsyncResult.AsyncResult<A, E>) => {
		result = next;
		notify?.();
		for (const read of readers) read(current());
	};
	watch(
		() => {
			trackRefresh();
			return source();
		},
		(stream) => {
			emit(
				stream === null ? AsyncResult.initial(false) : first ? result : AsyncResult.initial(true)
			);
			first = false;
			if (stream === null) return;
			let active = true;
			const fiber = forked(
				Stream.runForEach(stream, (value) =>
					Effect.sync(() => {
						if (active) emit(AsyncResult.success(fresh(value)));
					})
				).pipe(
					Effect.onExit((exit) =>
						Effect.sync(() => {
							if (!active) return;
							if (Exit.isFailure(exit)) {
								emit(
									Cause.hasInterruptsOnly(exit.cause)
										? AsyncResult.initial(false)
										: AsyncResult.failure(exit.cause)
								);
							} else if (result.waiting) emit(AsyncResult.initial(false));
						})
					),
					Effect.catch(() => Effect.void)
				)
			);
			return () => {
				active = false;
				fiber.interruptUnsafe();
			};
		}
	);
	return {
		get result() {
			track();
			return result;
		},
		get current() {
			track();
			return current();
		},
		get error() {
			track();
			return Option.getOrUndefined(AsyncResult.error(result));
		},
		get loading() {
			track();
			return result.waiting;
		},
		refetch: () => Effect.sync(() => refresh?.()),
		subscribe(read) {
			readers.add(read);
			read(current());
			return () => {
				readers.delete(read);
			};
		}
	};
}

/** A one-shot read composes into the same state and lifetime as a live query. */
export function query<A, E>(
	source: () => Effect.Effect<A, E> | null,
	options: QueryOptions<A> = {}
): QueryState<A, E> {
	return live(() => {
		const effect = source();
		return effect === null ? null : Stream.fromEffect(effect);
	}, options);
}

/** `{@attach attach((node) => effect)}`: the effect runs scoped for the element's lifetime, interrupted when it leaves. */
export const attach =
	<N extends Element>(f: (node: N) => Effect.Effect<unknown, never, Scope.Scope>): Attachment<N> =>
	(node) => {
		const fiber = forked(Effect.scoped(f(node)));
		return () => fiber.interruptUnsafe();
	};
