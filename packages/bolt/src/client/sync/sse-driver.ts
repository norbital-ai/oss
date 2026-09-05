import {
	EnvironmentName,
	ReleaseId,
	SyncApplyFrame as SyncApplyFrameSchema,
	SyncScopedApplyFrame as SyncScopedApplyFrameSchema,
	TenantId
} from '@norbital-ai/bolt-protocol';
import type { SyncApplyFrame, SyncScope } from '@norbital-ai/bolt-protocol';
import { getErrorMessage } from '@norbital-ai/std';
import { Option, Schema } from 'effect';
import type { WorkspaceSession } from '../session.js';
import { SyncAttachmentError } from './client.js';
import type { SyncWorkspaceAttachment, SyncWorkspaceAttachmentListener } from './client.js';
import type { SyncHttpDriver } from './http-driver.js';

export type { SyncApplyFrame as SyncClientApplyFrame };
export type BrowserSyncScope = Readonly<SyncScope & Pick<WorkspaceSession, 'workspaceId'>>;
export type BrowserSyncProfileElection = Readonly<Pick<WorkspaceSession, 'syncPrincipal'>>;
export type EventSourceLike = {
	readonly addEventListener: (
		type: string,
		listener: (event: Readonly<{ readonly data?: string }>) => void
	) => void;
	readonly close: () => void;
	onerror: ((event: unknown) => void) | null;
};
export type { SyncHttpDriver as BrowserSyncWorkspaceControls };
export type BrowserSyncWorkspaceBindingOptions = Readonly<{
	readonly scope: BrowserSyncScope;
	readonly controls: SyncHttpDriver;
}>;
export type BrowserSyncWorkspaceBinding = Readonly<{
	readonly attachment: SyncWorkspaceAttachment;
	readonly close: () => void;
}>;
export type BrowserSyncBrokerOptions = Readonly<{
	readonly election: BrowserSyncProfileElection;
	readonly streamUrl: string;
	readonly source?: (url: string) => EventSourceLike;
	readonly maxBufferedFrames?: number;
	readonly onError?: (cause: unknown) => void;
}>;
export type BrowserSyncBroker = Readonly<{
	readonly attachWorkspace: (
		options: BrowserSyncWorkspaceBindingOptions
	) => BrowserSyncWorkspaceBinding;
	readonly close: () => void;
}>;

const PROTOCOL = 1 as const;
const HEARTBEAT_MS = 2_000;
const LEASE_MS = 30_000;

const nonempty = (label: string, value: string): string => {
	const trimmed = value.trim();
	if (trimmed.length === 0) throw new Error(`${label} must be non-empty`);
	return trimmed;
};
const tupleKey = (values: ReadonlyArray<string>): string =>
	values.map((value) => `${value.length}:${value}`).join('|');
const profileKeyOf = (election: BrowserSyncProfileElection): string =>
	`@norbital-ai/bolt/sync-browser-profile/v1/${tupleKey([
		nonempty('Browser sync principal', election.syncPrincipal)
	])}`;
const wireKeyOf = (scope: SyncScope): string =>
	tupleKey([
		nonempty('Browser sync tenant id', scope.tenantId),
		nonempty('Browser sync environment', scope.environment),
		nonempty('Browser sync release id', scope.releaseId)
	]);

const BrowserSyncScopeSchema = Schema.Struct({
	workspaceId: Schema.NonEmptyString,
	tenantId: TenantId,
	environment: EnvironmentName,
	releaseId: ReleaseId
});

const BrokerEnvelopeFields = {
	protocolVersion: Schema.Literal(PROTOCOL),
	profileKey: Schema.NonEmptyString,
	memberId: Schema.NonEmptyString,
	sentAtEpochMs: Schema.Number.check(Schema.isFinite())
};

