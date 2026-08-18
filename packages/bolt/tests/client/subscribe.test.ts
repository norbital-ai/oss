import { describe, expect, it } from 'vitest';
import {
	subscribeToChanges,
	SYNC_STREAM_PATH,
	type EventSourceLike
} from '../../src/client/replica/subscribe.js';

/**
 * The listener that replaced the poll.
 *
 * The behaviour worth pinning is what happens when things go wrong: a stream that errors must not
 * stop delivering, and a frame that cannot be read must not be silently ignored.
 */

const stubSource = () => {
	const listeners = new Map<string, (event: { data?: string }) => void>();
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
		urls: [] as Array<string>,
		emit: (type: string, data?: string) =>
			listeners.get(type)?.({ ...(data === undefined ? {} : { data }) }),
		fail: (cause: unknown) => source.onerror?.(cause),
		isClosed: () => closed
	};
};

describe('subscribing to change announcements', () => {
	it('reports the collections a frame names', () => {
		const stub = stubSource();
		const seen: Array<ReadonlyArray<string>> = [];
		subscribeToChanges({
			onChange: (collections) => seen.push(collections),
			source: () => stub.source
		});

		stub.emit('sync', JSON.stringify({ collections: ['leave_requests', 'companies'] }));
		expect(seen).toEqual([['leave_requests', 'companies']]);
	});

	it('connects to the stream the host serves', () => {
		const stub = stubSource();
		const urls: Array<string> = [];
		subscribeToChanges({
			onChange: () => undefined,
			source: (url) => {
				urls.push(url);
				return stub.source;
			}
		});
		expect(urls).toEqual([SYNC_STREAM_PATH]);
	});

	it('treats an unreadable frame as "something changed" rather than as nothing', () => {
		const stub = stubSource();
		const seen: Array<ReadonlyArray<string>> = [];
		subscribeToChanges({
			onChange: (collections) => seen.push(collections),
			source: () => stub.source
		});

		// Ignoring it would leave the replica stale until the next unrelated write; an empty list means
		// the caller catches up on everything, which is the safe reading.
		stub.emit('sync', 'not json');
		expect(seen).toEqual([[]]);
	});

	it('keeps listening after an error, because the browser reconnects on its own', () => {
		const stub = stubSource();
		const seen: Array<ReadonlyArray<string>> = [];
		const causes: Array<unknown> = [];
		subscribeToChanges({
			onChange: (collections) => seen.push(collections),
			onError: (cause) => causes.push(cause),
			source: () => stub.source
		});

		stub.fail(new Error('network blip'));
		expect(causes).toHaveLength(1);
		// Closing on the first blip would turn a momentary disconnection into a tab that stops updating
		// until someone reloads it.
		expect(stub.isClosed()).toBe(false);
		stub.emit('sync', JSON.stringify({ collections: ['people'] }));
		expect(seen).toEqual([['people']]);
	});

	it('reports the stream opening, so a caller can catch up across the gap', () => {
		const stub = stubSource();
		let opened = 0;
		subscribeToChanges({
			onChange: () => undefined,
			onOpen: () => (opened += 1),
			source: () => stub.source
		});
		stub.emit('ready', JSON.stringify({ connectionId: 'tenant:abc' }));
		expect(opened).toBe(1);
	});

	it('degrades to no subscription where EventSource does not exist', () => {
		const causes: Array<unknown> = [];
		const subscription = subscribeToChanges({
			onChange: () => undefined,
			onError: (cause) => causes.push(cause),
			source: () => {
				throw new Error('EventSource is not defined');
			}
		});
		// The replica still works; it just only catches up when something else asks it to.
		expect(causes).toHaveLength(1);
		expect(() => subscription.stop()).not.toThrow();
	});

	it('closes the stream when stopped', () => {
		const stub = stubSource();
		const subscription = subscribeToChanges({
			onChange: () => undefined,
			source: () => stub.source
		});
		subscription.stop();
		expect(stub.isClosed()).toBe(true);
	});
});
