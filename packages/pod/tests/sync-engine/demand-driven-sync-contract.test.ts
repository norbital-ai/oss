import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
	return readFileSync(new URL(`../../src/${path}`, import.meta.url), 'utf8');
}

describe('demand-driven browser synchronization', () => {
	it('does not enumerate and warm the whole tenant schema after mount', () => {
		const mount = source('ui/shell/mount-client.ts');
		const clientSync = source('ui/sync/client-sync.ts');
		expect(mount).not.toContain('warmAllCollections');
		expect(clientSync).not.toContain('warmAllCollections');
		expect(clientSync).not.toContain('localSchemaCollections');
	});

	it('closes the replica only when a page is discarded, not when it enters bfcache', () => {
		const replica = source('ui/sync/replica.ts');
		expect(replica).toContain("window.addEventListener('pagehide'");
		expect(replica).toContain('if (event.persisted) return');
		expect(replica).toContain('sync.client.close()');
	});
});
