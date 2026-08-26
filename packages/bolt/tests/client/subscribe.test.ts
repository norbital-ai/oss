import { beforeEach, describe, expect, it, vi } from 'vitest';
import { subscribeToChanges, type EventSourceLike } from '../../src/client/replica/subscribe.js';
import { setWorkspaceSession } from '../../src/client/session.js';
import type { SyncChange, SyncCursor } from '../../src/runtime/sync/sync.js';

/** The browser receives typed outbox deltas, not wake hints followed by a browser diff request. */

const STREAM_URL = 'https://host.invalid/tenant/abc/_bolt/sync/stream';
const cursor: SyncCursor = { xid: 7, sequence: 3 };
const change: SyncChange = {
	cursor: { xid: 7, sequence: 4 },
	collection: 'leave_requests',
	recordId: 'leave-1',
	operation: 'update',
	record: { status: 'approved' }
};

const declareSession = (): void => {
	setWorkspaceSession({
		tenantId: 'test-tenant',
		environment: 'development',
		releaseId: 'local',
		accessScope: 'operator',
		credential: 'test-credential',
		transport: { command: async () => null },
		syncStreamUrl: STREAM_URL,
		files: {
			store: async () => '',
			remove: async () => undefined,
			urlFor: (key: string) => key
		},
		chatDocuments: {
			store: async (_conversation, key, file) => ({
				storage_key: key,
				file_name: file.name,
				file_size: file.size,
				mime_type: file.type || 'application/octet-stream'
			}),
			remove: async () => undefined,
			urlFor: (_conversation, key) => key
		},
		operations: { read: async () => null, run: async () => null }
	});
};

const stubSource = () => {
	const listeners = new Map<string, (event: { data?: string; lastEventId?: string }) => void>();
	let closed = false;
	const source: EventSourceLike = {
		addEventListener: (type, listener) => listeners.set(type, listener),
		close: () => {
			closed = true;
		},
		onerror: null
	};
	return {
		source,
		emit: (type: string, data?: string, lastEventId?: string) =>
			listeners.get(type)?.({
				...(data === undefined ? {} : { data }),
				...(lastEventId === undefined ? {} : { lastEventId })
			}),
		fail: (cause: unknown) => source.onerror?.(cause),
		isClosed: () => closed
	};
};

describe('subscribing to database changes', () => {
	beforeEach(declareSession);

	it('passes the persisted cursor and delivers typed SyncChange batches directly', () => {
		const stub = stubSource();
		const urls: Array<string> = [];
		const seen: Array<ReadonlyArray<SyncChange>> = [];
		subscribeToChanges({
			cursor: () => cursor,
			onChange: (changes) => seen.push(changes),
			source: (url) => {
				urls.push(url);
				return stub.source;
			}
		});

		stub.emit('sync', JSON.stringify([change]), JSON.stringify(change.cursor));
		expect(seen).toEqual([[change]]);
		expect(new URL(urls[0] ?? '').origin + new URL(urls[0] ?? '').pathname).toBe(STREAM_URL);
		expect(JSON.parse(new URL(urls[0] ?? '').searchParams.get('cursor') ?? '')).toEqual(cursor);
	});

	it('keeps the native EventSource open after a network error so it can resume with Last-Event-ID', () => {
		const stub = stubSource();
		const seen: Array<ReadonlyArray<SyncChange>> = [];
		const causes: Array<unknown> = [];
		subscribeToChanges({
			cursor: () => cursor,
			onChange: (changes) => seen.push(changes),
			onError: (cause) => causes.push(cause),
			source: () => stub.source
		});

		stub.fail(new Error('network blip'));
		expect(causes).toHaveLength(1);
		expect(stub.isClosed()).toBe(false);
		stub.emit('sync', JSON.stringify([change]));
		expect(seen).toEqual([[change]]);
	});

	it('reopens an unreadable stream frame from the durable cursor instead of advancing past it', () => {
		const first = stubSource();
		const second = stubSource();
		const sources = [first, second];
		const urls: Array<string> = [];
		const causes: Array<unknown> = [];
		let durable = cursor;
		subscribeToChanges({
			cursor: () => durable,
			onChange: (changes) => {
				durable = changes[changes.length - 1]?.cursor ?? durable;
			},
			onError: (cause) => causes.push(cause),
			source: (url) => {
				urls.push(url);
				const next = sources.shift();
				if (next === undefined) throw new Error('unexpected third stream');
				return next.source;
			}
		});

		first.emit('sync', 'not json');
		expect(first.isClosed()).toBe(true);
		expect(causes).toHaveLength(1);
		expect(urls).toHaveLength(2);
		expect(JSON.parse(new URL(urls[1] ?? '').searchParams.get('cursor') ?? '')).toEqual(cursor);
		second.emit('sync', JSON.stringify([change]));
		expect(durable).toEqual(change.cursor);
	});

	it('reports readiness only after the host has caught up and closes when stopped', () => {
		const stub = stubSource();
		let opened = 0;
		const subscription = subscribeToChanges({
			cursor: () => cursor,
			onChange: () => undefined,
			onOpen: () => (opened += 1),
			source: () => stub.source
		});
		stub.emit('ready', JSON.stringify({ connectionId: 'tenant:abc' }));
		expect(opened).toBe(1);
		subscription.stop();
		expect(stub.isClosed()).toBe(true);
	});

	it('degrades to no subscription where EventSource does not exist', () => {
		const causes: Array<unknown> = [];
		const subscription = subscribeToChanges({
			cursor: () => cursor,
			onChange: () => undefined,
			onError: (cause) => causes.push(cause),
			source: () => {
				throw new Error('EventSource is not defined');
			}
		});
		expect(causes).toHaveLength(1);
		expect(() => subscription.stop()).not.toThrow();
	});

	it('retries a failed stream construction instead of silencing the leader forever', async () => {
		// EventSource owns reconnection only once it exists. A throw before it exists — a session
		// field not yet populated during boot, a transient constructor rejection — used to leave a
		// healthy database leader with no feed and no visible error: the workspace simply never
		// updated until a reload. The failed open must schedule another attempt.
		vi.useFakeTimers();
		try {
			const stub = stubSource();
			let attempts = 0;
			const received: Array<ReadonlyArray<SyncChange>> = [];
			const subscription = subscribeToChanges({
				cursor: () => cursor,
				onChange: (changes) => received.push(changes),
				onError: () => undefined,
				source: () => {
					attempts += 1;
					if (attempts === 1) throw new Error('session not ready');
					return stub.source;
				}
			});
			expect(attempts).toBe(1);
			await vi.advanceTimersByTimeAsync(2_500);
			expect(attempts).toBe(2);
			stub.emit('sync', JSON.stringify([change]));
			expect(received).toEqual([[change]]);
			subscription.stop();
		} finally {
			vi.useRealTimers();
		}
	});
});
