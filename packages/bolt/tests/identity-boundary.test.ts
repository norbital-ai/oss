import { describe, expect, it } from '@effect/vitest';
import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import { Effect } from 'effect';
import { RateWindows } from '../src/engine/access/rate.ts';
import { TenantDb } from '../src/engine/db/tenant-db.ts';
import type { EngineError } from '../src/engine/errors.ts';
import { Authorities } from '../src/engine/identity/actor.ts';
import { authenticateKey, acceptInvitation, inspectInvitation } from '../src/engine/identity/members.ts';
import { make_identity_host } from '../src/engine/identity/session.ts';
import { manifest } from './catalogue-fixture.ts';

describe('native identity response boundaries', () => {
	it.effect('distinguishes a missing native batch result from an absent invitation or key', () =>
		Effect.gen(function* () {
			let complete = false;
			const db = TenantDb.typed({
				read: (statements) => Effect.sync(() => complete ? statements.map(() => ({ rows: [], affected: 0 })) : []),
				write: () => Effect.die(new Error('This identity read must not write.')),
				transaction: () => Effect.die(new Error('This identity read must not start a transaction.'))
			});
			const h = yield* make_identity_host({
				db,
				now: Effect.sync(() => new Date('2026-09-26T00:00:00Z')),
				windows: new RateWindows(),
				keys: { session: Buffer.alloc(32), ipMac: Buffer.alloc(32) },
				public_url: 'https://workspace.test'
			}).pipe(Effect.provide(NodeCrypto.layer));
			const bearer = `nbk_0123456789ab_${'x'.repeat(43)}`;
			const authorities = new Authorities(manifest, 'release');
			const actions: readonly Effect.Effect<unknown, EngineError>[] = [
				inspectInvitation(h, 'inv'), acceptInvitation(h, { user: 'u' }, 'inv'), authenticateKey(h, bearer),
				authorities.member(db, 'bootstrap', 'u'), authorities.api_key(db, 'key')
			];
			// the tenant database boundary refuses an incomplete batch before an identity read can mistake it for absence
			for (const action of actions)
				expect(yield* Effect.flip(action)).toMatchObject({ _tag: 'DbError', sqlstate: 'XX000' });
			complete = true;
			expect(yield* inspectInvitation(h, 'inv')).toBe(null);
			expect(yield* authenticateKey(h, bearer)).toBe(null);
			expect(yield* authorities.member(db, 'bootstrap', 'u')).toBe(null);
			expect(yield* authorities.api_key(db, 'key')).toBe(null);
			expect(yield* Effect.flip(acceptInvitation(h, { user: 'u' }, 'inv'))).toMatchObject({ _tag: 'IdentityRefusal', code: 'not_found' });
		})
	);
	it.effect('refuses an unknown native member kind instead of treating it as staff', () =>
		Effect.gen(function* () {
			const db = TenantDb.typed({
				read: () => Effect.succeed([{ rows: [{
					id: 'u', email: null, phone: null, kind: 'unrecognized', active: true, admin: false,
					team: null, party: null, signup: false, revision: 1
				}], affected: 0 }]),
				write: () => Effect.die(new Error('An invalid member must not write.')),
				transaction: () => Effect.die(new Error('An invalid member must not start a transaction.'))
			});
			expect(yield* Effect.flip(new Authorities(manifest, 'release').member(db, 'bootstrap', 'u')))
				.toMatchObject({ _tag: 'BoltError', code: 'corrupt' });
		})
	);
});
