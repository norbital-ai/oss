// transform-read-race (rule 26, L-BOLT-146): two acts whose transforms read the same quota before either commits. The
// first commits; the second's fingerprint no longer matches under its table lock, so it replays once with the same
// clock and ids, re-reads, and refuses. On PGlite (one connection) the race is the guest window between read and
// commit, which interleaves in process; the lock contention itself runs on Postgres when `BOLT_TEST_PG` names a server
// (a scratch database is created and dropped), and is skipped otherwise.
import { createRequire } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';
import type { GuestPort, Outcome, TenantDb } from '../src/engine/contracts.ts';
import { catalogOf } from '../src/engine/access/pred.ts';
import { postgresDb, type PgPool } from '../src/engine/db/postgres.ts';
import * as ir from '../src/protocol/ir.ts';
import { act } from '../src/engine/write/act.ts';
import { admin, NOW, TODAY } from './write-fixture.ts';
import { bridgeOn, manifest, migrate, open } from './write-p2.fixture.ts';

/** Orders are capped at two: the transform counts them (a workspace read) and refuses the third. */
async function race(db: TenantDb) {
	let invoked = 0, arrived = 0, release!: () => void;
	const both = new Promise<void>((r) => { release = r; });
	const guest: GuestPort = {
		async invoke(inv, bridge) {
			const racing = ++invoked === 2 || invoked === 3;   // a and b; 'first' and the replay run straight through
			const [a] = await bridge.cross([{ op: 'read', read: ir.aggregate(catalogOf(manifest), 'orders', { count: true }), params: {} }], new AbortController().signal);
			const n = Number((a as { ok: true; value: { count: number } }).value.count);
			if (racing) { if (++arrived === 2) release(); await both; }
			return n >= 2 ? { kind: 'refused', message: 'quota', cpuMs: 1 } : { kind: 'ok', output: inv.input, cpuMs: 1 };
		},
	};
	const e = { manifest, db, transforms: new Set(['orders']), guest, bridge: bridgeOn(db) };
	const run = (title: string) => act(e, { collection: 'orders', verb: 'create', input: { title }, key: title, issuedAt: NOW, authority: admin,
		bindings: { now: NOW, today: TODAY, tz: 'UTC', params: {} }, invocationId: `inv-${title}` });
	await run('first');
	const [a, b] = await Promise.all([run('a'), run('b')]);
	const count = (await db.read([{ text: 'select count(*)::int as n from orders', params: [] }]))[0]!.rows[0]!['n'];
	return { outcomes: [a.outcome, b.outcome], invoked, count };
}
const kinds = (os: readonly Outcome[]) => os.map((o) => o.kind === 'refused' ? `refused:${o.message}` : o.kind).sort();

describe('engine/write: transform-read-race (rule 26)', () => {
	it('PGlite: the loser replays once, re-reads the moved quota, and refuses', async () => {
		const { db } = await open();
		const r = await race(db);
		expect(kinds(r.outcomes)).toEqual(['committed', 'refused:quota']);
		expect(r.count).toBe(2);
		expect(r.invoked).toBe(4);   // 'first', a, b, and b's one replay
	});

	const url = process.env['BOLT_TEST_PG'];
	const pools: { end(): Promise<void> }[] = [];
	afterAll(async () => { for (const p of pools) await p.end(); });
	it.skipIf(url === undefined)('Postgres: the same race under the real SHARE ROW EXCLUSIVE lock (BOLT_TEST_PG)', async () => {
		// bolt names no Postgres driver; the host's (bolt-server's) is borrowed for this spec
		const pg = createRequire(new URL('../../bolt-server/package.json', import.meta.url))('pg') as {
			Pool: new (o: { connectionString: string; max?: number; options?: string }) => PgPool & { query(t: string): Promise<unknown>; end(): Promise<void>; on(e: 'error', f: () => void): void } };
		const name = `bolt_race_${process.pid}_${Date.now()}`;
		const adminPool = new pg.Pool({ connectionString: url!, max: 1 });
		pools.push(adminPool);
		await adminPool.query(`create database ${name}`);
		const target = new URL(url!);
		target.pathname = `/${name}`;
		const pool = new pg.Pool({ connectionString: target.toString(), max: 4, options: '-c TimeZone=UTC' });
		// pool.end() resolves before its idle sockets close; the forced drop below then kills them (57P01)
		pool.on('error', () => {});
		try {
			const db = postgresDb(pool);
			await migrate(db);
			const r = await race(db);
			expect(kinds(r.outcomes)).toEqual(['committed', 'refused:quota']);
			expect(r.count).toBe(2);
		} finally {
			await pool.end();
			await adminPool.query(`drop database if exists ${name} with (force)`);
		}
	});
});