const BrokerMessageSchema = Schema.Union([
	Schema.Struct({
		...BrokerEnvelopeFields,
		kind: Schema.Literal('member.presence'),
		scopes: Schema.Array(BrowserSyncScopeSchema)
	}),
	Schema.Struct({
		...BrokerEnvelopeFields,
		kind: Schema.Literal('member.depart')
	}),
	Schema.Struct({
		...BrokerEnvelopeFields,
		kind: Schema.Literal('owner.heartbeat'),
		connectionId: Schema.NonEmptyString
	}),
	Schema.Struct({
		...BrokerEnvelopeFields,
		kind: Schema.Literal('owner.release'),
		connectionId: Schema.NonEmptyString
	}),
	Schema.Struct({
		...BrokerEnvelopeFields,
		kind: Schema.Literal('owner.scope-ready'),
		connectionId: Schema.NonEmptyString,
		targetMemberId: Schema.NonEmptyString,
		scope: BrowserSyncScopeSchema
	}),
	Schema.Struct({
		...BrokerEnvelopeFields,
		kind: Schema.Literal('sync.frame'),
		connectionId: Schema.NonEmptyString,
		scope: BrowserSyncScopeSchema,
		frame: SyncApplyFrameSchema
	})
]);
type BrokerMessage = typeof BrokerMessageSchema.Type;

const decodeBrokerMessage = (value: unknown): BrokerMessage | undefined => {
	const decoded = Schema.decodeUnknownOption(BrokerMessageSchema)(value);
	return Option.isSome(decoded) ? decoded.value : undefined;
};

const eventData = (event: unknown): string | undefined => {
	// repository-health:allow GUARD2 -- `event` is a browser EventSource MessageEvent, a platform object this layer only ever reads `data` from; there is no schema to decode it against.
	if (event === null || typeof event !== 'object' || !('data' in event)) return undefined;
	const data = Reflect.get(event, 'data');
	return data === undefined ? undefined : String(data);
};
const browserEventSource = (url: string): EventSourceLike => {
	const source = new EventSource(url, { withCredentials: true });
	return {
		addEventListener: (type, listener) =>
			source.addEventListener(type, (event) => {
				const data = eventData(event);
				listener(data === undefined ? {} : { data });
			}),
		close: () => source.close(),
		set onerror(listener: ((event: unknown) => void) | null) {
			source.onerror = listener;
		}
	};
};
const newId = (label: string): string => {
	// repository-health:allow GUARD2 -- this is a WebCrypto capability probe on the browser's `crypto` global, not a data-boundary check.
	if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function')
		throw new Error(`Browser Sync requires crypto.randomUUID for its ${label}`);
	return crypto.randomUUID();
};
const streamUrl = (url: string, connectionId: string): string => {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		// repository-health:allow GUARD2 -- this is a `location` global capability probe for relative-URL resolution in the browser runtime, not a data-boundary check.
		if (typeof location === 'undefined')
			throw new Error('Browser Sync requires a browser location to resolve a relative stream URL');
		parsed = new URL(url, location.href);
	}
	parsed.searchParams.set('connectionId', connectionId);
	return parsed.toString();
};

type TransportListener = Readonly<{
	readonly onFrame: (frame: SyncApplyFrame) => void | Promise<void>;
	readonly onDisconnect: (cause: SyncAttachmentError) => void;
}>;
type Transport = Readonly<{
	readonly connectionId: string;
	readonly attach: (scope: BrowserSyncScope, listener: TransportListener) => () => void;
	readonly close: (cause?: SyncAttachmentError) => void;
}>;

