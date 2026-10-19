// transform-read-race (rule 26, L-BOLT-146): two acts whose transforms read the same quota before either commits. The
// first commits; the second's fingerprint no longer matches under its table lock, so it replays once with the same
// clock and ids, re-reads, and refuses. On PGlite (one connection) the race is the guest window between read and
// commit, which interleaves in process; the lock contention itself runs on Postgres when `BOLT_TEST_PG` names a server
// (a scratch database is created and dropped), and is skipped otherwise.
import { createRequire } from 'node:module';
import { describe, expect, it } from '@effect/vitest';
import { Deferred, Effect, Schema } from 'effect';
import { Pristine } from '../src/engine/db/pglite.ts';
import { TenantDb, type TenantDbShape } from '../src/engine/db/tenant-db.ts';
import { type GuestShape } from '../src/engine/services.ts';
import { DbError } from '../src/engine/errors.ts';
import { BoltError } from '../src/protocol/errors.ts';
import type { Outcome } from '../src/engine/contracts.ts';
import { catalogOf } from '../src/engine/access/pred.ts';
import { PostgresDb, type PgPool } from '../src/engine/db/postgres.ts';
import * as ir from '../src/protocol/ir.ts';
import { act } from '../src/engine/write/act.ts';
import { admin, NOW, TODAY } from './write-fixture.ts';
import { bridgeOn, manifest, migrate, open } from './write-p2.fixture.ts';
/** Orders are capped at two: the transform counts them (a workspace read) and refuses the third. */
const race = Effect.fnUntraced(function* (db: TenantDbShape) {
	let invoked = 0,
		arrived = 0;
	const both = yield* Deferred.make<void>();
	const guest: GuestShape = {
		invokeProgram: () =>
			Effect.die(new Error('This fixture does not execute supplied guest programs.')),
		invoke: (inv, bridge) =>
			Effect.gen(function* () {
				const racing = ++invoked === 2 || invoked === 3;
				const [a] = yield* bridge.cross([
					{
						_tag: 'read',
						read: ir.aggregate(catalogOf(manifest), 'orders', { count: true }),
						params: {}
					}
				]);
				if (a?.ok !== true)
					return yield* Effect.fail(BoltError.make('badAnswer', 'guest', 'The quota read failed.'));
				const { count: n } = yield* Schema.decodeUnknownEffect(
					Schema.Struct({ count: Schema.Number })
				)(a.value).pipe(
					Effect.mapError((error) => BoltError.make('badAnswer', 'guest', error.message, error))
				);
				if (racing) {
					if (++arrived === 2) yield* Deferred.succeed(both, undefined);
					yield* Deferred.await(both);
				}
				return n >= 2
					? { kind: 'refused' as const, message: 'quota', cpuMs: 1 }
					: { kind: 'ok' as const, output: inv.input, cpuMs: 1 };
			}).pipe(Effect.orDie)
	};
	const e = { manifest, db, transforms: new Set(['orders']), guest, bridge: bridgeOn(db) };
	const run = (title: string) =>
		act(e, {
			collection: 'orders',
			verb: 'create',
			mode: { _tag: 'Direct' },
			input: { title },
			key: title,
			issuedAt: NOW,
			authority: admin,
			bindings: { now: NOW, today: TODAY, tz: 'UTC', params: {} },
			invocationId: `inv-${title}`
		});
	yield* run('first');
	const [a, b] = yield* Effect.all([run('a'), run('b')], { concurrency: 'unbounded' });
	const count = yield* db.value(Schema.Number, {
		text: 'select count(*)::int as n from orders',
		params: []
	});
	return { outcomes: [a.outcome, b.outcome], invoked, count };
});
const kinds = (os: readonly Outcome[]) =>
	os.map((o) => (o.kind === 'refused' ? `refused:${o.message}` : o.kind)).sort();
