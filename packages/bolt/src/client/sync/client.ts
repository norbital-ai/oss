import type {
	CollectionMutationIdempotencyKey,
	CollectionMutateRequest,
	SyncAnswer,
	SyncConnectRequest,
	SyncOutcome,
	SyncQueryInput
} from '@norbital-ai/bolt-protocol';
import { stableKey } from '../live-query/stable-key.js';
import type { SyncHttpDriver } from './http-driver.js';
import { SyncHttpError } from './http-driver.js';
import {
	RETAIN_MS,
	STALE_WRITE_MS,
	type ClientEffect,
	type ClientEvent,
	type ClientState,
	initialClientState,
	step
} from './machine.js';
import { openSyncSse, type SyncSseDriver } from './sse-driver.js';

export type LiveQuerySeed = Readonly<{
	readonly answer: SyncAnswer;
	readonly digest: string;
}>;

export type MountedLiveQuery = Readonly<{
	readonly key: string;
	readonly release: () => void;
}>;

export type SyncClient = Readonly<{
	readonly start: () => void;
	readonly current: () => ClientState;
	readonly subscribe: (listener: (state: ClientState) => void) => () => void;
	readonly mount: (input: SyncQueryInput, seed?: LiveQuerySeed) => MountedLiveQuery;
	readonly enqueue: (request: CollectionMutateRequest) => void;
}>;

export type SyncClientOptions = Readonly<{
	readonly streamUrl: string;
	readonly http: SyncHttpDriver;
	readonly onOutcomes?: (outcomes: ReadonlyArray<SyncOutcome>, state: ClientState) => void;
	readonly onError?: (cause: unknown) => void;
}>;

type Timer = ReturnType<typeof setTimeout>;

const nextTickAt = (state: ClientState): number | undefined => {
	const deadlines: number[] = [];
	if (state.link === 'reconnecting') deadlines.push(state.reconnectAt);
	for (const query of state.queries.values()) {
		if (query.subscribers === 0 && query.releasedAt !== undefined) {
			deadlines.push(query.releasedAt + RETAIN_MS);
		}
	}
	if (state.link === 'live') {
		for (const write of state.writes.values()) {
			deadlines.push(write.phase === 'queued' ? 0 : write.sentAt + STALE_WRITE_MS);
		}
	}
	return deadlines.length === 0 ? undefined : Math.min(...deadlines);
};

const requestOf = (
	effect: Extract<ClientEffect, { readonly kind: 'connect' }>
): SyncConnectRequest => ({
	...(effect.head === undefined ? {} : { head: effect.head }),
	queries: [...effect.queries],
	released: [...effect.released],
	pending: [...effect.pending]
});

/**
 * Owns the imperative edges around the pure Machine: one stream, serialized control HTTP, a
 * deadline-driven clock, and write pushes. No timer asks the server what changed.
 */
