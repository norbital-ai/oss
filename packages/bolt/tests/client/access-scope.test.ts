import { beforeEach, describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import {
	createBrowserWorkspaceRuntime,
	switchWorkspaceAccessScope
} from '../../src/client/runtime.js';
// `runtime.ts` reaches the session through the package import map at runtime. Use the same module
// identity here; importing the source path directly creates a second singleton after Bolt is built.
import { setWorkspaceSession } from '#lib/client/session.js';

beforeEach(() => {
	setWorkspaceSession({
		tenantId: 'scope-test',
		environment: 'development',
		releaseId: 'local',
		principal: 'operator-1',
		accessScope: 'operator',
		credential: 'test-credential',
		transport: { command: async () => null },
		syncStreamUrl: '/sync',
		files: {
			store: async () => '',
			remove: async () => undefined,
			urlFor: (key) => key
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
});

describe('browser access scope', () => {
	it('withdraws the local reader and swaps query-cache namespaces', async () => {
		const runtime = createBrowserWorkspaceRuntime();
		const cache = runtime.cache;
		expect(cache).toBeDefined();
		if (cache === undefined || runtime.local === undefined) return;

		await Effect.runPromise(cache.hydrated);
		cache.write('visible-items', { role: 'operator' }, ['items']);
		expect(await Effect.runPromise(cache.read('visible-items'))).toEqual({ role: 'operator' });
		runtime.local.current = {} as NonNullable<typeof runtime.local.current>;

		switchWorkspaceAccessScope(runtime, 'team:employee');

		expect(runtime.local.current).toBeUndefined();
		expect(await Effect.runPromise(cache.read('visible-items'))).toBeUndefined();
	});
});
