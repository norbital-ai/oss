import { PGlite } from '@electric-sql/pglite';
import type { PgliteLike } from '$lib/client/sync/pod-sync-client.js';

/**
 * A fresh in-memory PGlite acting as one client device's local database. PGlite is the same
 * WASM Postgres used in the browser, so the sync client under test is the real client code.
 *
 * `uuidv7()` is a Postgres 18 builtin the tenant DDL may reference in DEFAULTs; PGlite tracks an
 * earlier core, so we shim it before the schema is applied. The client never relies on local
 * defaults (rows arrive fully-formed from the server), so aliasing it to gen_random_uuid is safe.
 */
export async function createClientDb(): Promise<PgliteLike> {
	const pg = new PGlite();
	await pg.exec(
		`CREATE OR REPLACE FUNCTION uuidv7() RETURNS uuid AS $$ SELECT gen_random_uuid() $$ LANGUAGE sql;`
	);
	return pg as unknown as PgliteLike;
}
