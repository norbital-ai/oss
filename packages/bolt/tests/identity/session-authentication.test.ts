import { Effect } from 'effect';
import { fixtureUserId } from '../support/fixture-identity.js';
import { afterEach, describe, expect, it } from 'vitest';
import { EffectId } from '@norbital-ai/bolt-protocol';
import { Identity } from '../../src/runtime/identity/identity.js';
import { makeBoltTestRuntime, type BoltTestRuntime } from '../support/bolt-test-layer.js';

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

/**
 * Every other identity fixture inserts its own session row with an email, so none of them exercise
 * the row `startSession` actually writes. These do: the session is created through the service, and
 * the columns it leaves unset are the ones under test.
 */
describe('session authentication', () => {
	it('authenticates a session started through the service, which sets no email', async () => {
		harness = await makeBoltTestRuntime();
		// `startSession` mints for an existing subject and refuses an unknown one, so the person has
		// to exist before a session can be started for them. That refusal is the point: the previous
		// implementation would issue a live credential for any user id it was handed.
		await harness.database.query(
			`insert into bolt_auth_user ("norbital_id", "name", "tenantId") values (md5($1::text)::uuid, $1, 'test-tenant') on conflict ("norbital_id") do nothing`,
			['u1']
		);
		const subject = await harness.runtime.runPromise(
			Effect.gen(function* () {
				const identity = yield* Identity.Service;
				const credential = yield* identity.startSession(
					EffectId.make('start-1'),
					fixtureUserId('u1'),
					'test-tenant'
				);
				return yield* identity.authenticate(EffectId.make('auth-1'), credential);
			})
		);

		expect(subject.userId).toBe(fixtureUserId('u1'));
		expect(subject.tenantId).toBe('test-tenant');
		expect(subject.roles).toEqual([]);
		expect(subject.teams).toEqual([]);
		expect(subject.email).toBeUndefined();
	});

	it('resolves an external subject whose email column is null', async () => {
		harness = await makeBoltTestRuntime();
		await harness.database.query(
			`insert into bolt_external_subjects (provider, external_id, user_id, tenant_id, roles, teams)
			 values ('colony', 'ext-1', 'u2', 'test-tenant', '["basic"]'::jsonb, '["Platform"]'::jsonb)`,
			[]
		);

		const subject = await harness.runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Identity.Service).resolveSubject(
					EffectId.make('resolve-1'),
					'colony',
					'ext-1'
				);
			})
		);

		expect(subject.userId).toBe('u2');
		expect(subject.roles).toEqual(['basic']);
		expect(subject.teams).toEqual(['Platform']);
		expect(subject.email).toBeUndefined();
	});

	it('carries the email through when the session row has one', async () => {
		harness = await makeBoltTestRuntime();
		await harness.database.query(
			`with person as (insert into bolt_auth_user ("norbital_id", "name", "email", "tenantId", "roles", "teams") values (md5('u3'::text)::uuid, 'u3', 'ada@example.test', 'test-tenant', '["admin"]'::jsonb, '[]'::jsonb) on conflict ("norbital_id") do update set "roles" = excluded."roles", "teams" = excluded."teams", "email" = excluded."email", "tenantId" = excluded."tenantId" returning "norbital_id" as id) insert into bolt_auth_session ("norbital_id", "token", "userId", "expiresAt") select gen_random_uuid(), 'token-u3', person.id, now() + interval '1 hour' from person`,
			[]
		);

		const subject = await harness.runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Identity.Service).authenticate(EffectId.make('auth-2'), 'token-u3');
			})
		);

		expect(subject.email).toBe('ada@example.test');
		expect(subject.roles).toEqual(['admin']);
	});
});
