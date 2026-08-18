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

const access = (harness: BoltTestRuntime) =>
	harness.runtime.runPromise(
		Effect.gen(function* () {
			return yield* (yield* Identity.Service).workspaceAccess(
				EffectId.make('access-1'),
				'test-tenant'
			);
		})
	);

const addSession = (
	harness: BoltTestRuntime,
	userId: string,
	roles: ReadonlyArray<string>,
	teams: ReadonlyArray<string>,
	email: string
) =>
	harness.database.query(
		`with person as (insert into bolt_auth_user ("norbital_id", "name", "email", "tenantId", "roles", "teams") values (md5($2::text)::uuid, $2, $5, 'test-tenant', $3::jsonb, $4::jsonb) on conflict ("norbital_id") do update set "roles" = excluded."roles", "teams" = excluded."teams", "email" = excluded."email", "tenantId" = excluded."tenantId" returning "norbital_id" as id) insert into bolt_auth_session ("norbital_id", "token", "userId", "expiresAt") select gen_random_uuid(), $1, person.id, now() + interval '1 hour' from person`,
		[`token-${userId}`, userId, JSON.stringify([...roles]), JSON.stringify([...teams]), email]
	);

describe('workspace access projection', () => {
	it('reports one member per user, with their highest role and their teams', async () => {
		harness = await makeBoltTestRuntime();
		await addSession(harness, 'u1', ['admin', 'basic'], ['Platform'], 'ada@example.test');
		await addSession(harness, 'u2', ['basic'], ['Platform', 'People'], 'grace@example.test');

		const result = await access(harness);
		// Compared as a set: members come back ordered by id, and an id is a uuid, so the order is
		// the hash's rather than the readable name's and asserting it would be asserting md5.
		expect(result.members.map(({ id, role }) => [id, role]).sort()).toEqual(
			[
				[fixtureUserId('u1'), 'admin'],
				[fixtureUserId('u2'), 'basic']
			].sort()
		);
		expect(result.members.find(({ id }) => id === fixtureUserId('u2'))?.teams).toEqual([
			'People',
			'Platform'
		]);
	});

	it('collapses several sessions for one user into a single member', async () => {
		harness = await makeBoltTestRuntime();
		await addSession(harness, 'u1', ['basic'], [], 'ada@example.test');
		await harness.database.query(
			`with person as (insert into bolt_auth_user ("norbital_id", "name", "email", "tenantId", "roles", "teams") values (md5('u1'::text)::uuid, 'u1', 'ada@example.test', 'test-tenant', '["basic"]'::jsonb, '[]'::jsonb) on conflict ("norbital_id") do update set "roles" = excluded."roles", "teams" = excluded."teams", "email" = excluded."email", "tenantId" = excluded."tenantId" returning "norbital_id" as id) insert into bolt_auth_session ("norbital_id", "token", "userId", "expiresAt") select gen_random_uuid(), 'token-second', person.id, now() + interval '2 hours' from person`
		);
		const result = await access(harness);
		expect(result.members).toHaveLength(1);
	});

	it('excludes another tenant, and keeps a member who is merely signed out', async () => {
		harness = await makeBoltTestRuntime();
		await addSession(harness, 'u1', ['basic'], [], 'ada@example.test');
		// Membership is a property of the person, not of whether they happen to hold a live session.
		// This projection used to aggregate over sessions, so signing out erased someone from their
		// own workspace's access list — and an administrator reviewing who had access saw a shorter
		// list than the truth. `u-signed-out` is a member with no session and must still appear.
		await harness.database.query(
			`insert into bolt_auth_user ("norbital_id", "name", "email", "tenantId", "roles", "teams") values (md5('u-signed-out'::text)::uuid, 'u-signed-out', 'gone@example.test', 'test-tenant', '["basic"]'::jsonb, '[]'::jsonb)`
		);
		// Another tenant's member stays out entirely, session or no session.
		await harness.database.query(
			`insert into bolt_auth_user ("norbital_id", "name", "email", "tenantId", "roles", "teams") values (md5('u-other'::text)::uuid, 'u-other', 'other@example.test', 'other-tenant', '["admin"]'::jsonb, '[]'::jsonb)`
		);
		const result = await access(harness);
		expect(result.members.map(({ id }) => id)).toEqual(
			[fixtureUserId('u-signed-out'), fixtureUserId('u1')].sort()
		);
	});

	it('lists teams as the distinct set its members carry', async () => {
		harness = await makeBoltTestRuntime();
		await addSession(harness, 'u1', ['basic'], ['Platform'], 'ada@example.test');
		await addSession(harness, 'u2', ['basic'], ['Platform', 'People'], 'grace@example.test');
		const result = await access(harness);
		expect(result.teams.map(({ name }) => name)).toEqual(['People', 'Platform']);
	});

	it('reports outstanding invitations with their status', async () => {
		harness = await makeBoltTestRuntime();
		await harness.database.query(
			`insert into bolt_invitations (invitation_id, tenant_id, email, invited_by, status)
			 values ('inv-1', 'test-tenant', 'new@example.test', 'u1', 'pending')`
		);
		const result = await access(harness);
		expect(result.invitations).toHaveLength(1);
		expect(result.invitations[0]).toMatchObject({
			id: 'inv-1',
			email: 'new@example.test',
			status: 'pending',
			invitedBy: 'u1'
		});
	});

	it('reads access history newest first', async () => {
		harness = await makeBoltTestRuntime();
		await harness.database.query(
			`insert into bolt_audit (kind, subject_id, payload) values
			 ('member.invited', 'u1', '{"collection":"people"}'::jsonb),
			 ('member.role.changed', 'u2', '{}'::jsonb)`
		);
		const result = await access(harness);
		expect(result.events.map(({ action }) => action)).toEqual([
			'member.role.changed',
			'member.invited'
		]);
		expect(result.events.at(-1)?.subject).toBe('people');
		expect(result.events[0]?.at.length).toBeGreaterThan(0);
	});

	it('answers an empty workspace without failing', async () => {
		harness = await makeBoltTestRuntime();
		const result = await access(harness);
		expect(result).toEqual({ members: [], invitations: [], teams: [], events: [] });
	});
});
