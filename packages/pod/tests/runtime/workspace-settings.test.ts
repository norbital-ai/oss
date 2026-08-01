import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashToken } from '$lib/host/session.js';
import { requireDocker } from '../support/pg-harness.js';
import {
	bootPodRuntime,
	type Identity,
	type PodRuntimeHarness
} from '../support/pod-runtime-harness.js';

requireDocker();

/** The harness's own admin id, so the forged scope and the `user` row are the same person. */
const admin: Identity = {
	userId: '22222222-2222-4222-8222-222222222222',
	userName: 'IT Admin',
	email: 'admin@it.local',
	role: 'admin'
};
/** Signed in, and nothing more. Every refusal below is about this identity. */
const member: Identity = {
	userId: '55555555-5555-4555-8555-555555555555',
	userName: 'Site Engineer',
	email: 'engineer@it.local',
	role: 'basic'
};

type Json = Record<string, unknown>;

describe('Pod workspace settings — identity administration', () => {
	let harness: PodRuntimeHarness;

	/** One settings call, exactly as the browser makes it: a POST with the host's public URL attached. */
	async function call(path: string, body: unknown, identity: Identity): Promise<Response> {
		return harness.request(
			{
				method: 'POST',
				path,
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			},
			identity
		);
	}

	/** Read a response once: `status` and the payload both come out of the same body. */
	async function payload(response: Response): Promise<{ status: number; body: string }> {
		return { status: response.status, body: await response.text() };
	}

	async function listInvitations(identity: Identity): Promise<Json[]> {
		const { status, body } = await payload(await call('settings/invitations', {}, identity));
		expect(status, body).toBe(200);
		return JSON.parse(body) as Json[];
	}

	beforeAll(async () => {
		harness = await bootPodRuntime('construction');
		for (const identity of [admin, member]) {
			await harness.pool.query(
				`INSERT INTO "user" (norbital_id, email, name, role, status)
				 VALUES ($1::uuid, $2, $3, $4, 'active')
				 ON CONFLICT (norbital_id) DO NOTHING`,
				[identity.userId, identity.email, identity.userName, identity.role]
			);
		}
	}, 240_000);

	afterAll(async () => {
		await harness?.stop();
	});

	it('mints an invitation and lists it without the credential it is made of', async () => {
		const created = await payload(
			await call(
				'settings/invitations/create',
				{ email: 'New.Person@example.test', role: 'advanced' },
				admin
			)
		);
		expect(created.status, created.body).toBe(200);
		const minted = JSON.parse(created.body) as { invitationId: string; acceptPath: string };
		// Origin-relative on purpose: the browser that asked composes the origin, because it is already
		// looking at an address that reaches this workspace.
		expect(minted.acceptPath.startsWith('/accept-invite?token=')).toBe(true);

		const token =
			new URL(minted.acceptPath, 'https://example.invalid').searchParams.get('token') ?? '';
		const stored = await harness.pool.query<{ token_hash: string; email: string }>(
			`SELECT token_hash, email FROM invitation WHERE norbital_id = $1::uuid`,
			[minted.invitationId]
		);
		// The row really does hold a redeemable credential — which is the point of the next assertion.
		expect(stored.rows[0]?.token_hash).toBe(hashToken(token));
		expect(stored.rows[0]?.email).toBe('new.person@example.test');

		const invitations = await listInvitations(admin);
		const row = invitations.find((entry) => entry.email === 'new.person@example.test');
		expect(row).toBeDefined();
		// Asserted on the object that came back, not on its type: a projection that quietly grew a
		// column would satisfy any type this endpoint declares.
		expect(Object.keys(row!).sort()).toEqual([
			'created_at',
			'email',
			'expires_at',
			'norbital_id',
			'role',
			'status'
		]);
		expect(JSON.stringify(invitations)).not.toContain(stored.rows[0]!.token_hash);
		expect(row!.status).toBe('pending');
		expect(row!.role).toBe('advanced');
	});

	it('refuses a member every part of it, whatever the sidebar showed them', async () => {
		const invitation = await listInvitations(admin);
		const pending = invitation.find((entry) => entry.status === 'pending');
		expect(pending).toBeDefined();

		// Inviting is the privilege-escalation surface: a `basic` user who can mint an admin invitation
		// can promote themselves through the front door.
		const invited = await call(
			'settings/invitations/create',
			{ email: 'smuggled@example.test', role: 'admin' },
			member
		);
		expect(invited.status).toBe(403);

		const listed = await call('settings/invitations', {}, member);
		expect(listed.status).toBe(403);

		const revoked = await call(
			'settings/invitations/revoke',
			{ invitation_id: pending!.norbital_id },
			member
		);
		expect(revoked.status).toBe(403);

		const promoted = await call(
			'settings/members/role',
			{ user_id: member.userId, role: 'admin' },
			member
		);
		expect(promoted.status).toBe(403);

		// Teams ride the same admin gate, on the endpoint that already existed.
		const team = await call(
			'collections/admin/create',
			{ collection: 'team', input: { name: 'Smuggled' } },
			member
		);
		expect(team.status).toBe(403);

		// And nothing of it happened.
		const smuggled = await harness.pool.query(
			`SELECT norbital_id FROM invitation WHERE email = 'smuggled@example.test'`
		);
		expect(smuggled.rowCount).toBe(0);
		const role = await harness.pool.query<{ role: string }>(
			`SELECT role FROM "user" WHERE norbital_id = $1::uuid`,
			[member.userId]
		);
		expect(role.rows[0]?.role).toBe('basic');
	});

	it('mints a link with no host-supplied origin at all', async () => {
		// The point of the relative path. This endpoint used to demand the origin over a header, so a
		// host that had not been taught to send one could not invite anybody — under Core the button
		// answered 503. Nothing here supplies an origin, and it still works.
		const response = await payload(
			await call(
				'settings/invitations/create',
				{ email: 'nowhere@example.test', role: 'basic' },
				admin
			)
		);
		expect(response.status, response.body).toBe(200);
		const minted = JSON.parse(response.body) as { acceptPath: string };
		expect(minted.acceptPath.startsWith('/accept-invite?token=')).toBe(true);
		expect(minted.acceptPath).not.toContain('://');

		const stored = await harness.pool.query(
			`SELECT norbital_id FROM invitation WHERE email = 'nowhere@example.test'`
		);
		expect(stored.rowCount).toBe(1);
	});

	it('revokes a pending invitation and leaves nothing to redeem', async () => {
		const before = await listInvitations(admin);
		const pending = before.find((entry) => entry.status === 'pending');
		expect(pending).toBeDefined();

		const response = await payload(
			await call('settings/invitations/revoke', { invitation_id: pending!.norbital_id }, admin)
		);
		expect(response.status, response.body).toBe(200);
		expect(JSON.parse(response.body)).toEqual({ revoked: true });

		const remaining = await harness.pool.query(
			`SELECT norbital_id FROM invitation WHERE norbital_id = $1::uuid`,
			[pending!.norbital_id]
		);
		expect(remaining.rowCount).toBe(0);
		expect((await listInvitations(admin)).map((entry) => entry.norbital_id)).not.toContain(
			pending!.norbital_id
		);
	});

	/**
	 * Teams deliberately add no endpoints: `collections/admin/*` already writes the system collections
	 * behind `ensureOrganizationAdmin`. This is the check that the surface's reuse of it actually works
	 * — and that these rows, unlike invitations, are ones a replica may hold.
	 */
	it('creates a team, points it at a policy and puts a member in it', async () => {
		const created = await payload(
			await call(
				'collections/admin/create',
				{ collection: 'team', input: { name: 'Site crew' } },
				admin
			)
		);
		expect(created.status, created.body).toBe(200);
		const teamId = (JSON.parse(created.body) as { norbital_id: string }).norbital_id;

		const policy = await harness.pool.query<{ norbital_id: string }>(
			`SELECT norbital_id FROM policy LIMIT 1`
		);
		if (policy.rows[0]) {
			const assigned = await payload(
				await call(
					'collections/admin/update',
					{
						collection: 'team',
						record_id: teamId,
						input: { policy_id: policy.rows[0].norbital_id }
					},
					admin
				)
			);
			expect(assigned.status, assigned.body).toBe(200);
			const held = await harness.pool.query<{ policy_id: string | null }>(
				`SELECT policy_id FROM team WHERE norbital_id = $1::uuid`,
				[teamId]
			);
			expect(held.rows[0]?.policy_id).toBe(policy.rows[0].norbital_id);
		}

		const joined = await payload(
			await call(
				'collections/admin/create',
				{ collection: 'team_members', input: { team_id: teamId, user_id: member.userId } },
				admin
			)
		);
		expect(joined.status, joined.body).toBe(200);
		const membership = await harness.pool.query<{ user_id: string }>(
			`SELECT user_id FROM team_members WHERE team_id = $1::uuid`,
			[teamId]
		);
		expect(membership.rows.map((row) => row.user_id)).toEqual([member.userId]);
	});

	it('keeps invitations out of the replica, which is why these endpoints exist', async () => {
		const schema = await harness
			.request({ method: 'GET', path: 'sync/schema' }, admin)
			.then((response) => response.text());
		expect(schema).not.toContain('"invitation"');
		expect(schema).not.toContain('token_hash');

		const shape = await harness.request(
			{
				method: 'POST',
				path: 'sync/shape',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ collection: 'invitation', pageSize: 10 })
			},
			admin
		);
		expect(shape.status).not.toBe(200);
	});

	it('changes a role, and refuses to leave the workspace with no admin', async () => {
		const promote = await call(
			'settings/members/role',
			{ user_id: member.userId, role: 'advanced' },
			admin
		);
		expect(promote.status, await promote.text()).toBe(200);
		const changed = await harness.pool.query<{ role: string }>(
			`SELECT role FROM "user" WHERE norbital_id = $1::uuid`,
			[member.userId]
		);
		expect(changed.rows[0]?.role).toBe('advanced');

		// The only admin cannot step down: role is what opens this surface, so there would be nobody
		// left who could undo it, and a self-hosted pod has no support desk behind it.
		const lockout = await call(
			'settings/members/role',
			{ user_id: admin.userId, role: 'basic' },
			admin
		);
		expect(lockout.status).toBe(409);
		const stillAdmin = await harness.pool.query<{ role: string }>(
			`SELECT role FROM "user" WHERE norbital_id = $1::uuid`,
			[admin.userId]
		);
		expect(stillAdmin.rows[0]?.role).toBe('admin');

		// And it is a last-admin rule, not a blanket refusal: with a second admin, the first may go.
		const second = await call(
			'settings/members/role',
			{ user_id: member.userId, role: 'admin' },
			admin
		);
		expect(second.status, await second.text()).toBe(200);
		const stepDown = await call(
			'settings/members/role',
			{ user_id: admin.userId, role: 'basic' },
			admin
		);
		expect(stepDown.status, await stepDown.text()).toBe(200);
	});
});
