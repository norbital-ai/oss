import { describe, expect, it } from '@effect/vitest';
import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import { Effect, Result } from 'effect';
import { RateWindows } from '../src/engine/access/rate.ts';
import type { RowData } from '../src/engine/contracts.ts';
import { TenantDb } from '../src/engine/db/tenant-db.ts';
import { DbError } from '@norbital-ai/host-api';
import { authenticate, defaultName, make_identity_host, SESSION_MEMO_MS } from '../src/engine/identity/session.ts';

/** An identity host whose native database answers one session row (or fails), counting reads; `later` moves its clock past the session memo. */
const host = Effect.fnUntraced(function* (
	answer: () => Effect.Effect<readonly RowData[], DbError>
) {
	let reads = 0,
		at = Date.parse('2026-09-26T00:00:00Z');
	const db = TenantDb.typed({
		read: () =>
			Effect.gen(function* () {
				reads++;
				return [{ rows: yield* answer(), affected: 0 }];
			}),
		write: () => Effect.succeed({ rows: [], affected: 0 }),
		transaction: () => Effect.die(new Error('unused'))
	});
	const h = yield* make_identity_host({
		db,
		now: Effect.sync(() => new Date(at)),
		windows: new RateWindows(),
		keys: { session: Buffer.alloc(32), ipMac: Buffer.alloc(32) },
		public_url: 'https://w.test'
	}).pipe(Effect.provide(NodeCrypto.layer));
	return { h, reads: () => reads, later: () => void (at += SESSION_MEMO_MS) };
});
const row = {
	id: 's1',
	user: 'u1',
	impersonated_by: null,
	agent: null,
	via: 'code',
	refreshed_at: '2026-09-26T00:00:00Z',
	last_seen: '2026-09-26T00:00:00Z',
	expires_at: '2026-10-03T00:00:00Z'
};

describe('session authentication', () => {
	it.effect('checks a previously accepted token again after its row is removed', () =>
		Effect.gen(function* () {
			let rows: readonly RowData[] = [row];
			const t = yield* host(() => Effect.succeed(rows));
			expect(yield* authenticate(t.h, 'tok')).toEqual({
				user: 'u1',
				session: 's1',
				impersonatedBy: null,
				agent: null,
				expiresAt: expect.any(Number)
			});
			expect(t.reads()).toBe(1);
			rows = [];
			expect(t.h.db.identityWrites()).toBe(0);
			// within the memo the accepted session answers from memory; past it, the removed row refuses
			expect(yield* authenticate(t.h, 'tok')).toMatchObject({ user: 'u1' });
			expect(t.reads()).toBe(1);
			t.later();
			expect(yield* Effect.flip(authenticate(t.h, 'tok'))).toMatchObject({ code: 'not_member' });
			expect(t.reads()).toBe(2);
		})
	);

	it.effect('preserves the difference between a missing session and a database failure', () =>
		Effect.gen(function* () {
			let answer: () => Effect.Effect<readonly RowData[], DbError> = () => Effect.succeed([]);
			const t = yield* host(() => answer());
			const absent = yield* Effect.result(authenticate(t.h, 'tok'));
			expect(Result.isFailure(absent) && absent.failure).toMatchObject({
				_tag: 'IdentityRefusal',
				code: 'not_member'
			});
			const failure = DbError.make('08006', 'db down');
			answer = () => Effect.fail(failure);
			t.later();
			const unavailable = yield* Effect.result(authenticate(t.h, 'tok'));
			expect(Result.isFailure(unavailable) && unavailable.failure).toBe(failure);
			answer = () => Effect.succeed([row]);
			expect(yield* authenticate(t.h, 'tok')).toMatchObject({ user: 'u1' });
			expect(t.reads()).toBe(3);
		})
	);

	it.effect('reads the database of the identity host receiving the token', () =>
		Effect.gen(function* () {
			const a = yield* host(() => Effect.succeed([row])),
				b = yield* host(() => Effect.succeed([]));
			expect(yield* authenticate(a.h, 'tok')).toMatchObject({ user: 'u1' });
			const absent = yield* Effect.result(authenticate(b.h, 'tok'));
			expect(Result.isFailure(absent) && absent.failure).toMatchObject({
				_tag: 'IdentityRefusal',
				code: 'not_member'
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