describe('engine/write: transform-read-race (rule 26)', () => {
	it.live('PGlite: the loser replays once, re-reads the moved quota, and refuses', () =>
		Effect.gen(function* () {
			const { db } = yield* open();
			const r = yield* race(db);
			expect(kinds(r.outcomes)).toEqual(['committed', 'refused:quota']);
			expect(r.count).toBe(2);
			expect(r.invoked).toBe(4); // 'first', a, b, and b's one replay
		}).pipe(Effect.provide(Pristine.layer))
	);
	it.live('stops after one serialization replay and preserves guest invocation bindings', () =>
		Effect.gen(function* () {
			const { db } = yield* open();
			let writes = 0;
			const seen: {
				id: string;
				seed: string;
				now: string;
				today: string;
			}[] = [];
			const guest: GuestShape = {
				invokeProgram: () =>
					Effect.die(new Error('This fixture does not execute supplied guest programs.')),
				invoke: Effect.fnUntraced(function* (inv) {
					seen.push({ id: inv.id, seed: inv.ctx.seed, now: inv.ctx.now, today: inv.ctx.today });
					return { kind: 'ok', output: inv.input, cpuMs: 1 };
				})
			};
			const failing = TenantDb.typed({
				...db,
				write: (statement, lock) =>
					Effect.suspend(() =>
						++writes <= 2
							? Effect.fail(DbError.make('40001', 'serialization fixture'))
							: db.write(statement, lock)
					)
			});
			const result = yield* act(
				{ manifest, db: failing, transforms: new Set(['orders']), guest, bridge: bridgeOn(db) },
				{
					collection: 'orders',
					verb: 'create',
					mode: { _tag: 'Direct' },
					input: { title: 'bounded replay' },
					key: 'bounded',
					issuedAt: NOW,
					authority: admin,
					bindings: { now: NOW, today: TODAY, tz: 'UTC', params: {} },
					invocationId: 'inv-bounded'
				}
			);
			expect(result.outcome).toEqual({ kind: 'conflict', records: [] });
			expect(seen).toHaveLength(2);
			expect(seen[1]).toEqual(seen[0]);
			expect(writes).toBe(3); // two commit attempts, then the terminal outcome record
		}).pipe(Effect.provide(Pristine.layer))
	);
	const url = process.env['BOLT_TEST_PG'];
	it.live.skipIf(url === undefined)(
		'Postgres: the same race under the real SHARE ROW EXCLUSIVE lock (BOLT_TEST_PG)',
		() =>
			Effect.gen(function* () {
				const pg = createRequire(new URL('../../bolt-server/package.json', import.meta.url))(
					'pg'
				) as {
					Pool: new (o: { connectionString: string; max?: number; options?: string }) => PgPool & {
						query(t: string): Promise<unknown>;
						end(): Promise<void>;
						on(e: 'error', f: () => void): void;
					};
				};
				if (url === undefined)
					return yield* Effect.fail(new Error('BOLT_TEST_PG must be configured.'));
				const edge = <A>(f: () => Promise<A>) =>
					Effect.tryPromise({ try: f, catch: (error) => DbError.make('XX000', String(error)) });
				const name = `bolt_race_${process.pid}_${Date.now()}`;
				const adminPool = yield* Effect.acquireRelease(
					Effect.sync(() => new pg.Pool({ connectionString: url, max: 1 })),
					(pool) => edge(() => pool.end()).pipe(Effect.orDie)
				);
				yield* Effect.acquireRelease(
					edge(() => adminPool.query(`create database ${name}`)),
					() =>
						edge(() => adminPool.query(`drop database if exists ${name} with (force)`)).pipe(
							Effect.orDie
						)
				);
				const target = new URL(url);
				target.pathname = `/${name}`;
				const pool = yield* Effect.acquireRelease(
					Effect.sync(
						() =>
							new pg.Pool({
								connectionString: target.toString(),
								max: 4,
								options: '-c TimeZone=UTC'
							})
					),
					(pool) => edge(() => pool.end()).pipe(Effect.orDie)
				);
				pool.on('error', () => {});
				const db = PostgresDb.make(pool);
				yield* migrate(db);
				const r = yield* race(db);
				expect(kinds(r.outcomes)).toEqual(['committed', 'refused:quota']);
				expect(r.count).toBe(2);
			})
	);
});
