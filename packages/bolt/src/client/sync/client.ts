import type {
	CollectionMutationIdempotencyKey,
	CollectionMutateRequest,
	SyncApplyFrame,
	SyncConnectRequest,
	SyncConnectResponse,
	SyncExtendPrefixRequest,
	SyncExtendPrefixResponse,
	SyncOutcome,
	SyncQueryInput
} from '@norbital-ai/bolt-protocol';
import { getErrorMessage } from '@norbital-ai/std';
import { stableKey } from '../live-query/stable-key.js';
import type { BrowserSyncScope } from './sse-driver.js';
import { SyncHttpError } from './http-driver.js';
import {
	DETACH_GRACE_MS,
	STALE_WRITE_MS,
	type ClientEffect,
	type ClientEvent,
	type ClientState,
	initialClientState,
	step
} from './machine.js';

export type MountedLiveQuery = Readonly<{
	readonly key: string;
	readonly extend: (requestedPrefix: number) => void;
	readonly detach: () => void;
}>;

export type SyncAttachmentFailureKind = 'transport' | 'terminal' | 'prefix-reset';

export class SyncAttachmentError extends Error {
	readonly kind: SyncAttachmentFailureKind;

	constructor(kind: SyncAttachmentFailureKind, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = 'SyncAttachmentError';
		this.kind = kind;
	}
}

export type SyncWorkspaceAttachmentListener = Readonly<{
	readonly onFrame: (frame: SyncApplyFrame) => void | Promise<void>;
	readonly onDisconnect: (cause: SyncAttachmentError) => void;
}>;

export type SyncWorkspaceAttachment = Readonly<{
	readonly scope: BrowserSyncScope;
	readonly register: (
		request: SyncConnectRequest,
		signal?: AbortSignal
	) => Promise<SyncConnectResponse>;
	readonly extend: (
		request: SyncExtendPrefixRequest,
		signal?: AbortSignal
	) => Promise<SyncExtendPrefixResponse>;
	readonly push: (request: CollectionMutateRequest, signal?: AbortSignal) => Promise<void>;
	readonly subscribe: (listener: SyncWorkspaceAttachmentListener) => () => void;
}>;

export type SyncClient = Readonly<{
	readonly start: () => void;
	readonly attach: (attachment: SyncWorkspaceAttachment) => () => void;
	readonly shutdown: (message?: string) => void;
	readonly current: () => ClientState;
	readonly subscribe: (listener: (state: ClientState) => void) => () => void;
	readonly mount: (input: SyncQueryInput) => MountedLiveQuery;
	readonly enqueue: (request: CollectionMutateRequest) => void;
}>;

export type SyncClientOptions = Readonly<{
	readonly scope: BrowserSyncScope;
	readonly onOutcomes?: (outcomes: ReadonlyArray<SyncOutcome>, state: ClientState) => void;
	readonly onError?: (cause: unknown) => void;
}>;

type Timer = ReturnType<typeof setTimeout>;
type RegisterEffect = Extract<ClientEffect, { readonly kind: 'register' }>;
type ExtendEffect = Extract<ClientEffect, { readonly kind: 'extend' }>;

type ActiveAttachment = {
	readonly value: SyncWorkspaceAttachment;
	readonly abort: AbortController;
	unsubscribe: () => void;
	controlTail: Promise<void>;
};

const sameScope = (left: BrowserSyncScope, right: BrowserSyncScope): boolean =>
	left.workspaceId === right.workspaceId &&
	left.tenantId === right.tenantId &&
	left.environment === right.environment &&
	left.releaseId === right.releaseId;

const httpStatusOf = (cause: unknown): number | undefined => {
	if (cause instanceof SyncHttpError) return cause.status;
	if (cause instanceof SyncAttachmentError) return httpStatusOf(cause.cause);
	return undefined;
};

const attachmentError = (cause: unknown): SyncAttachmentError => {
	if (cause instanceof SyncAttachmentError) return cause;
	if (cause instanceof SyncHttpError) {
		const kind: SyncAttachmentFailureKind =
			cause.status === 409
				? 'prefix-reset'
				: cause.terminal && cause.status !== 410
					? 'terminal'
					: 'transport';
		return new SyncAttachmentError(kind, cause.message, { cause });
	}
	return new SyncAttachmentError('transport', getErrorMessage(cause), { cause });
};

