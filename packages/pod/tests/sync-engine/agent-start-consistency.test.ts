import { afterEach, describe, expect, it, vi } from 'vitest';
import { workspaceRuntimeOperations } from '$lib/ui/state/client.js';
import {
	disableClientSync,
	enableClientSync,
	setLocalSchema,
	type LocalCollectionSchema
} from '$lib/ui/sync/client-sync.js';
import type { PodSyncClient } from '$lib/ui/sync/pod-sync-client.js';

afterEach(() => {
	disableClientSync();
	vi.unstubAllGlobals();
});

describe('agent start read-your-command consistency', () => {
	it('folds the authoritative session receipt into the replica before resolving', async () => {
		const upserts: (readonly Record<string, unknown>[])[] = [];
		const notified: string[] = [];
		const waited: string[] = [];
		const client = {
			onChange: () => {},
			upsertRows: async (_collection: string, rows: readonly Record<string, unknown>[]) => {
				upserts.push(rows);
			},
			notifyCollection: (collection: string) => notified.push(collection),
			waitForSequence: async (sequence: string) => {
				waited.push(sequence);
				return true;
			},
			setSubscribedCollections: () => {},
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

		const receipt = await workspaceRuntimeOperations.agentChatStart({ message: 'Inspect this' });

		expect(receipt.chatId).toBe('chat-1');
		expect(upserts).toEqual([[session]]);
		expect(notified).toEqual(['chat_session']);
		expect(waited).toEqual(['42']);
	});
});
