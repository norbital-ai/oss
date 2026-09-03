import { Effect } from 'effect';
import { fixtureUserId } from './support/fixture-identity.js';
import { afterEach, describe, expect, it } from 'vitest';
import {
	EffectId,
	type CommunicationRequest,
	type CommunicationResponse,
	type FacilityBinding,
	type IdentityHookRequest,
	type IdentityHookResponse
} from '@norbital-ai/bolt-protocol';
import * as Identity from '../src/runtime/identity/identity.js';
import { makeBoltTestRuntime, type BoltTestRuntime } from './support/bolt-test-layer.js';

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

const acknowledgeCommunication: FacilityBinding<CommunicationRequest, CommunicationResponse> = {
	call: async () => ({ _tag: 'Success', value: {} })
};

const recordingHooks = (): {
	readonly events: Array<IdentityHookRequest>;
	readonly binding: FacilityBinding<IdentityHookRequest, IdentityHookResponse>;
} => {
	const events: Array<IdentityHookRequest> = [];
	return {
		events,
		binding: {
			call: async (_metadata, input) => {
				events.push(input);
				return { _tag: 'Success', value: { acknowledged: true } };
			}
		}
	};
};

describe('identity lifecycle hooks', () => {
	it('invite emits UserInvited with organizationId equal to the tenant id', async () => {
		const hooks = recordingHooks();
		harness = await makeBoltTestRuntime(undefined, {
			communication: acknowledgeCommunication,
			identityHooks: hooks.binding
		});
		const invitationId = await harness.runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Identity.Service).invite(
					EffectId.make('invite-1'),
					'test-tenant',
					'ada@example.test',
					'admin-1'
				);
			})
		);

		expect(invitationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
		expect(hooks.events).toEqual([
			{
				_tag: 'UserInvited',
				invitationId,
				organizationId: 'test-tenant',
				email: 'ada@example.test',
				invitedBy: 'admin-1'
			}
		]);
	});

	it('acceptInvitation emits MembershipChanged joined and UserChanged', async () => {
		const hooks = recordingHooks();
		harness = await makeBoltTestRuntime(undefined, { identityHooks: hooks.binding });
		await harness.database.query(
			`insert into bolt_invitations (invitation_id, tenant_id, email, invited_by, status)
			 values ('inv-1', 'test-tenant', 'ada@example.test', 'admin-1', 'pending')`
		);
		await harness.database.query(
			`insert into "user" ("id", "name", "email", "tenantId")
			 values (md5('u1'::text)::uuid, 'Ada', 'ada@example.test', 'test-tenant')`
		);

		const outcome = await harness.runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Identity.Service).acceptInvitation(
					EffectId.make('accept-1'),
					'inv-1',
					{
						userId: fixtureUserId('u1'),
						tenantId: 'test-tenant',
						teamPath: [],
						policies: [],
						admin: false,
						email: 'ada@example.test'
					}
				);
			})
		);

		expect(outcome).toEqual({ state: 'accepted' });
		expect(hooks.events).toEqual([
			{
				_tag: 'MembershipChanged',
				userId: fixtureUserId('u1'),
				organizationId: 'test-tenant',
				email: 'ada@example.test',
				action: 'joined'
			},
			{
				_tag: 'UserChanged',
				userId: fixtureUserId('u1'),
				organizationId: 'test-tenant',
				email: 'ada@example.test'
			}
		]);
	});

	it('inspects invitation links without consuming them and accepts only the invited account', async () => {
		harness = await makeBoltTestRuntime();
		await harness.database.query(
			`insert into bolt_invitations
				(invitation_id, tenant_id, email, invited_by, status, expires_at)
			 values ('inv-probe-safe', 'test-tenant', 'ada@example.test', 'admin-1', 'pending', now() + interval '1 hour')`
		);

		const inspect = (effectId: string) =>
			harness!.runtime.runPromise(
				Effect.flatMap(Identity.Service, (identity) =>
					identity.inspectInvitation(EffectId.make(effectId), 'test-tenant', 'inv-probe-safe')
				)
			);
		expect(await inspect('inspect:first')).toEqual({ state: 'ready' });
		expect(await inspect('inspect:scanner')).toEqual({ state: 'ready' });
		expect(
			await harness.database.query(
				`select status, accepted_by from bolt_invitations where invitation_id = 'inv-probe-safe'`
			)
		).toEqual([{ status: 'pending', accepted_by: null }]);

		const wrongAccount = await harness.runtime.runPromise(
			Effect.flatMap(Identity.Service, (identity) =>
				identity.acceptInvitation(EffectId.make('accept:wrong'), 'inv-probe-safe', {
					userId: fixtureUserId('grace'),
					tenantId: 'test-tenant',
					teamPath: [],
					policies: [],
					admin: false,
					email: 'grace@example.test'
				})
			)
		);
		expect(wrongAccount).toEqual({ state: 'wrong_account' });
		expect(await inspect('inspect:after-wrong-account')).toEqual({ state: 'ready' });

		const accepted = await harness.runtime.runPromise(
			Effect.flatMap(Identity.Service, (identity) =>
				identity.acceptInvitation(EffectId.make('accept:ada'), 'inv-probe-safe', {
					userId: fixtureUserId('ada'),
					tenantId: 'test-tenant',
					teamPath: [],
					policies: [],
					admin: false,
					email: 'ADA@example.test'
				})
			)
		);
		expect(accepted).toEqual({ state: 'accepted' });
		expect(await inspect('inspect:accepted')).toEqual({ state: 'accepted' });
	});

	it('expires invitation links without mutating them on inspection', async () => {
		harness = await makeBoltTestRuntime();
		await harness.database.query(
			`insert into bolt_invitations
				(invitation_id, tenant_id, email, invited_by, status, expires_at)
			 values ('inv-expired', 'test-tenant', 'ada@example.test', 'admin-1', 'pending', now() - interval '1 second')`
		);

		const inspected = await harness.runtime.runPromise(
			Effect.flatMap(Identity.Service, (identity) =>
				identity.inspectInvitation(EffectId.make('inspect:expired'), 'test-tenant', 'inv-expired')
			)
		);
		expect(inspected).toEqual({ state: 'expired' });
		expect(
			await harness.database.query(
				`select status, accepted_by from bolt_invitations where invitation_id = 'inv-expired'`
			)
		).toEqual([{ status: 'pending', accepted_by: null }]);
	});

	it('startSession emits UserChanged', async () => {
		const hooks = recordingHooks();
		harness = await makeBoltTestRuntime(undefined, { identityHooks: hooks.binding });
		// `startSession` mints for an existing subject and refuses an unknown one, so the person has
		// to exist before a session can be started for them. That refusal is the point: the previous
		// implementation would issue a live credential for any user id it was handed.
		await harness.database.query(
			`insert into "user" ("id", "name", "tenantId") values (md5($1::text)::uuid, $1, 'test-tenant') on conflict ("id") do nothing`,
			['u1']
		);
		await harness.runtime.runPromise(
			Effect.gen(function* () {
				yield* (yield* Identity.Service).startSession(
					EffectId.make('start-1'),
					fixtureUserId('u1'),
					'test-tenant'
				);
			})
		);

		expect(hooks.events).toEqual([
			{
				_tag: 'UserChanged',
				userId: fixtureUserId('u1'),
				organizationId: 'test-tenant'
			}
		]);
	});

	it('invite and startSession still succeed when identityHooks is unbound', async () => {
		harness = await makeBoltTestRuntime(undefined, { communication: acknowledgeCommunication });
		// `startSession` mints for an existing subject and refuses an unknown one, so the person has
		// to exist before a session can be started for them. That refusal is the point: the previous
		// implementation would issue a live credential for any user id it was handed.
		await harness.database.query(
			`insert into "user" ("id", "name", "tenantId") values (md5($1::text)::uuid, $1, 'test-tenant') on conflict ("id") do nothing`,
			['u2']
		);
		const result = await harness.runtime.runPromise(
			Effect.gen(function* () {
				const identity = yield* Identity.Service;
				const invitationId = yield* identity.invite(
					EffectId.make('invite-2'),
					'test-tenant',
					'grace@example.test',
					'admin-1'
				);
				const credential = yield* identity.startSession(
					EffectId.make('start-2'),
					fixtureUserId('u2'),
					'test-tenant'
				);
				return { invitationId, credential };
			})
		);

		expect(result.invitationId).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
		);
		expect(result.credential.startsWith('bolt:test-tenant:')).toBe(true);
	});
});
