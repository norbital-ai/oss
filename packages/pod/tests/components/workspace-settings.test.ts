import { beforeEach, describe, expect, it } from 'vitest';
import WorkspaceSettingsSurface from '$lib/ui/shell/workspace-settings-surface.svelte';
import type {
	WorkspaceInvitation,
	WorkspaceSettingsApi
} from '$lib/ui/shell/workspace-settings.js';
import { FakeReplica } from '../support/fake-replica.svelte.js';
import { render, settle } from '../support/component.js';

const ADMIN = { role: 'admin' } as const;
const MEMBER = { role: 'basic' } as const;

/**
 * The half of the surface that is not the replica.
 *
 * Every method answers a turn late, like the network it stands for, so a component that read once at
 * mount and never re-rendered would show nothing.
 */
class FakeSettingsApi implements WorkspaceSettingsApi {
	invitations: WorkspaceInvitation[] = [];
	readonly calls: { method: string; args: unknown[] }[] = [];

	#late<T>(value: T): Promise<T> {
		return new Promise((resolve) => setTimeout(() => resolve(value), 0));
	}

	listInvitations(): Promise<readonly WorkspaceInvitation[]> {
		this.calls.push({ method: 'listInvitations', args: [] });
		return this.#late([...this.invitations]);
	}

	invite(input: { email: string; role: 'admin' | 'advanced' | 'basic' }) {
		this.calls.push({ method: 'invite', args: [input] });
		this.invitations = [
			...this.invitations,
			{
				norbital_id: `invitation-${this.invitations.length + 1}`,
				email: input.email,
				role: input.role,
				status: 'pending',
				created_at: '2026-07-31T09:00:00.000Z',
				expires_at: '2026-08-03T09:00:00.000Z'
			}
		];
		return this.#late({
			invitationId: 'invitation-new',
			acceptPath: `https://workspace.example.test/accept-invite?token=plaintext-${input.email}`,
			email: input.email
		});
	}

	revokeInvitation(invitationId: string) {
		this.calls.push({ method: 'revokeInvitation', args: [invitationId] });
		this.invitations = this.invitations.filter((entry) => entry.norbital_id !== invitationId);
		return this.#late({ revoked: true });
	}

	setMemberRole(userId: string, role: string) {
		this.calls.push({ method: 'setMemberRole', args: [userId, role] });
		return this.#late(null);
	}

	createTeam(input: { name: string }) {
		this.calls.push({ method: 'createTeam', args: [input] });
		return this.#late(null);
	}

	updateTeam(teamId: string, input: { name: string }) {
		this.calls.push({ method: 'updateTeam', args: [teamId, input] });
		return this.#late(null);
	}

	deleteTeam(teamId: string) {
		this.calls.push({ method: 'deleteTeam', args: [teamId] });
		return this.#late(null);
	}

	setTeamPolicy(teamId: string, policyId: string | null) {
		this.calls.push({ method: 'setTeamPolicy', args: [teamId, policyId] });
		return this.#late(null);
	}

	addTeamMember(teamId: string, userId: string) {
		this.calls.push({ method: 'addTeamMember', args: [teamId, userId] });
		return this.#late(null);
	}

	removeTeamMember(membershipId: string) {
		this.calls.push({ method: 'removeTeamMember', args: [membershipId] });
		return this.#late(null);
	}
}

let replica = new FakeReplica();
let api = new FakeSettingsApi();

function member(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		norbital_id: 'user-admin',
		email: 'admin@it.local',
		name: 'IT Admin',
		role: 'admin',
		status: 'active',
		kind: 'human',
		...overrides
	};
}

beforeEach(() => {
	replica = new FakeReplica();
	api = new FakeSettingsApi();
});

function mount(user: { role: string } = ADMIN): {
	container: HTMLElement;
	destroy(): void;
} {
	return render(WorkspaceSettingsSurface as never, { workspaceApi: replica, user, api } as never);
}