const openTransport = (options: {
	readonly url: string;
	readonly source?: (url: string) => EventSourceLike;
	readonly maxBufferedFrames?: number;
	readonly onOpen: (connectionId: string) => void | Promise<void>;
	readonly onDisconnect: (cause: SyncAttachmentError) => void;
}): Transport => {
	const connectionId = newId('physical connection id');
	const source = (options.source ?? browserEventSource)(streamUrl(options.url, connectionId));
	const limit = Math.max(1, Math.floor(options.maxBufferedFrames ?? 64));
	const queue: Array<() => Promise<void>> = [];
	const lanes = new Map<string, TransportListener>();
	let draining = false;
	let closed = false;
	let opened = false;

	const terminate = (cause: SyncAttachmentError, report: boolean): void => {
		if (closed) return;
		closed = true;
		queue.length = 0;
		source.onerror = null;
		try {
			source.close();
		} finally {
			const attached = [...lanes.values()];
			lanes.clear();
			for (const listener of attached) {
				try {
					listener.onDisconnect(cause);
				} catch {
					/* keep closing remaining workspace lanes */
				}
			}
		}
		if (report) options.onDisconnect(cause);
	};
	const fail = (cause: unknown): void => {
		terminate(new SyncAttachmentError('transport', getErrorMessage(cause), { cause }), true);
	};
	const drain = (): void => {
		if (draining || closed) return;
		draining = true;
		void (async () => {
			try {
				for (;;) {
					const next = queue.shift();
					if (next === undefined || closed) return;
					await next();
				}
			} catch (cause) {
				fail(cause);
			} finally {
				draining = false;
				if (queue.length > 0 && !closed) drain();
			}
		})();
	};
	const enqueue = (task: () => void | Promise<void>): void => {
		if (closed) return;
		if (queue.length >= limit) {
			fail(new Error(`Sync stream exceeded its ${limit}-frame browser buffer`));
			return;
		}
		queue.push(async () => task());
		drain();
	};

	source.addEventListener('open', () => {
		if (opened) {
			fail(new Error('Sync event stream opened more than once'));
			return;
		}
		opened = true;
		enqueue(() => options.onOpen(connectionId));
	});
	source.addEventListener('apply', (event) => {
		if (!opened) {
			fail(new Error('Sync stream sent an apply frame before opening'));
			return;
		}
		try {
			const envelope = Schema.decodeUnknownSync(SyncScopedApplyFrameSchema)(
				JSON.parse(eventData(event) ?? '')
			);
			const key = wireKeyOf(envelope.scope);
			const listener = lanes.get(key);
			if (listener === undefined) return;
			enqueue(() => {
				if (lanes.get(key) !== listener) return;
				return listener.onFrame(envelope.frame);
			});
		} catch (cause) {
			fail(cause);
		}
	});
	source.onerror = () => fail(new Error('Sync event stream disconnected'));

	return {
		connectionId,
		attach: (scope, listener) => {
			if (closed) throw new Error('Cannot attach a workspace to a closed Sync transport');
			const key = wireKeyOf(scope);
			if (lanes.has(key))
				throw new Error('The Sync transport already has a listener attached for this wire scope');
			lanes.set(key, listener);
			let detached = false;
			return () => {
				if (detached) return;
				detached = true;
				if (lanes.get(key) === listener) lanes.delete(key);
			};
		},
		close: (cause = new SyncAttachmentError('transport', 'Browser Sync transport closed')) =>
			terminate(cause, false)
	};
};

type Binding = {
	readonly scopeKey: string;
	readonly abort: AbortController;
	readonly listeners: Set<SyncWorkspaceAttachmentListener>;
	closed: boolean;
};
type LocalScope = { readonly scope: BrowserSyncScope; readonly bindings: Set<Binding> };
type Lease = { readonly connectionId: string; readonly signal: AbortSignal };
type Waiter = {
	readonly binding: Binding;
	readonly resolve: (lease: Lease) => void;
	readonly reject: (cause: unknown) => void;
	removeAbort: () => void;
};
type Owner = {
	readonly lanes: Map<string, { readonly scope: BrowserSyncScope; readonly detach: () => void }>;
	readonly finish: () => void;
	transport?: Transport;
	connectionId?: string;
	finished: boolean;
};

