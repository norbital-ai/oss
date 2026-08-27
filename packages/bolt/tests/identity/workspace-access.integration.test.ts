import { Effect } from 'effect';
import { fixtureUserId } from '../support/fixture-identity.js';
import { afterEach, describe, expect, it } from 'vitest';
import { EffectId } from '@norbital-ai/bolt-protocol';
import * as Identity from '../../src/runtime/identity/identity.js';
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

/** A team row, id derived from the name so a fixture can point at one without reading it back. */
const addTeam = (harness: BoltTestRuntime, name: string) =>
	harness.database.query(
		`insert into "team" ("id", "name") values (md5($1::text)::uuid, $1)
		 on conflict ("id") do nothing`,
		[name]
	);

/**
 * Seeds one member and a live session for them, the way provisioning writes them.
 *
 * `status` is a parameter, defaulted to `normal`, because administration is a status on the person
 * — `admit` writes `user.status` and the projection reads that column and no other. The
 * fixture used to hand-write the string `admin` into `roles`, which named a role in the ladder that
 * nothing declares and nothing in production ever writes, so the suite pinned a mapping the source
 * does not perform.
 *
 * `team` is one name or none, because `user.team_id` is one team. A fixture that could
 * hand somebody two would be describing a shape the column cannot hold.
 */
const addSession = (
	harness: BoltTestRuntime,
	userId: string,
	team: string | null,
	email: string,
	status: 'normal' | 'admin' = 'normal'
) =>
	harness.database.query(
		`with person as (insert into "user" ("id", "name", "email", "tenantId", "team_id", "status") values (md5($2::text)::uuid, $2, $4, 'test-tenant', case when $3::text is null then null else md5($3::text)::uuid end, $5) on conflict ("id") do update set "team_id" = excluded."team_id", "email" = excluded."email", "tenantId" = excluded."tenantId", "status" = excluded."status" returning "id" as id) insert into "session" ("id", "token", "userId", "expiresAt") select gen_random_uuid(), $1, person.id, now() + interval '1 hour' from person`,
		[`token-${userId}`, userId, team, email, status]
	);

describe('workspace access projection', () => {
	it('reports one member per user, with their status and their team', async () => {
		harness = await makeBoltTestRuntime();
		// `u1` administers this workspace by status. `u2` is the negative case without which the same
		// assertion would pass against a projection that answered `admin` for everybody.
		await addTeam(harness, 'Platform');
		await addTeam(harness, 'People');
		await addSession(harness, 'u1', 'Platform', 'ada@example.test', 'admin');
		await addSession(harness, 'u2', 'People', 'grace@example.test');

		const result = await access(harness);
		// Compared as a set: members come back ordered by id, and an id is a uuid, so the order is
		// the hash's rather than the readable name's and asserting it would be asserting md5.
		expect(result.members.map(({ id, role }) => [id, role]).sort()).toEqual(
			[
				[fixtureUserId('u1'), 'admin'],
				[fixtureUserId('u2'), 'basic']
			].sort()
		);
		expect(result.members.find(({ id }) => id === fixtureUserId('u2'))?.team).toBe('People');
	});

	it('collapses several sessions for one user into a single member', async () => {
		harness = await makeBoltTestRuntime();
		await addSession(harness, 'u1', null, 'ada@example.test');
		await harness.database.query(
			`with person as (insert into "user" ("id", "name", "email", "tenantId") values (md5('u1'::text)::uuid, 'u1', 'ada@example.test', 'test-tenant') on conflict ("id") do update set "email" = excluded."email", "tenantId" = excluded."tenantId" returning "id" as id) insert into "session" ("id", "token", "userId", "expiresAt") select gen_random_uuid(), 'token-second', person.id, now() + interval '2 hours' from person`
		);
		const result = await access(harness);
		expect(result.members).toHaveLength(1);
	});

	it('excludes another tenant, and keeps a member who is merely signed out', async () => {
		harness = await makeBoltTestRuntime();
		await addSession(harness, 'u1', null, 'ada@example.test');
		// Membership is a property of the person, not of whether they happen to hold a live session.
		// This projection used to aggregate over sessions, so signing out erased someone from their
		// own workspace's access list — and an administrator reviewing who had access saw a shorter
		// list than the truth. `u-signed-out` is a member with no session and must still appear.
		await harness.database.query(
			`insert into "user" ("id", "name", "email", "tenantId") values (md5('u-signed-out'::text)::uuid, 'u-signed-out', 'gone@example.test', 'test-tenant')`
		);
		// Another tenant's member stays out entirely, session or no session.
		await harness.database.query(
			`insert into "user" ("id", "name", "email", "tenantId") values (md5('u-other'::text)::uuid, 'u-other', 'other@example.test', 'other-tenant')`
		);
		const result = await access(harness);
		expect(result.members.map(({ id }) => id)).toEqual(
			[fixtureUserId('u-signed-out'), fixtureUserId('u1')].sort()
		);
	});

	/**
	 * Read from `team`, not derived from who is in one.
	 *
	 * `Reclamation` has no members and must still be listed: an empty team is what a freshly declared
	 * `approvers` name reconciles into, and an operator who cannot see it cannot put anybody in it.
	 * A projection that aggregated over members would answer this case by omitting the row, which is
	 * indistinguishable from the team not existing.
	 */
	it('lists every team, including one nobody belongs to', async () => {
		harness = await makeBoltTestRuntime();
		await addTeam(harness, 'Platform');
		await addTeam(harness, 'People');
		await addTeam(harness, 'Reclamation');
		await addSession(harness, 'u1', 'Platform', 'ada@example.test');
		await addSession(harness, 'u2', 'People', 'grace@example.test');
		const result = await access(harness);
		expect(result.teams.map(({ name }) => name)).toEqual(['People', 'Platform', 'Reclamation']);
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
		expect(result).toEqual({ members: [], invitations: [], events: [], teams: [] });
	});
});
