import {
	EnvironmentName,
	ReleaseId,
	SYNC_CONNECTION_HEADER,
	TenantId,
	syncJsonByteLength
} from '@norbital-ai/bolt-protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSyncHttpDriver } from '../../src/client/sync/http-driver.js';
import {
	createBrowserSyncBroker,
	type BrowserSyncBroker,
	type BrowserSyncScope,
	type BrowserSyncWorkspaceControls,
	type EventSourceLike
} from '../../src/client/sync/sse-driver.js';

const fakeSource = () => {
	const listeners = new Map<string, (event: { data?: string }) => void>();
	let errors: ((event: unknown) => void) | null = null;
	let closed = 0;
	const source: EventSourceLike = {
		addEventListener: (type, listener) => listeners.set(type, listener),
		close: () => {
			closed += 1;
		},
		get onerror() {
			return errors;
		},
		set onerror(listener) {
			errors = listener;
		}
	};
	return {
		source,
		emit: (type: string, value: unknown) =>
			listeners.get(type)?.({ data: JSON.stringify(value) }),
		fail: (cause: unknown) => errors?.(cause),
		closed: () => closed
	};
};

type FakeLockRequest = {
	readonly callback: (lock: Lock | null) => unknown;
	readonly reject: (cause: unknown) => void;
	readonly resolve: (value: unknown) => void;
	readonly signal?: AbortSignal;
	removeAbort: () => void;
};

/** One browser profile's exclusive-lock namespace. */
class FakeLockNamespace {
	readonly manager: LockManager;
	private readonly queues = new Map<string, Array<FakeLockRequest>>();
	private readonly held = new Set<string>();

	constructor() {
		this.manager = {
			request: ((
				name: string,
				options: Readonly<{ readonly signal?: AbortSignal }>,
				callback: (lock: Lock | null) => unknown
			) => this.request(name, options, callback)) as unknown as LockManager['request']
		} as unknown as LockManager;
	}

	private request(
		name: string,
		options: Readonly<{ readonly signal?: AbortSignal }>,
		callback: (lock: Lock | null) => unknown
	): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const request: FakeLockRequest = {
				callback,
				resolve,
				reject,
				...(options.signal === undefined ? {} : { signal: options.signal }),
				removeAbort: () => undefined
			};
			if (options.signal !== undefined) {
				const onAbort = (): void => {
					const queue = this.queues.get(name);
					const index = queue?.indexOf(request) ?? -1;
					if (index < 0 || queue === undefined) return;
					queue.splice(index, 1);
					request.removeAbort();
					reject(options.signal?.reason ?? new Error('lock request aborted'));
				};
				options.signal.addEventListener('abort', onAbort, { once: true });
				request.removeAbort = () => options.signal?.removeEventListener('abort', onAbort);
			}
			const queue = this.queues.get(name) ?? [];
			queue.push(request);
			this.queues.set(name, queue);
			this.drain(name);
		});
	}

	private drain(name: string): void {
		if (this.held.has(name)) return;
		const queue = this.queues.get(name);
		const request = queue?.shift();
		if (request === undefined) return;
		if (request.signal?.aborted === true) {
			request.removeAbort();
			request.reject(request.signal.reason ?? new Error('lock request aborted'));
			this.drain(name);
			return;
		}
		request.removeAbort();
		this.held.add(name);
		let result: unknown;
		try {
			result = request.callback({ name, mode: 'exclusive' } as Lock);
		} catch (cause) {
			request.reject(cause);
			this.release(name);
			return;
		}
		void Promise.resolve(result).then(request.resolve, request.reject).finally(() => {
			this.release(name);
		});
	}

	private release(name: string): void {
		this.held.delete(name);
		this.drain(name);
	}
}

type FakeChannelPeer = Readonly<{
	readonly name: string;
	readonly receive: (value: unknown) => void;
	readonly open: () => boolean;
}>;

/** One browser profile's BroadcastChannel namespace. */
class FakeBroadcastNamespace {
	private readonly channels = new Map<string, Set<FakeChannelPeer>>();

	connect(peer: FakeChannelPeer): void {
		const peers = this.channels.get(peer.name) ?? new Set();
		peers.add(peer);
		this.channels.set(peer.name, peers);
	}

	disconnect(peer: FakeChannelPeer): void {
		const peers = this.channels.get(peer.name);
		peers?.delete(peer);
		if (peers?.size === 0) this.channels.delete(peer.name);
	}

