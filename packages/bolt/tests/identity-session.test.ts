import { describe, expect, it } from '@effect/vitest';
import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import { Effect, Result } from 'effect';
import { TestClock } from 'effect/testing';
import { RateWindows } from '../src/engine/access/rate.ts';
import type { RowData } from '../src/engine/contracts.ts';
import { TenantDb } from '../src/engine/db/tenant-db.ts';
import { DbError } from '../src/engine/errors.ts';
import {
	authenticate,
	defaultName,
	forget,
	makeIdentityHost
} from '../src/engine/identity/session.ts';

/** An identity host whose native database answers one session row (or fails), counting reads. */
const host = Effect.fnUntraced(function* (
	answer: () => Effect.Effect<readonly RowData[], DbError>
) {
	let clock = Date.parse('2026-09-26T00:00:00Z'),
		reads = 0;
	const db = TenantDb.typed({
		read: () =>
			Effect.gen(function* () {
				reads++;
				return [{ rows: yield* answer(), affected: 0 }];
			}),
		write: () => Effect.succeed({ rows: [], affected: 0 }),
		session: () =>
			Effect.fail(DbError.make('0A000', 'this fixture does not support leased sessions')),
		transaction: () => Effect.die(new Error('unused'))
	});
	const h = yield* makeIdentityHost({
		db,
		now: Effect.sync(() => new Date(clock)),
		windows: new RateWindows(),
		keys: { session: Buffer.alloc(32), ipMac: Buffer.alloc(32) },
		publicUrl: 'https://w.test'
	}).pipe(Effect.provide(NodeCrypto.layer));
	return {
		h,
		reads: () => reads,
		tick: (ms: number) => {
			clock += ms;
		}
	};
});
const row = {
	id: 's1',
	user: 'u1',
	impersonated_by: null,
	agent: null,
	refreshed_at: '2026-09-26T00:00:00Z',
	expires_at: '2026-10-03T00:00:00Z'
};

describe('session memo (L-COL-034)', () => {
	it.effect('reads once per token for 30 s, single-flight, and re-reads after', () =>
		Effect.gen(function* () {
			const t = yield* host(() => Effect.succeed([row]));
			const [a, b] = yield* Effect.all([authenticate(t.h, 'tok'), authenticate(t.h, 'tok')], {
				concurrency: 'unbounded'
			});
			expect(a).toEqual({
				user: 'u1',
				session: 's1',
				impersonatedBy: null,
				agent: null,
				expiresAt: expect.any(Number)
			});
			expect(b).toEqual(a);
			expect(yield* authenticate(t.h, 'tok')).toEqual(a);
			expect(t.reads()).toBe(1);
			t.tick(30_001);
			yield* TestClock.adjust(30_001);
			yield* authenticate(t.h, 'tok');
			expect(t.reads()).toBe(2);
		})
	);

	it.effect('never keeps a miss or a failure, and forgets a signed-out token', () =>
		Effect.gen(function* () {
			let answer: () => Effect.Effect<readonly RowData[], DbError> = () => Effect.succeed([]);
			const t = yield* host(() => answer());
			const absent = yield* Effect.result(authenticate(t.h, 'tok'));
			expect(Result.isFailure(absent) && absent.failure).toMatchObject({
				_tag: 'IdentityRefusal',
				code: 'notMember'
			});
			const failure = DbError.make('08006', 'db down');
			answer = () => Effect.fail(failure);
			const unavailable = yield* Effect.result(authenticate(t.h, 'tok'));
			expect(Result.isFailure(unavailable) && unavailable.failure).toBe(failure);
			answer = () => Effect.succeed([row]);
			expect(yield* authenticate(t.h, 'tok')).toMatchObject({ user: 'u1' });
			expect(t.reads()).toBe(3);
			yield* forget(t.h, 'tok');
			answer = () => Effect.succeed([]);
			const signedOut = yield* Effect.result(authenticate(t.h, 'tok'));
			expect(Result.isFailure(signedOut) && signedOut.failure).toMatchObject({
				_tag: 'IdentityRefusal',
				code: 'notMember'
			});
		})
	);

	it.effect('is per identity host, so a new generation starts empty', () =>
		Effect.gen(function* () {
			const a = yield* host(() => Effect.succeed([row])),
				b = yield* host(() => Effect.succeed([]));
			expect(yield* authenticate(a.h, 'tok')).toMatchObject({ user: 'u1' });
			const absent = yield* Effect.result(authenticate(b.h, 'tok'));
			expect(Result.isFailure(absent) && absent.failure).toMatchObject({
				_tag: 'IdentityRefusal',
				code: 'notMember'
			});
		})
	);
});

describe("a new member's default name (A12)", () => {
	it('is the email local part as title-cased words, never the raw handle', () => {
		expect(defaultName({ kind: 'email', value: 'mei.ling.tan@x.test' })).toBe('Mei Ling Tan');
		expect(defaultName({ kind: 'email', value: 'ada_lovelace-byron@x.test' })).toBe(
			'Ada Lovelace Byron'
		);
		expect(defaultName({ kind: 'email', value: 'ops@x.test' })).toBe('Ops');
		expect(defaultName({ kind: 'phone', value: '+6581234567' })).toBe('+6581234567');
	});
});