function tab(container: HTMLElement, label: string): HTMLElement {
	const found = [...container.querySelectorAll('[role="tab"]')].find(
		(node) => node.textContent?.trim() === label
	);
	if (!(found instanceof HTMLElement)) throw new Error(`no ${label} tab`);
	return found;
}

function rows(container: HTMLElement, testid: string): string[] {
	return [...container.querySelectorAll(`[data-testid="${testid}"]`)].map(
		(node) => node.textContent?.replace(/\s+/g, ' ').trim() ?? ''
	);
}

function memberEmails(container: HTMLElement): string[] {
	return [...container.querySelectorAll('[data-testid="member-email"]')].map(
		(node) => node.textContent?.trim() ?? ''
	);
}

function select(container: HTMLElement, label: string): HTMLSelectElement {
	const node = container.querySelector(`select[aria-label="${label}"]`);
	if (!(node instanceof HTMLSelectElement)) throw new Error(`no select for ${label}`);
	return node;
}

describe('workspace settings surface', () => {
	it('lists the members the replica holds, and one that arrives later', async () => {
		replica.seed('user', [
			member(),
			member({
				norbital_id: 'user-member',
				email: 'engineer@it.local',
				name: 'Site Engineer',
				role: 'basic'
			})
		]);
		const { container, destroy } = mount();
		await settle();

		expect(memberEmails(container)).toEqual(['admin@it.local', 'engineer@it.local']);
		expect(select(container, 'Role for engineer@it.local').value).toBe('basic');

		// Somebody accepted an invitation in another tab. Nothing here polls; the sync engine re-fires
		// the read this surface already has open.
		replica.arrive(
			'user',
			member({ norbital_id: 'user-new', email: 'new@it.local', name: 'New Person', role: 'basic' })
		);
		await settle();
		expect(memberEmails(container)).toEqual([
			'admin@it.local',
			'engineer@it.local',
			'new@it.local'
		]);
		destroy();
	});

	it('changes a role through the api rather than the replica', async () => {
		replica.seed('user', [
			member(),
			member({ norbital_id: 'user-member', email: 'engineer@it.local', role: 'basic' })
		]);
		const { container, destroy } = mount();
		await settle();

		const roleSelect = select(container, 'Role for engineer@it.local');
		roleSelect.value = 'advanced';
		roleSelect.dispatchEvent(new Event('change', { bubbles: true }));
		await settle();

		// A role is not writable from a browser replica — it goes to an endpoint that checks admin.
		expect(api.calls).toEqual([{ method: 'setMemberRole', args: ['user-member', 'advanced'] }]);
		expect(replica.writes).toEqual([]);
		destroy();
	});

	it('renders tenant teams as a tappable SvelteFlow organization chart with a create action', async () => {
		replica.seed('team', [
			{ norbital_id: 'team-site', name: 'Site', policy_id: null, parent_id: null },
			{
				norbital_id: 'team-office',
				name: 'Office',
				policy_id: 'policy-read',
				parent_id: 'team-site'
			}
		]);
		replica.seed('policy', [
			{ norbital_id: 'policy-read', key: 'read', name: 'Read only', is_active: true },
			{ norbital_id: 'policy-full', key: 'full', name: 'Full access', is_active: true }
		]);
		const { container, destroy } = mount();
		tab(container, 'Teams').click();
		await settle();

		expect(container.querySelector('[data-testid="settings-org-chart-canvas"]')).not.toBeNull();
		expect(rows(container, 'team-node')).toHaveLength(2);
		expect(container.querySelector('[aria-label="Create team"]')).not.toBeNull();

		(container.querySelector('[data-team-id="team-site"]') as HTMLButtonElement | null)?.click();
		await settle();
		expect(container.querySelector('[aria-label="Edit Site"]')).not.toBeNull();
		destroy();
	});

	it('puts people in teams and takes them out again', async () => {
		replica.seed('user', [
			member(),
			member({ norbital_id: 'user-member', email: 'engineer@it.local', role: 'basic' })
		]);
		replica.seed('team', [
			{ norbital_id: 'team-site', name: 'Site', policy_id: null, parent_id: null }
		]);
		replica.seed('team_members', [
			{ norbital_id: 'membership-1', team_id: 'team-site', user_id: 'user-admin' }
		]);
		const { container, destroy } = mount();
		tab(container, 'Teams').click();
		await settle();

		(container.querySelector('[data-team-id="team-site"]') as HTMLButtonElement | null)?.click();
		await settle();
		// A policy only reaches a person through membership, so the candidates are the members who are
		// not in this team yet — offering one who already is would create a duplicate row.
		const adder = select(container, 'Add someone to Site');
		expect([...adder.options].map((option) => option.textContent?.trim())).toEqual([
			'Add member…',
			'engineer@it.local'
		]);

		adder.value = 'user-member';
		adder.dispatchEvent(new Event('change', { bubbles: true }));
		await settle();
		(
			container.querySelector('[aria-label="Add member to Site"]') as HTMLButtonElement | null
		)?.click();
		await settle();
		expect(api.calls).toEqual([{ method: 'addTeamMember', args: ['team-site', 'user-member'] }]);

		const remove = container.querySelector(
			'[aria-label="Remove admin@it.local from Site"]'
		) as HTMLButtonElement | null;
		remove?.click();
		await settle();
		expect(api.calls.at(-1)).toEqual({ method: 'removeTeamMember', args: ['membership-1'] });
		destroy();
	});

	it('shows invitations from the endpoint, mints one, and revokes it', async () => {
		api.invitations = [
			{
				norbital_id: 'invitation-old',
				email: 'waiting@example.test',
				role: 'basic',
				status: 'pending',
				created_at: '2026-07-30T09:00:00.000Z',
				expires_at: '2026-08-02T09:00:00.000Z'
			}
		];
		const { container, destroy } = mount();
		tab(container, 'Invitations').click();
		await settle();

		// They are not in the replica and never will be. A safe endpoint projection still drives the
		// same CollectionTable used by the other tenant-administration sections.
		expect(rows(container, 'invitation-email')).toEqual(['waiting@example.test']);
		expect(container.textContent).toContain('Invitations');

		const email = container.querySelector('input[aria-label="Invitation email"]');
		if (!(email instanceof HTMLInputElement)) throw new Error('no email field');
		email.value = 'new.person@example.test';
		email.dispatchEvent(new Event('input', { bubbles: true }));
		const roleSelect = select(container, 'Invitation role');
		roleSelect.value = 'advanced';
		roleSelect.dispatchEvent(new Event('change', { bubbles: true }));
		await settle();
		container
			.querySelector('form')
			?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
		await settle();

		expect(api.calls[1]).toEqual({
			method: 'invite',
			args: [{ email: 'new.person@example.test', role: 'advanced' }]
		});
		// The plaintext token exists only in that response, so the administrator is shown the link to
		// send rather than being told an email went somewhere.
		const minted = container.querySelector('[data-testid="minted-invitation"]')?.textContent ?? '';
		expect(minted).toContain('https://workspace.example.test/accept-invite?token=');
		expect(rows(container, 'invitation-email')).toHaveLength(2);

		const revoke = [...container.querySelectorAll('button')].find(
			(node) => node.textContent?.trim() === 'Revoke'
		);
		revoke?.click();
		await settle();
		expect(api.calls.some((call) => call.method === 'revokeInvitation')).toBe(true);
		expect(rows(container, 'invitation-email')).toHaveLength(1);
		destroy();
	});

	it('shows a member nothing to administer, and asks the server for nothing', async () => {
		replica.seed('user', [member()]);
		const { container, destroy } = mount(MEMBER);
		await settle();

		expect(container.querySelector('[data-testid="settings-denied"]')).not.toBeNull();
		expect(rows(container, 'member-row')).toEqual([]);
		expect(container.querySelector('input[aria-label="Invitation email"]')).toBeNull();
		// The refusal in the markup is not the authorization — the endpoints check admin themselves —
		// but a surface that fetched anyway would put a 403 in front of every ordinary member.
		expect(api.calls).toEqual([]);
		destroy();
	});
});
