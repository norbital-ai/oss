/**
 * The replica's engine, running once per browser rather than once per tab.
 *
 * A page used to open its own PGlite. That meant a workspace open in three tabs paid for three
 * WebAssembly engines, three copies of the same rows in IndexedDB, and three independent sync loops
 * fetching the same diffs — and, worse, three writers to one persisted database, which is a
 * corruption risk rather than merely wasteful.
 *
 * `worker()` is PGlite's answer to exactly that: every tab connects to this module, the tabs elect a
 * leader through the Web Locks API, and only the leader's worker actually holds the database. The
 * others proxy their queries to it over a message channel and see the same rows. When the leader's
 * tab closes, a survivor takes the lock and the database moves with it.
 *
 * Nothing about the workspace lives here. The tenant decides *which* database to open — passed in as
 * `dataDir` — because two workspaces in one browser must never share one, and this file is loaded
 * once regardless of how many are open.
 */

import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { vector } from '@electric-sql/pglite-pgvector';
import { worker } from '@electric-sql/pglite/worker';

void worker({
	init: async (options) =>
		// Registered explicitly: PGlite ships these and enables none of them, and the provisioning
		// DDL's first statements are `create extension`. Without them the replica fails on step one.
		PGlite.create(options.dataDir, {
			extensions: { pg_trgm, btree_gist, vector }
		})
});