export const createSyncClient = (options: SyncClientOptions): SyncClient => {
	let state = initialClientState(Date.now());
	let stream: SyncSseDriver | undefined;
	let connectionId: string | undefined;
	let connectionAbort: AbortController | undefined;
	let timer: Timer | undefined;
	let started = false;
	let controlTail = Promise.resolve();
	const listeners = new Set<(state: ClientState) => void>();
	const waitingControls = new Map<string, Exclude<ClientEffect, { readonly kind: 'push' }>>();

	const report = (cause: unknown): void => options.onError?.(cause);

	const schedule = (): void => {
		if (!started) return;
		if (timer !== undefined) clearTimeout(timer);
		timer = undefined;
		const at = nextTickAt(state);
		if (at === undefined) return;
		timer = setTimeout(
			() => {
				timer = undefined;
				dispatch({ kind: 'tick', now: Date.now() });
			},
			Math.max(0, at - Date.now())
		);
	};

	const publish = (): void => {
		for (const listener of listeners) listener(state);
	};

	const disconnect = (cause: unknown): void => {
		const at = Date.now();
		stream?.close();
		stream = undefined;
		connectionId = undefined;
		connectionAbort?.abort();
		connectionAbort = undefined;
		waitingControls.clear();
		const status = cause instanceof SyncHttpError ? cause.status : undefined;
		const terminal = cause instanceof SyncHttpError && cause.terminal;
		dispatch({
			kind: 'disconnected',
			cause: {
				kind: terminal
					? status === 409 || status === 426
						? 'release-mismatch'
						: 'terminal'
					: 'transport',
				message: cause instanceof Error ? cause.message : String(cause),
				at
			}
		});
	};

	const openStream = (): void => {
		if (!started || stream !== undefined) return;
		stream = openSyncSse({
			url: options.streamUrl,
			onReady: async (ready) => {
				connectionId = ready.connectionId;
				connectionAbort = new AbortController();
				flushWaiting();
				await controlTail;
			},
			onFrame: async (frame) => {
				const expectedConnection = connectionId;
				await controlTail;
				if (expectedConnection === undefined || connectionId !== expectedConnection) return;
				dispatch({ kind: 'frame', payload: frame });
			},
			onDisconnect: disconnect
		});
	};

	const runControl = (effect: Exclude<ClientEffect, { readonly kind: 'push' }>): void => {
		const id = connectionId;
		if (id === undefined) {
			const key = effect.kind === 'connect' ? 'connect' : `revalidate:${effect.query.key}`;
			waitingControls.set(key, effect);
			openStream();
			return;
		}
		const request: SyncConnectRequest =
			effect.kind === 'connect'
				? requestOf(effect)
				: {
						...(state.head === undefined ? {} : { head: state.head }),
						queries: [effect.query],
						released: [],
						pending: [...effect.pending]
					};
		controlTail = controlTail
			.catch(report)
			.then(async () => {
				if (connectionId !== id) return;
				const response = await options.http.connect(id, request, connectionAbort?.signal);
				if (connectionId !== id) return;
				dispatch({ kind: 'connected', response, at: Date.now() });
			})
			.catch((cause) => {
				if (connectionId !== id) return;
				report(cause);
				disconnect(cause);
			});
	};

	const runPush = (writeId: CollectionMutationIdempotencyKey): void => {
		const id = connectionId;
		const write = state.writes.get(writeId);
		if (write === undefined) return;
		if (id === undefined || state.link !== 'live') {
			openStream();
			return;
		}
		void options.http
			.push(
				{
					connectionId: id,
					...write.request
				},
				connectionAbort?.signal
			)
			.catch((cause) => {
				if (connectionId !== id) return;
				report(cause);
				if (cause instanceof SyncHttpError && cause.terminal) disconnect(cause);
			});
	};

	const runEffect = (effect: ClientEffect): void => {
		if (effect.kind === 'push') runPush(effect.writeId);
		else runControl(effect);
	};

	const flushWaiting = (): void => {
		const controls = [...waitingControls.values()];
		waitingControls.clear();
		for (const effect of controls) runEffect(effect);
	};

	function dispatch(event: ClientEvent): void {
		const [next, effects] = step(state, event);
		state = next;
		if (event.kind === 'frame') options.onOutcomes?.(event.payload.outcomes, state);
		else if (event.kind === 'connected') options.onOutcomes?.(event.response.outcomes, state);
		publish();
		for (const effect of effects) runEffect(effect);
		schedule();
	}

	return {
		start: () => {
			if (started) return;
			started = true;
			openStream();
			dispatch({ kind: 'tick', now: Date.now() });
		},
		current: () => state,
		subscribe: (listener) => {
			listeners.add(listener);
			listener(state);
			return () => listeners.delete(listener);
		},
		mount: (input, seed) => {
			const key = stableKey(input);
			dispatch({
				kind: 'mounted',
				key,
				input,
				...(seed === undefined ? {} : { seed })
			});
			let released = false;
			return {
				key,
				release: () => {
					if (released) return;
					released = true;
					dispatch({ kind: 'unmounted', key, at: Date.now() });
				}
			};
		},
		enqueue: (request) => dispatch({ kind: 'writeEnqueued', request, at: Date.now() })
	};
};
