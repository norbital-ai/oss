import { describe, expect, it, afterEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { replicaLocation } from '../../src/client/replica/pglite-loader.js';
import type { PGliteLike } from '../../src/client/replica/pglite-sql.js';

/**
 * One engine per browser rather than one per tab.
 *
 * Two properties are worth pinning here, and neither is visible from a single tab. The first is that
 * two workspaces never share a database — the failure there is silent and looks like working
 * software. The second is that a tab which does not lead still learns when the rows underneath it
 * change, because it is the only thing standing between "cheap" and "quietly stale".
 */

const databases: Array<PGlite> = [];
afterEach(async () => {
	for (const database of databases.splice(0)) await database.close();
});

describe('where the replica persists', () => {
	it('gives each workspace its own database', () => {
		// Two workspaces built from the same template have the same schema fingerprint, so the rebuild
		// check that normally separates them agrees they match — and the second would inherit the
		// first's rows believing they were its own.
		expect(replicaLocation('tenant-a::production')).not.toEqual(
			replicaLocation('tenant-b::production')
		);
	});

	it('separates environments of one workspace', () => {
		// Staging and production of the same workspace are the same schema by construction.
		expect(replicaLocation('acme::staging')).not.toEqual(replicaLocation('acme::production'));
	});

	it('keeps the name usable as a storage key', () => {
		// Tenant ids reach this from a routing header, so a name is not guaranteed to be tame.
		expect(replicaLocation('a/../b space::dev')).toMatch(/^idb:\/\/bolt-replica::[a-zA-Z0-9:_-]+$/);
	});

	it('is stable for one workspace, so a reload resumes rather than rebuilds', () => {
		expect(replicaLocation('acme::production')).toEqual(replicaLocation('acme::production'));
	});
});

describe('telling other tabs what changed', () => {
	it('delivers a notification through the database the tabs share', async () => {
		// The real mechanism, not a stand-in: `listen`/`pg_notify` is how a follower finds out, and it
		// travels with the database precisely so it cannot arrive before the rows it describes.
		const database = await PGlite.create('memory://');
		databases.push(database);
		const engine = database as unknown as PGliteLike;

		const heard: Array<string> = [];
		const stop = await engine.listen?.('bolt_replica_changed', (payload) => heard.push(payload));

		await engine.query('select pg_notify($1, $2)', [
			'bolt_replica_changed',
			JSON.stringify(['people', 'companies'])
		]);
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(heard).toHaveLength(1);
		expect(JSON.parse(heard[0] ?? '[]')).toEqual(['people', 'companies']);
		await stop?.();
	});

	it('stops delivering once the listener is released', async () => {
		const database = await PGlite.create('memory://');
		databases.push(database);
		const engine = database as unknown as PGliteLike;

		const heard: Array<string> = [];
		const stop = await engine.listen?.('bolt_replica_changed', (payload) => heard.push(payload));
		await stop?.();

		await engine.query('select pg_notify($1, $2)', ['bolt_replica_changed', '["people"]']);
		await new Promise((resolve) => setTimeout(resolve, 50));
		// A tab that closed its replica must not keep invalidating caches it no longer owns.
		expect(heard).toEqual([]);
	});
});
