import { Effect } from 'effect';
import { fixtureUserId } from '../support/fixture-identity.js';
import { afterEach, describe, expect, it } from 'vitest';
import {
	EffectId,
	type CommunicationRequest,
	type CommunicationResponse,
	type FacilityBinding,
	type IdentityHookRequest,
	type IdentityHookResponse
} from '@norbital-ai/bolt-protocol';
import * as Identity from '../../src/runtime/identity/identity.js';
import { makeBoltTestRuntime, type BoltTestRuntime } from '../support/bolt-test-layer.js';

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

		expect(invitationId).toBe('test-tenant:invite-1');
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

		await harness.runtime.runPromise(
			Effect.gen(function* () {
				yield* (yield* Identity.Service).acceptInvitation(EffectId.make('accept-1'), 'inv-1', 'u1');
			})
		);

		expect(hooks.events).toEqual([
			{
				_tag: 'MembershipChanged',
				userId: 'u1',
				organizationId: 'test-tenant',
				email: 'ada@example.test',
				action: 'joined'
			},
			{
				_tag: 'UserChanged',
				userId: 'u1',
				organizationId: 'test-tenant',
				email: 'ada@example.test'
			}
		]);
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

		expect(result.invitationId).toBe('test-tenant:invite-2');
		expect(result.credential.startsWith('bolt:test-tenant:')).toBe(true);
	});
});