export const createBrowserSyncBroker = (options: BrowserSyncBrokerOptions): BrowserSyncBroker => {
	// repository-health:allow GUARD2 -- these are Web Locks and BroadcastChannel capability probes on browser runtime globals, not data-boundary checks.
	if (typeof navigator === 'undefined' || navigator.locks === undefined)
		throw new Error('Browser Sync requires the standard Web Locks API');
	if (typeof globalThis.BroadcastChannel === 'undefined')
		throw new Error('Browser Sync requires the standard BroadcastChannel API');
	const locks = navigator.locks;
	const profileKey = profileKeyOf(options.election);
	const channel = new BroadcastChannel(profileKey);
	const memberId = newId('broker member id');
	const electionAbort = new AbortController();
	const localScopes = new Map<string, LocalScope>();
	const remotes = new Map<
		string,
		{ lastSeenAt: number; scopes: ReadonlyArray<BrowserSyncScope> }
	>();
	const waiters = new Set<Waiter>();
	const ready = new Set<string>();
	let current:
		| {
				ownerMemberId: string;
				connectionId: string;
				announcedAt: number;
				lastSeenAt: number;
				abort: AbortController;
		  }
		| undefined;
	let owner: Owner | undefined;
	let closed = false;
	let electionTimer: ReturnType<typeof setTimeout> | undefined;
	const report = (cause: unknown): void => options.onError?.(cause);
	const eachListener = (
		bindings: Iterable<Binding>,
		fn: (listener: SyncWorkspaceAttachmentListener) => void | Promise<void>
	): void => {
		for (const binding of bindings)
			for (const listener of [...binding.listeners]) {
				try {
					const result = fn(listener);
					if (result instanceof Promise) result.catch(report);
				} catch (cause) {
					report(cause);
				}
			}
	};
	const envelope = (): Pick<
		BrokerMessage,
		'protocolVersion' | 'profileKey' | 'memberId' | 'sentAtEpochMs'
	> => ({
		protocolVersion: PROTOCOL,
		profileKey,
		memberId,
		sentAtEpochMs: Date.now()
	});
	const post = (message: BrokerMessage): void => {
		if (closed) return;
		try {
			channel.postMessage(message);
		} catch (cause) {
			report(cause);
		}
	};
	const presence = (): void => {
		post({
			...envelope(),
			kind: 'member.presence',
			scopes: [...localScopes.values()].map(({ scope }) => scope)
		});
	};
	const leaseOf = (binding: Binding): Lease | undefined => {
		if (binding.closed || !ready.has(binding.scopeKey) || current === undefined) return undefined;
		return { connectionId: current.connectionId, signal: current.abort.signal };
	};
	const notifyDisconnect = (cause: SyncAttachmentError): void => {
		for (const { bindings } of localScopes.values())
			eachListener(bindings, (listener) => listener.onDisconnect(cause));
	};
	const clearConnection = (
		cause: SyncAttachmentError,
		expected?: { readonly ownerMemberId: string; readonly connectionId: string }
	): void => {
		if (
			current === undefined ||
			(expected !== undefined &&
				(current.ownerMemberId !== expected.ownerMemberId ||
					current.connectionId !== expected.connectionId))
		)
			return;
		current.abort.abort(cause);
		current = undefined;
		ready.clear();
		notifyDisconnect(cause);
	};
	const flushWaiters = (): void => {
		for (const waiter of [...waiters]) {
			const lease = leaseOf(waiter.binding);
			if (lease === undefined) continue;
			waiters.delete(waiter);
			waiter.removeAbort();
			waiter.resolve(lease);
		}
	};
	const markReady = (scope: BrowserSyncScope, connectionId: string): void => {
		if (current?.connectionId !== connectionId) return;
		const key = wireKeyOf(scope);
		if (!localScopes.has(key) || ready.has(key)) return;
		ready.add(key);
		flushWaiters();
	};
	const acceptHeartbeat = (
		ownerMemberId: string,
		connectionId: string,
		announcedAt: number
	): void => {
		const now = Date.now();
		if (current?.ownerMemberId === ownerMemberId && current.connectionId === connectionId) {
			current = { ...current, lastSeenAt: now };
			presence();
			return;
		}
		if (current !== undefined) {
			const older =
				announcedAt < current.announcedAt ||
				(announcedAt === current.announcedAt && ownerMemberId <= current.ownerMemberId);
			if (older) return;
			clearConnection(
				new SyncAttachmentError('transport', 'Browser Sync physical connection rotated')
			);
		}
		current = {
			ownerMemberId,
			connectionId,
			announcedAt,
			lastSeenAt: now,
			abort: new AbortController()
		};
		ready.clear();
		presence();
	};
	const deliver = (scope: BrowserSyncScope, frame: SyncApplyFrame): void => {
		const local = localScopes.get(wireKeyOf(scope));
		if (local === undefined) return;
		eachListener(local.bindings, (listener) => listener.onFrame(frame));
	};
	const ownerHeartbeat = (active: Owner): void => {
		if (active.finished || active.connectionId === undefined) return;
		const sent = envelope();
		acceptHeartbeat(memberId, active.connectionId, sent.sentAtEpochMs);
		post({ ...sent, kind: 'owner.heartbeat', connectionId: active.connectionId });
	};
	const releaseOwner = (active: Owner, cause: SyncAttachmentError): void => {
		if (active.finished) return;
		active.finished = true;
		if (active.connectionId !== undefined) {
			post({ ...envelope(), kind: 'owner.release', connectionId: active.connectionId });
			clearConnection(cause, { ownerMemberId: memberId, connectionId: active.connectionId });
		}
		active.finish();
	};
	const desiredScopes = () => {
		const desired = new Map<string, { scope: BrowserSyncScope; members: Set<string> }>();
		const add = (scope: BrowserSyncScope, id: string): void => {
			const key = wireKeyOf(scope);
			const existing = desired.get(key);
			if (existing === undefined) desired.set(key, { scope, members: new Set([id]) });
			else existing.members.add(id);
		};
		for (const { scope } of localScopes.values()) add(scope, memberId);
		for (const [id, remote] of remotes) for (const scope of remote.scopes) add(scope, id);
		return desired;
	};
	const reconcile = (): void => {
		const transport = owner?.transport;
		const connectionId = owner?.connectionId;
		if (
			owner === undefined ||
			owner.finished ||
			transport === undefined ||
			connectionId === undefined
		)
			return;
		const desired = desiredScopes();
		for (const [key, lane] of owner.lanes) {
			if (desired.has(key)) continue;
			lane.detach();
			owner.lanes.delete(key);
		}
		for (const [key, wanted] of desired) {
			if (!owner.lanes.has(key)) {
				try {
					const detach = transport.attach(wanted.scope, {
						onFrame: (frame) => {
							deliver(wanted.scope, frame);
							post({
								...envelope(),
								kind: 'sync.frame',
								connectionId,
								scope: wanted.scope,
								frame
							});
						},
						onDisconnect: (cause) => {
							if (owner !== undefined) releaseOwner(owner, cause);
						}
					});
					owner.lanes.set(key, { scope: wanted.scope, detach });
				} catch (cause) {
					report(cause);
					continue;
				}
			}
			for (const id of wanted.members) {
				if (id === memberId) markReady(wanted.scope, connectionId);
				else
					post({
						...envelope(),
						kind: 'owner.scope-ready',
						connectionId,
						targetMemberId: id,
						scope: wanted.scope
					});
			}
		}
	};
	const runOwner = async (): Promise<void> => {
		let resolveOwner: () => void = () => undefined;
		const done = new Promise<void>((resolve) => {
			resolveOwner = resolve;
		});
		let active: Owner | undefined;
		try {
			active = { lanes: new Map(), finish: resolveOwner, finished: false };
			owner = active;
			const transport = openTransport({
				url: options.streamUrl,
				...(options.source === undefined ? {} : { source: options.source }),
				...(options.maxBufferedFrames === undefined
					? {}
					: { maxBufferedFrames: options.maxBufferedFrames }),
				onOpen: (connectionId) => {
					if (active === undefined || active.finished || closed) return;
					active.connectionId = connectionId;
					ownerHeartbeat(active);
					reconcile();
				},
				onDisconnect: (cause) => {
					if (active !== undefined) releaseOwner(active, cause);
				}
			});
			active.transport = transport;
			reconcile();
			await done;
		} catch (cause) {
			report(cause);
		} finally {
			if (active !== undefined) {
				active.finished = true;
				for (const lane of active.lanes.values()) lane.detach();
				active.lanes.clear();
				active.transport?.close(
					new SyncAttachmentError('transport', 'Browser Sync profile ownership ended')
				);
				if (owner === active) owner = undefined;
			}
		}
	};
	const queueElection = (): void => {
		if (closed) return;
		void locks
			.request(profileKey, { mode: 'exclusive', signal: electionAbort.signal }, async (lock) => {
				if (lock === null || closed) return;
				await runOwner();
			})
			.catch((cause) => {
				if (!closed) report(cause);
			})
			.finally(() => {
				if (!closed) electionTimer = setTimeout(queueElection, HEARTBEAT_MS);
			});
	};
	const onMessage = (event: MessageEvent<unknown>): void => {
		if (closed) return;
		const message = decodeBrokerMessage(event.data);
		if (message === undefined || message.profileKey !== profileKey || message.memberId === memberId)
			return;
		switch (message.kind) {
			case 'member.presence':
				remotes.set(message.memberId, { lastSeenAt: Date.now(), scopes: message.scopes });
				reconcile();
				return;
			case 'member.depart':
				remotes.delete(message.memberId);
				if (current?.ownerMemberId === message.memberId)
					clearConnection(
						new SyncAttachmentError('transport', 'Browser Sync profile owner departed')
					);
				reconcile();
				return;
			case 'owner.heartbeat':
				acceptHeartbeat(message.memberId, message.connectionId, message.sentAtEpochMs);
				return;
			case 'owner.release':
				clearConnection(
					new SyncAttachmentError('transport', 'Browser Sync physical connection released'),
					{ ownerMemberId: message.memberId, connectionId: message.connectionId }
				);
				return;
			case 'owner.scope-ready':
				if (
					message.targetMemberId === memberId &&
					current?.ownerMemberId === message.memberId &&
					current.connectionId === message.connectionId
				)
					markReady(message.scope, message.connectionId);
				return;
			case 'sync.frame':
				if (
					current?.ownerMemberId === message.memberId &&
					current.connectionId === message.connectionId &&
					ready.has(wireKeyOf(message.scope))
				)
					deliver(message.scope, message.frame);
				return;
			default: {
				const exhausted: never = message;
				void exhausted;
			}
		}
	};
	channel.addEventListener('message', onMessage);
	const heartbeat = setInterval(() => {
		if (closed) return;
		presence();
		if (owner !== undefined) ownerHeartbeat(owner);
		const now = Date.now();
		for (const [id, remote] of remotes) if (now - remote.lastSeenAt > LEASE_MS) remotes.delete(id);
		if (current !== undefined && now - current.lastSeenAt > LEASE_MS)
			clearConnection(
				new SyncAttachmentError('transport', 'Browser Sync profile owner heartbeat expired')
			);
		reconcile();
	}, HEARTBEAT_MS);
	presence();
	queueElection();

	const awaitLease = (binding: Binding, signal?: AbortSignal): Promise<Lease> => {
		const available = leaseOf(binding);
		if (available !== undefined) return Promise.resolve(available);
		if (closed || binding.closed)
			return Promise.reject(
				new SyncAttachmentError('terminal', 'Browser Sync workspace binding is closed')
			);
		if (signal?.aborted === true)
			return Promise.reject(signal.reason ?? new Error('Browser Sync connection wait was aborted'));
		return new Promise<Lease>((resolve, reject) => {
			const waiter: Waiter = { binding, resolve, reject, removeAbort: () => undefined };
			if (signal !== undefined) {
				const onAbort = (): void => {
					waiters.delete(waiter);
					waiter.removeAbort();
					reject(signal.reason ?? new Error('Browser Sync connection wait was aborted'));
				};
				signal.addEventListener('abort', onAbort, { once: true });
				waiter.removeAbort = () => signal.removeEventListener('abort', onAbort);
			}
			waiters.add(waiter);
		});
	};
	const runControl = async <A>(
		binding: Binding,
		signal: AbortSignal | undefined,
		operation: (connectionId: string, signal: AbortSignal) => Promise<A>
	): Promise<A> => {
		const lease = await awaitLease(binding, signal);
		const combined = new AbortController();
		const removals: Array<() => void> = [];
		for (const source of [
			binding.abort.signal,
			lease.signal,
			...(signal === undefined ? [] : [signal])
		]) {
			const onAbort = (): void => combined.abort(source.reason);
			if (source.aborted) onAbort();
			else {
				source.addEventListener('abort', onAbort, { once: true });
				removals.push(() => source.removeEventListener('abort', onAbort));
			}
		}
		try {
			return await operation(lease.connectionId, combined.signal);
		} finally {
			for (const remove of removals) remove();
		}
	};
	const closeBinding = (binding: Binding): void => {
		if (binding.closed) return;
		binding.closed = true;
		for (const waiter of [...waiters]) {
			if (waiter.binding !== binding) continue;
			waiters.delete(waiter);
			waiter.removeAbort();
			waiter.reject(new SyncAttachmentError('terminal', 'Browser Sync workspace binding closed'));
		}
		const terminal = new SyncAttachmentError('terminal', 'Browser Sync workspace binding closed');
		binding.abort.abort(terminal);
		eachListener([binding], (listener) => listener.onDisconnect(terminal));
		binding.listeners.clear();
		const local = localScopes.get(binding.scopeKey);
		if (local !== undefined) {
			local.bindings.delete(binding);
			if (local.bindings.size === 0) {
				localScopes.delete(binding.scopeKey);
				ready.delete(binding.scopeKey);
			}
		}
		presence();
		reconcile();
	};

	return {
		attachWorkspace: ({ scope, controls }) => {
			if (closed) throw new Error('Cannot attach a workspace to a closed browser Sync broker');
			const scopeKey = wireKeyOf(scope);
			const binding: Binding = {
				scopeKey,
				abort: new AbortController(),
				listeners: new Set(),
				closed: false
			};
			const existing = localScopes.get(scopeKey);
			if (existing === undefined)
				localScopes.set(scopeKey, { scope, bindings: new Set([binding]) });
			else existing.bindings.add(binding);
			presence();
			reconcile();
			return {
				attachment: {
					scope,
					register: (request, signal) =>
						runControl(binding, signal, (connectionId, controlSignal) =>
							controls.register(connectionId, request, controlSignal)
						),
					extend: (request, signal) =>
						runControl(binding, signal, (connectionId, controlSignal) =>
							controls.extend(connectionId, request, controlSignal)
						),
					push: (request, signal) =>
						runControl(binding, signal, async (connectionId, controlSignal) => {
							await controls.push({ ...request, connectionId }, controlSignal);
						}),
					subscribe: (listener) => {
						if (closed || binding.closed)
							throw new Error('Cannot subscribe to a closed browser Sync workspace binding');
						binding.listeners.add(listener);
						return () => binding.listeners.delete(listener);
					}
				},
				close: () => closeBinding(binding)
			};
		},
		close: () => {
			if (closed) return;
			if (owner !== undefined)
				releaseOwner(owner, new SyncAttachmentError('terminal', 'Browser Sync broker closed'));
			post({ ...envelope(), kind: 'member.depart' });
			closed = true;
			electionAbort.abort();
			if (electionTimer !== undefined) clearTimeout(electionTimer);
			clearInterval(heartbeat);
			for (const { bindings } of [...localScopes.values()])
				for (const binding of [...bindings]) closeBinding(binding);
			for (const waiter of [...waiters]) {
				waiters.delete(waiter);
				waiter.removeAbort();
				waiter.reject(new SyncAttachmentError('terminal', 'Browser Sync broker closed'));
			}
			channel.close();
		}
	};
};
