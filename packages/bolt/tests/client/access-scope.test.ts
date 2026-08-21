import { beforeEach, describe, expect, it } from 'vitest';
import {
	createBrowserWorkspaceRuntime,
	switchWorkspaceAccessScope
} from '../../src/client/runtime.js';
import { setWorkspaceSession } from '../../src/client/session.js';

beforeEach(() => {
	setWorkspaceSession({
		tenantId: 'scope-test',
		environment: 'development',
		releaseId: 'local',
		accessScope: 'operator',
		credential: 'test-credential',
		transport: { command: async () => null },
		syncStreamUrl: '/sync',
		files: {
			store: async () => '',
			remove: async () => undefined,
			urlFor: (key) => key
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

		await cache.hydrated;
		cache.write('visible-items', { role: 'operator' }, ['items']);
		expect(await cache.read('visible-items')).toEqual({ role: 'operator' });
		runtime.local.current = {} as NonNullable<typeof runtime.local.current>;

		switchWorkspaceAccessScope(runtime, 'team:employee');

		expect(runtime.local.current).toBeUndefined();
		expect(await cache.read('visible-items')).toBeUndefined();
	});
});