/** Session/protocol refusals that the current EventSource cannot recover from. */
const sessionTerminalStatus = (status: number | undefined): boolean =>
	status === 401 || status === 403 || status === 426;

const ownedFrame = (frame: SyncApplyFrame, state: ClientState): SyncApplyFrame => ({
	updates: frame.updates.filter(({ queryKey }) => state.queries.has(queryKey)),
	resets: frame.resets.filter(({ queryKey }) => state.queries.has(queryKey)),
	outcomes: frame.outcomes.filter(({ id }) => state.writes.has(id))
});

const nextTickAt = (state: ClientState, attached: boolean): number | undefined => {
	const deadlines: number[] = [];
	if (attached && state.link === 'reconnecting') deadlines.push(state.reconnectAt);
	for (const query of state.queries.values()) {
		if (query.subscribers === 0 && query.detachedAt !== undefined) {
			deadlines.push(query.detachedAt + DETACH_GRACE_MS);
		}
	}
	if (attached && state.link === 'live') {
		for (const write of state.writes.values()) {
			deadlines.push(write.phase === 'queued' ? 0 : write.sentAt + STALE_WRITE_MS);
		}
	}
	return deadlines.length === 0 ? undefined : Math.min(...deadlines);
};

export const createSyncClient = (options: SyncClientOptions): SyncClient => {
	let state = initialClientState(Date.now());
	let timer: Timer | undefined;
	let started = false;
	let shutDown = false;
	let activeAttachment: ActiveAttachment | undefined;
	let waitingRegistration: RegisterEffect | undefined;
	const listeners = new Set<(state: ClientState) => void>();

	const report = (cause: unknown): void => options.onError?.(cause);

	const publish = (): void => {
		for (const listener of listeners) listener(state);
	};

	const schedule = (): void => {
		if (!started || shutDown) return;
		if (timer !== undefined) clearTimeout(timer);
		timer = undefined;
		const at = nextTickAt(state, activeAttachment !== undefined);
		if (at === undefined) return;
		timer = setTimeout(
			() => {
				timer = undefined;
				dispatch({ kind: 'tick', now: Date.now() });
			},
			Math.max(0, at - Date.now())
		);
	};

	const isActive = (attachment: ActiveAttachment): boolean =>
		activeAttachment === attachment && !shutDown;

	const releaseAttachment = (attachment: ActiveAttachment): void => {
		if (activeAttachment !== attachment) return;
		activeAttachment = undefined;
		waitingRegistration = undefined;
		attachment.abort.abort();
		try {
			attachment.unsubscribe();
		} catch (cause) {
			report(cause);
		}
	};

	const disconnectAttachment = (
		attachment: ActiveAttachment,
		failure: SyncAttachmentError,
		release = failure.kind === 'terminal'
	): void => {
		if (!isActive(attachment)) return;
		if (release) releaseAttachment(attachment);
		if (state.link === 'closed') {
			schedule();
			return;
		}
		if (!started && failure.kind !== 'terminal') return;
		if (failure.kind !== 'terminal' && state.link === 'reconnecting') {
			schedule();
			return;
		}
		dispatch({
			kind: 'disconnected',
			cause: {
				kind: failure.kind === 'terminal' ? 'terminal' : 'transport',
				message: failure.message,
				at: Date.now()
			}
		});
	};

	const enqueueControl = (
		attachment: ActiveAttachment,
		operation: () => Promise<void>,
		onFailure: (failure: SyncAttachmentError) => void
	): void => {
		attachment.controlTail = attachment.controlTail
			.catch(report)
			.then(async () => {
				if (isActive(attachment)) await operation();
			})
			.catch((cause) => {
				if (!isActive(attachment)) return;
				const failure = attachmentError(cause);
				report(failure);
				onFailure(failure);
			});
	};

	/**
	 * Registrations issued in one turn of the event loop ride one request. A component tree mounts
	 * its live queries synchronously; on a live link each mount used to send its own request, one
	 * guest dispatch each, serialised on the host lane. The batch is flushed on a microtask, so a
	 * query mounted in a later turn still registers on its own.
	 */
	let batched: RegisterEffect[] = [];
	const mergeRegistrations = (effects: ReadonlyArray<RegisterEffect>): RegisterEffect => {
		const queries = new Map<string, RegisterEffect['request']['queries'][number]>();
		const detached = new Set<string>();
		for (const effect of effects) {
			for (const query of effect.request.queries) queries.set(query.queryKey, query);
			for (const key of effect.request.detached) detached.add(key);
		}
		const last = effects[effects.length - 1]!;
		return {
			kind: 'register',
			request: {
				queries: [...queries.values()],
				detached: [...detached],
				pending: last.request.pending
			}
		};
	};

	const runRegister = (effect: RegisterEffect): void => {
		if (activeAttachment === undefined) {
			waitingRegistration = effect;
			return;
		}
		if (effect.alone === true) {
			sendRegistration(effect);
			return;
		}
		batched.push(effect);
		if (batched.length > 1) return;
		queueMicrotask(() => {
			const effects = batched;
			batched = [];
			if (effects.length === 0) return;
			sendRegistration(mergeRegistrations(effects));
		});
	};

	const sendRegistration = (effect: RegisterEffect): void => {
		const attachment = activeAttachment;
		if (attachment === undefined || shutDown) {
			waitingRegistration = effect;
			return;
		}
		const requestedKeys = effect.request.queries.map(({ queryKey }) => queryKey);
		enqueueControl(
			attachment,
			async () => {
				const response = await attachment.value.register(effect.request, attachment.abort.signal);
				if (isActive(attachment))
					dispatch({ kind: 'registered', response, at: Date.now(), requestedKeys });
			},
			(failure) => {
				if (sessionTerminalStatus(httpStatusOf(failure))) {
					disconnectAttachment(attachment, failure);
					return;
				}
				// A 400 is an authored refusal for the keys that were asked, on a live link and on
				// the request that opens one alike. It used to be terminal only when live: an opening
				// refusal fell through to the attachment's terminal disconnect, which closed the whole
				// client, so one query ordered by a range column left every later page unable to
				// mount anything ("Cannot mount a query on a closed Sync client"). The refusal is
				// that query's failure, the link stays, and nothing asks again. A 500/503/transport
				// failure is different: the EventSource is still the live one, and the next register
				// may succeed.
				if (httpStatusOf(failure) === 400) {
					dispatch({
						kind: 'registrationRejected',
						keys: requestedKeys,
						message: failure.message,
						terminal: true
					});
					return;
				}
				disconnectAttachment(attachment, failure);
			}
		);
	};

	const runExtend = (effect: ExtendEffect): void => {
		const attachment = activeAttachment;
		if (attachment === undefined) return;
		enqueueControl(
			attachment,
			async () => {
				const response = await attachment.value.extend(effect.request, attachment.abort.signal);
				if (isActive(attachment)) dispatch({ kind: 'extensionAccepted', response });
			},
			(failure) => {
				if (failure.kind === 'prefix-reset') {
					dispatch({
						kind: 'extensionRejected',
						queryKey: effect.request.queryKey,
						message: failure.message
					});
					return;
				}
				disconnectAttachment(attachment, failure);
			}
		);
	};

	const runPush = (writeId: CollectionMutationIdempotencyKey): void => {
		const attachment = activeAttachment;
		const write = state.writes.get(writeId);
		if (attachment === undefined || write === undefined || state.link !== 'live') return;
		void attachment.value.push(write.request, attachment.abort.signal).catch((cause) => {
			if (!isActive(attachment)) return;
			const failure = attachmentError(cause);
			report(failure);
			if (failure.kind === 'terminal') disconnectAttachment(attachment, failure);
		});
	};

	const runEffect = (effect: ClientEffect): void => {
		switch (effect.kind) {
			case 'register':
				runRegister(effect);
				return;
			case 'extend':
				runExtend(effect);
				return;
			case 'push':
				runPush(effect.writeId);
				return;
			case 'restart':
				report(new Error(effect.message));
		}
	};

	function dispatch(event: ClientEvent): void {
		if (shutDown) return;
		const [next, effects] = step(state, event);
		state = next;
		if (event.kind === 'frame' && state.link === 'live') {
			options.onOutcomes?.(event.payload.outcomes, state);
		} else if (event.kind === 'registered' && state.link === 'live') {
			options.onOutcomes?.(event.response.outcomes, state);
		}
		publish();
		for (const effect of effects) runEffect(effect);
		schedule();
	}

	return {
		start: () => {
			if (shutDown) throw new Error('Cannot start a shut down Sync client');
			if (started) return;
			started = true;
			if (activeAttachment !== undefined) dispatch({ kind: 'tick', now: Date.now() });
			else schedule();
		},
		attach: (value) => {
			if (shutDown || state.link === 'closed') {
				throw new Error('Cannot attach a closed Sync client');
			}
			if (!sameScope(options.scope, value.scope)) {
				throw new Error('Sync attachment scope does not match its workspace machine');
			}
			if (activeAttachment !== undefined) {
				throw new Error('A workspace Sync machine already has an active attachment');
			}
			const attachment: ActiveAttachment = {
				value,
				abort: new AbortController(),
				unsubscribe: () => undefined,
				controlTail: Promise.resolve()
			};
			activeAttachment = attachment;
			try {
				attachment.unsubscribe = value.subscribe({
					onFrame: (frame) => {
						attachment.controlTail = attachment.controlTail.catch(report).then(() => {
							if (isActive(attachment)) {
								const payload = ownedFrame(frame, state);
								if (
									payload.updates.length > 0 ||
									payload.resets.length > 0 ||
									payload.outcomes.length > 0
								) {
									dispatch({ kind: 'frame', payload, at: Date.now() });
								}
							}
						});
						return attachment.controlTail;
					},
					onDisconnect: (cause) => disconnectAttachment(attachment, cause)
				});
			} catch (cause) {
				releaseAttachment(attachment);
				throw cause;
			}
			const waiting = waitingRegistration;
			waitingRegistration = undefined;
			if (started) {
				if (waiting !== undefined) runRegister(waiting);
				else if (state.reconnectAt <= Date.now()) dispatch({ kind: 'tick', now: Date.now() });
				else schedule();
			}
			let detached = false;
			return () => {
				if (detached) return;
				detached = true;
				disconnectAttachment(
					attachment,
					new SyncAttachmentError('transport', 'Sync workspace attachment detached'),
					true
				);
			};
		},
		shutdown: (message = 'Sync workspace client shut down') => {
			if (shutDown) return;
			if (timer !== undefined) clearTimeout(timer);
			timer = undefined;
			const attachment = activeAttachment;
			if (attachment !== undefined) releaseAttachment(attachment);
			waitingRegistration = undefined;
			if (state.link !== 'closed') {
				const [next] = step(state, {
					kind: 'disconnected',
					cause: { kind: 'terminal', message, at: Date.now() }
				});
				state = next;
			}
			shutDown = true;
			publish();
		},
		current: () => state,
		subscribe: (listener) => {
			listeners.add(listener);
			listener(state);
			return () => listeners.delete(listener);
		},
		mount: (input) => {
			if (shutDown || state.link === 'closed') {
				throw new Error('Cannot mount a query on a closed Sync client');
			}
			const key = stableKey(input);
			dispatch({ kind: 'mounted', key, input });
			let detached = false;
			return {
				key,
				extend: (requestedPrefix) => {
					if (detached || shutDown) return;
					dispatch({ kind: 'extendRequested', key, requestedPrefix });
				},
				detach: () => {
					if (detached || shutDown) return;
					detached = true;
					dispatch({ kind: 'detached', key, at: Date.now() });
				}
			};
		},
		enqueue: (request) => {
			if (shutDown || state.link === 'closed') {
				throw new Error('Cannot enqueue a mutation on a closed Sync client');
			}
			dispatch({ kind: 'writeEnqueued', request, at: Date.now() });
		}
	};
};
