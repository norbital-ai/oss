// callback-read-race (rule 26, L-BOLT-146): two acts whose callbacks read the same quota before either commits. The
// first commits; the second's fingerprint no longer matches under its table lock, so it replays once with the same
// clock and ids, re-reads, and refuses.
import { describe, expect, it } from '@effect/vitest';
import { Deferred, Effect, Schema } from 'effect';
import { Pristine } from '../src/node/db/pglite.ts';
import { TenantDb, type TenantDbShape } from '../src/engine/db/tenant-db.ts';
import { type GuestShape } from '../src/engine/services.ts';
import { DbError } from '../src/engine/errors.ts';
import { BoltError, fromStore } from '../src/protocol/errors.ts';
import type { Outcome } from '../src/engine/contracts.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { catalogOf } from '../src/engine/access/pred.ts';
import { aggregate } from '@norbital-ai/store';
import { act } from '../src/engine/write/act.ts';
import { admin, NOW, TODAY } from './write-fixture.ts';
import { bridgeOn, manifest, open } from './write-p2.fixture.ts';
const orders = manifest.exposures['orders'];
if (orders?.create === undefined) throw new Error('The race fixture has no orders create contract');
const callbacks: EngineManifest = {
	...manifest,
	exposures: {
		...manifest.exposures,
		orders: { ...orders, create: { ...orders.create, transform: true } }
	}
};
/** Orders are capped at two: the create callback counts them and refuses the third. */
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
						read: yield* aggregate(catalogOf(manifest), 'orders', { count: true }).pipe(
							Effect.mapError(fromStore)
						)
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
					? { kind: 'refused' as const, message: 'quota' }
					: { kind: 'ok' as const, output: inv.input };
			}).pipe(Effect.orDie)
	};
	const e = { manifest: callbacks, db, guest, bridge: bridgeOn(db, callbacks) };
	const run = (title: string) =>
		act(e, {
			model: 'orders',
			verb: 'create',
			mode: { _tag: 'Direct' },
			input: [{ title }],
			key: title,
			issuedAt: NOW,
			authority: admin,
			bindings: { now: NOW, today: TODAY, tz: 'UTC' },
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
describe('engine/write: callback-read-race (rule 26)', () => {
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
			let attempts = 0;
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
					return { kind: 'ok', output: inv.input };
				})
			};
			const failing = TenantDb.typed({
				...db,
				transaction: (batch) =>
					Effect.suspend(() =>
						++attempts <= 2
							? Effect.fail(DbError.make('40001', 'serialization fixture'))
							: db.transaction(batch)
					)
			});
			const result = yield* act(
				{ manifest: callbacks, db: failing, guest, bridge: bridgeOn(db, callbacks) },
				{
					model: 'orders',
					verb: 'create',
					mode: { _tag: 'Direct' },
					input: [{ title: 'bounded replay' }],
					key: 'bounded',
					issuedAt: NOW,
					authority: admin,
					bindings: { now: NOW, today: TODAY, tz: 'UTC' },
					invocationId: 'inv-bounded'
				}
			);
			expect(result.outcome).toEqual({ kind: 'conflict', records: [] });
			expect(seen).toHaveLength(2);
			expect(seen[1]).toEqual(seen[0]);
			expect(attempts).toBe(2);
			expect(
				yield* db.value(Schema.Int, { text: 'SELECT count(*)::int FROM orders', params: [] })
			).toBe(0);
		}).pipe(Effect.provide(Pristine.layer))
	);
});