	post(sender: FakeChannelPeer, value: unknown): void {
		for (const peer of this.channels.get(sender.name) ?? []) {
			if (peer === sender) continue;
			queueMicrotask(() => {
				if (peer.open()) peer.receive(value);
			});
		}
	}
}

const broadcastChannelClass = (
	namespace: FakeBroadcastNamespace
): typeof BroadcastChannel =>
	class {
		readonly name: string;
		private readonly listeners = new Set<(event: MessageEvent<unknown>) => void>();
		private closed = false;
		private readonly peer: FakeChannelPeer;

		constructor(name: string) {
			this.name = name;
			this.peer = {
				name,
				receive: (value) => {
					for (const listener of [...this.listeners]) {
						listener({ data: value } as MessageEvent<unknown>);
					}
				},
				open: () => !this.closed
			};
			namespace.connect(this.peer);
		}

		postMessage(value: unknown): void {
			if (!this.closed) namespace.post(this.peer, value);
		}

		addEventListener(
			type: string,
			listener: (event: MessageEvent<unknown>) => void
		): void {
			if (type === 'message') this.listeners.add(listener);
		}

		close(): void {
			if (this.closed) return;
			this.closed = true;
			this.listeners.clear();
			namespace.disconnect(this.peer);
		}
	} as unknown as typeof BroadcastChannel;

const fakeBrowserProfile = () => ({
	locks: new FakeLockNamespace(),
	channels: new FakeBroadcastNamespace()
});

const installBrowserProfile = (profile: ReturnType<typeof fakeBrowserProfile>): void => {
	vi.stubGlobal('navigator', { locks: profile.locks.manager });
	vi.stubGlobal('BroadcastChannel', broadcastChannelClass(profile.channels));
};

const fakeEventSources = () => {
	const opened: Array<ReturnType<typeof fakeSource> & { readonly url: string }> = [];
	return {
		opened,
		source: (url: string): EventSourceLike => {
			const next = { ...fakeSource(), url };
			opened.push(next);
			return next.source;
		}
	};
};

const settleBroker = async (): Promise<void> => {
	for (let index = 0; index < 12; index += 1) await Promise.resolve();
};

const browserScope = (workspaceId: string, tenantId: string): BrowserSyncScope => ({
	workspaceId,
	tenantId: TenantId.make(tenantId),
	environment: EnvironmentName.make('test'),
	releaseId: ReleaseId.make('release-1')
});

const fakeWorkspaceControls = (
	registrations: Array<string> = []
): BrowserSyncWorkspaceControls => ({
	register: async (connectionId) => {
		registrations.push(connectionId);
		return { queries: [], outcomes: [] };
	},
	extend: async () => Promise.reject(new Error('extension is not used by this broker test')),
	push: async () => undefined
});

describe('sync drivers', () => {
	it('uses the browser-owned connection id on registration and extension controls', async () => {
		const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
		const driver = createSyncHttpDriver({
			registrationUrl: '/sync/connect',
			extensionUrl: '/sync/extend',
			fetch: (async (url, init) => {
				const target = String(url);
				calls.push({ url: target, init });
				const payload =
					target === '/sync/extend'
						? {
							queryKey: 'query-1',
							version: 3,
							fromPrefix: 1,
							toPrefix: 2,
							rows: [{ id: 'b' }],
							retainedBytes: syncJsonByteLength([{ id: 'a' }, { id: 'b' }])
						}
						: { queries: [], outcomes: [] };
				return new Response(JSON.stringify(payload), {
					status: 200,
					headers: { 'content-type': 'application/json' }
				});
			}) as typeof fetch,
			push: async () => undefined
		});
		await driver.register('browser-connection', { queries: [], detached: [], pending: [] });
		await driver.extend('browser-connection', {
			queryKey: 'query-1',
			version: 3,
			loadedPrefix: 1,
			requestedPrefix: 2
		});
		expect(new Headers(calls[0]?.init?.headers).get(SYNC_CONNECTION_HEADER)).toBe(
			'browser-connection'
		);
		expect(calls[0]?.url).toBe('/sync/connect');
		expect(new Headers(calls[1]?.init?.headers).get(SYNC_CONNECTION_HEADER)).toBe(
			'browser-connection'
		);
		expect(calls[1]?.url).toBe('/sync/extend');
	});

});

