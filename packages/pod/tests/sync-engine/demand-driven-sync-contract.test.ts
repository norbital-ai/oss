import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
	return readFileSync(new URL(`../../src/lib/${path}`, import.meta.url), 'utf8');
}

describe('demand-driven browser synchronization', () => {
	it('does not enumerate and warm the whole tenant schema after mount', () => {
		const mount = source('runtime/mount-client.ts');
		const clientSync = source('client/sync/client-sync.ts');
		expect(mount).not.toContain('warmAllCollections');
		expect(clientSync).not.toContain('warmAllCollections');
		expect(clientSync).not.toContain('localSchemaCollections');
	});

	it('closes the replica only when a page is discarded, not when it enters bfcache', () => {
		const replica = source('client/sync/replica.ts');
		expect(replica).toContain("window.addEventListener('pagehide'");
		expect(replica).toContain('if (event.persisted) return');
		expect(replica).toContain('sync.client.close()');
	});
});
