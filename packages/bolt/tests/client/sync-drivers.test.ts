import { SYNC_CONNECTION_HEADER } from '@norbital-ai/bolt-protocol';
import { describe, expect, it, vi } from 'vitest';
import { createSyncHttpDriver } from '../../src/client/sync/http-driver.js';
import {
	openSyncSse,
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
		closed: () => closed
	};
};

describe('sync drivers', () => {
	it('uses the host-issued ready id on the exact connect header', async () => {
		const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
		const driver = createSyncHttpDriver({
			connectUrl: '/sync/connect',
			fetch: (async (url, init) => {
				calls.push({ url: String(url), init });
				return new Response(
					JSON.stringify({ head: { sequence: 0 }, results: [], outcomes: [] }),
					{ status: 200, headers: { 'content-type': 'application/json' } }
				);
			}) as typeof fetch,
			push: async () => undefined
		});
		await driver.connect('server-connection', { queries: [], released: [], pending: [] });
		expect(new Headers(calls[0]?.init?.headers).get(SYNC_CONNECTION_HEADER)).toBe(
			'server-connection'
		);
	});

	it('closes instead of dropping an apply frame when its bounded queue overflows', async () => {
		const source = fakeSource();
		let unblock: (() => void) | undefined;
		const blocked = new Promise<void>((resolve) => {
			unblock = resolve;
		});
		const disconnected = vi.fn();
		openSyncSse({
			url: '/sync/stream',
			source: () => source.source,
			maxBufferedFrames: 1,
			onReady: () => undefined,
			onFrame: () => blocked,
			onDisconnect: disconnected
		});
		source.emit('ready', { connectionId: 'connection' });
		await Promise.resolve();
		const frame = { head: { sequence: 1 }, patches: [], outcomes: [] };
		source.emit('apply', frame);
		await Promise.resolve();
		source.emit('apply', { ...frame, head: { sequence: 2 } });
		source.emit('apply', { ...frame, head: { sequence: 3 } });
		expect(disconnected).toHaveBeenCalledOnce();
		expect(source.closed()).toBe(1);
		unblock?.();
	});
});