describe('a browser Sync broker', () => {
	const brokers: Array<BrowserSyncBroker> = [];

	beforeEach(() => {
		let nextId = 0;
		vi.stubGlobal('crypto', {
			randomUUID: () =>
				`00000000-0000-4000-8000-${String(++nextId).padStart(12, '0')}`
		});
	});

	afterEach(() => {
		for (const broker of brokers.splice(0).reverse()) broker.close();
		vi.unstubAllGlobals();
	});

	const track = (broker: BrowserSyncBroker): BrowserSyncBroker => {
		brokers.push(broker);
		return broker;
	};

	it('closes instead of dropping a scope-qualified frame when its bounded queue overflows', async () => {
		installBrowserProfile(fakeBrowserProfile());
		const streams = fakeEventSources();
		const scope = browserScope('workspace-a', 'tenant-a');
		const broker = track(
			createBrowserSyncBroker({
				election: { syncPrincipal: 'signed-in-user' },
				streamUrl: 'https://sync.test/stream',
				source: streams.source,
				maxBufferedFrames: 1
			})
		);
		broker.attachWorkspace({ scope, controls: fakeWorkspaceControls() });
		await settleBroker();
		const stream = streams.opened[0];
		expect(stream).toBeDefined();
		stream?.emit('open', {});
		await settleBroker();
		const apply = {
			scope: {
				tenantId: scope.tenantId,
				environment: scope.environment,
				releaseId: scope.releaseId
			},
			frame: { updates: [], resets: [], outcomes: [] }
		};
		stream?.emit('apply', apply);
		stream?.emit('apply', apply);
		stream?.emit('apply', apply);
		expect(stream?.closed()).toBe(1);
	}, 60_000);

	it('elects one physical stream for two tabs while attaching both workspace scopes', async () => {
		installBrowserProfile(fakeBrowserProfile());
		const streams = fakeEventSources();
		const options = {
			election: { syncPrincipal: 'signed-in-user' },
			streamUrl: 'https://sync.test/stream',
			source: streams.source
		};
		const tabA = track(createBrowserSyncBroker(options));
		const tabB = track(createBrowserSyncBroker(options));
		const registrationsA: Array<string> = [];
		const registrationsB: Array<string> = [];
		const bindingA = tabA.attachWorkspace({
			scope: browserScope('workspace-a', 'tenant-a'),
			controls: fakeWorkspaceControls(registrationsA)
		});
		const bindingB = tabB.attachWorkspace({
			scope: browserScope('workspace-b', 'tenant-b'),
			controls: fakeWorkspaceControls(registrationsB)
		});

		await settleBroker();
		expect(streams.opened).toHaveLength(1);
		streams.opened[0]?.emit('open', {});
		await settleBroker();

		await bindingA.attachment.register({ queries: [], detached: [], pending: [] });
		await bindingB.attachment.register({ queries: [], detached: [], pending: [] });
		const connectionId = registrationsA[0];
		expect(connectionId).toEqual(expect.any(String));
		expect(registrationsB).toEqual([connectionId]);
		expect(new URL(streams.opened[0]?.url ?? '').searchParams.get('connectionId')).toBe(
			connectionId
		);
		expect(registrationsA).toEqual([connectionId]);
	}, 60_000);

	it('routes a wire-scoped frame only to the matching workspace binding', async () => {
		installBrowserProfile(fakeBrowserProfile());
		const streams = fakeEventSources();
		const options = {
			election: { syncPrincipal: 'signed-in-user' },
			streamUrl: 'https://sync.test/stream',
			source: streams.source
		};
		const tabA = track(createBrowserSyncBroker(options));
		const tabB = track(createBrowserSyncBroker(options));
		const scopeA = browserScope('workspace-a', 'tenant-a');
		const scopeB = browserScope('workspace-b', 'tenant-b');
		const bindingA = tabA.attachWorkspace({
			scope: scopeA,
			controls: fakeWorkspaceControls()
		});
		const bindingB = tabB.attachWorkspace({
			scope: scopeB,
			controls: fakeWorkspaceControls()
		});
		const framesA: Array<unknown> = [];
		const framesB: Array<unknown> = [];
		bindingA.attachment.subscribe({
			onFrame: (frame) => {
				framesA.push(frame);
			},
			onDisconnect: () => undefined
		});
		bindingB.attachment.subscribe({
			onFrame: (frame) => {
				framesB.push(frame);
			},
			onDisconnect: () => undefined
		});

		await settleBroker();
		streams.opened[0]?.emit('open', {});
		await settleBroker();
		streams.opened[0]?.emit('apply', {
			scope: {
				tenantId: scopeA.tenantId,
				environment: scopeA.environment,
				releaseId: scopeA.releaseId
			},
			frame: { updates: [], resets: [], outcomes: [] }
		});
		await settleBroker();
		expect(framesA).toHaveLength(1);
		expect(framesB).toHaveLength(0);

		streams.opened[0]?.emit('apply', {
			scope: {
				tenantId: scopeB.tenantId,
				environment: scopeB.environment,
				releaseId: scopeB.releaseId
			},
			frame: { updates: [], resets: [], outcomes: [] }
		});
		await settleBroker();
		expect(framesA).toHaveLength(1);
		expect(framesB).toHaveLength(1);
	}, 60_000);

	it('allows a separate browser profile for the same principal to own its own stream', async () => {
		const streams = fakeEventSources();
		const options = {
			election: { syncPrincipal: 'same-signed-in-user' },
			streamUrl: 'https://sync.test/stream',
			source: streams.source
		};

		installBrowserProfile(fakeBrowserProfile());
		const profileA = track(createBrowserSyncBroker(options));
		const registrationsA: Array<string> = [];
		const bindingA = profileA.attachWorkspace({
			scope: browserScope('workspace-a', 'tenant-a'),
			controls: fakeWorkspaceControls(registrationsA)
		});

		installBrowserProfile(fakeBrowserProfile());
		const profileB = track(createBrowserSyncBroker(options));
		const registrationsB: Array<string> = [];
		const bindingB = profileB.attachWorkspace({
			scope: browserScope('workspace-a', 'tenant-a'),
			controls: fakeWorkspaceControls(registrationsB)
		});

		await settleBroker();
		expect(streams.opened).toHaveLength(2);
		for (const stream of streams.opened) stream.emit('open', {});
		await settleBroker();

		await bindingA.attachment.register({ queries: [], detached: [], pending: [] });
		await bindingB.attachment.register({ queries: [], detached: [], pending: [] });
		expect(registrationsA[0]).toEqual(expect.any(String));
		expect(registrationsB[0]).toEqual(expect.any(String));
		expect(registrationsB[0]).not.toBe(registrationsA[0]);
	}, 60_000);

	it('rotates one physical stream after owner loss without opening per-tab or per-workspace streams', async () => {
		installBrowserProfile(fakeBrowserProfile());
		const streams = fakeEventSources();
		const options = {
			election: { syncPrincipal: 'signed-in-user' },
			streamUrl: 'https://sync.test/stream',
			source: streams.source
		};
		const firstTab = track(createBrowserSyncBroker(options));
		const secondTab = track(createBrowserSyncBroker(options));
		const registrationsA: Array<string> = [];
		const registrationsB: Array<string> = [];
		const registrationsC: Array<string> = [];
		const bindingA = firstTab.attachWorkspace({
			scope: browserScope('workspace-a', 'tenant-a'),
			controls: fakeWorkspaceControls(registrationsA)
		});
		const bindingB = secondTab.attachWorkspace({
			scope: browserScope('workspace-b', 'tenant-b'),
			controls: fakeWorkspaceControls(registrationsB)
		});
		const bindingC = secondTab.attachWorkspace({
			scope: browserScope('workspace-c', 'tenant-c'),
			controls: fakeWorkspaceControls(registrationsC)
		});

		await settleBroker();
		expect(streams.opened).toHaveLength(1);
		streams.opened[0]?.emit('open', {});
		await settleBroker();
		await Promise.all([
			bindingA.attachment.register({ queries: [], detached: [], pending: [] }),
			bindingB.attachment.register({ queries: [], detached: [], pending: [] }),
			bindingC.attachment.register({ queries: [], detached: [], pending: [] })
		]);
		const firstConnectionId = registrationsA[0];
		expect(registrationsB).toEqual([firstConnectionId]);
		expect(registrationsC).toEqual([firstConnectionId]);

		streams.opened[0]?.fail(new Error('owner transport lost'));
		await settleBroker();
		expect(streams.opened).toHaveLength(2);
		expect(streams.opened[0]?.closed()).toBe(1);
		streams.opened[1]?.emit('open', {});
		await settleBroker();

		await Promise.all([
			bindingA.attachment.register({ queries: [], detached: [], pending: [] }),
			bindingB.attachment.register({ queries: [], detached: [], pending: [] }),
			bindingC.attachment.register({ queries: [], detached: [], pending: [] })
		]);
		const rotatedConnectionId = registrationsB[1];
		expect(rotatedConnectionId).toEqual(expect.any(String));
		expect(rotatedConnectionId).not.toBe(firstConnectionId);
		expect(registrationsA[1]).toBe(rotatedConnectionId);
		expect(registrationsC[1]).toBe(rotatedConnectionId);
		bindingC.close();
		await settleBroker();
		expect(streams.opened).toHaveLength(2);
	}, 60_000);
});
