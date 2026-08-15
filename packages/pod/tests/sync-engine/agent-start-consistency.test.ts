import { afterEach, describe, expect, it, vi } from 'vitest';
import { startInteractiveAgent } from '$lib/ui/state/client.js';
import {
	clearLocalSchema,
	disableClientSync,
	enableClientSync,
	setLocalSchema,
	type LocalCollectionSchema
} from '$lib/ui/sync/client-sync.js';
import type { PodSyncClient } from '$lib/ui/sync/pod-sync-client.js';

afterEach(() => {
	disableClientSync();
	clearLocalSchema();
	vi.unstubAllGlobals();
});

describe('agent start read-your-command consistency', () => {
	it('folds the authoritative session receipt into the replica before resolving', async () => {
		const upserts: (readonly Record<string, unknown>[])[] = [];
		const notified: string[] = [];
		const waited: string[] = [];
		const events: string[] = [];
		const client = {
			onChange: () => {},
			upsertRows: async (_collection: string, rows: readonly Record<string, unknown>[]) => {
				upserts.push(rows);
			},
			notifyCollection: (collection: string) => notified.push(collection),
			waitForSequence: async (sequence: string) => {
				events.push(`wait:${sequence}`);
				waited.push(sequence);
				return true;
			},
			setSubscribedCollections: (collections: ReadonlySet<string>) => {
				if (collections.has('chat_session')) events.push('subscribed:chat_session');
			},
			loadSyncState: async () => new Map()
		} as unknown as PodSyncClient;
		setLocalSchema(
			new Map<string, LocalCollectionSchema>([
				[
					'chat_session',
					{
						name: 'chat_session',
						columns: ['norbital_id', 'norbital_row_version', 'title', 'messages', 'turns'],
						fieldKinds: {},
						searchFields: [],
						relationships: []
					}
				]
			])
		);
		enableClientSync(client);
		const session = {
			norbital_id: 'chat-1',
			norbital_row_version: 1,
			title: 'Workspace agent',
			messages: [],
			turns: []
		};
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							runId: 'run-1',
							chatId: 'chat-1',
							accepted: true,
							session,
							syncSequence: '42'
						}),
						{ status: 200, headers: { 'content-type': 'application/json' } }
					)
			)
		);

		const receipt = await startInteractiveAgent({ message: 'Inspect this' });

		expect(receipt.chatId).toBe('chat-1');
		expect(upserts).toEqual([[session]]);
		expect(notified).toEqual(['chat_session']);
		expect(waited).toEqual(['42']);
		expect(events.indexOf('subscribed:chat_session')).toBeLessThan(events.indexOf('wait:42'));
	});

	it('lets a cold collection snapshot seed the cursor before starting the receipt barrier', async () => {
		const events: string[] = [];
		let releaseShape: () => void = () => {};
		const shapeReady = new Promise<void>((resolve) => {
			releaseShape = resolve;
		});
		const client = {
			onChange: () => {},
			upsertRows: async () => {},
			notifyCollection: () => {},
			setSubscribedCollections: (collections: ReadonlySet<string>) => {
				if (collections.has('chat_session')) events.push('subscribed');
			},
			shapeSubscribe: async () => {
				events.push('shape:start');
				await shapeReady;
				events.push('shape:ready');
				return {
					rows: [],
					cursor: { xid: '1', seq: '42' },
					nextCursor: null
				};
			},
			waitForSequence: async () => {
				events.push('wait');
				return true;
			},
			recordSyncState: async () => {},
			loadSyncState: async () => new Map()
		} as unknown as PodSyncClient;
		enableClientSync(client);
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							runId: 'run-cold',
							chatId: 'chat-cold',
							accepted: true,
							session: null,
							syncSequence: '42'
						}),
						{ status: 200, headers: { 'content-type': 'application/json' } }
					)
			)
		);

		const started = startInteractiveAgent({ message: 'Inspect this' });
		await vi.waitFor(() => expect(events).toContain('shape:start'));
		expect(events).not.toContain('wait');
		releaseShape();
		await started;

		expect(events.indexOf('shape:ready')).toBeLessThan(events.indexOf('wait'));
	});

	it('folds the session receipt even when the replica schema is not published yet', async () => {
		const upserts: (readonly Record<string, unknown>[])[] = [];
		const notified: string[] = [];
		const client = {
			onChange: () => {},
			upsertRows: async (_collection: string, rows: readonly Record<string, unknown>[]) => {
				upserts.push(rows);
			},
			notifyCollection: (collection: string) => notified.push(collection),
			waitForSequence: async () => true,
			setSubscribedCollections: () => {},
			loadSyncState: async () => new Map()
		} as unknown as PodSyncClient;
		enableClientSync(client);
		const session = {
			norbital_id: 'chat-2',
			norbital_row_version: 1,
			title: 'Workspace agent',
			messages: [],
			turns: [],
			visibility: 'personal'
		};
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							runId: 'run-2',
							chatId: 'chat-2',
							accepted: true,
							session,
							syncSequence: '7'
						}),
						{ status: 200, headers: { 'content-type': 'application/json' } }
					)
			)
		);

		const receipt = await startInteractiveAgent({ message: 'Inspect this' });

		expect(receipt.chatId).toBe('chat-2');
		expect(upserts).toEqual([[session]]);
		expect(notified).toEqual(['chat_session']);
	});
});
