<script lang="ts">
	import type {
		CollectionClient,
		ErasedCollectionRegistry
	} from '@norbital-ai/platform-utils/collection';
	import { UserRoleSchema, type TUserRole } from '@norbital-ai/platform-utils/system/types';
	import { Button } from '@norbital-ai/ui/button';
	import { Center, Cluster, Inline, Scroll, Stack } from '@norbital-ai/ui/layout';
	import {
		toMemberRow,
		toPolicyRow,
		toTeamMembershipRow,
		toTeamRow,
		type MemberRow,
		type TeamRow,
		type WorkspaceInvitation,
		type WorkspaceSettingsApi
	} from './workspace-settings.js';

	/**
	 * Workspace administration, rendered by the pod.
	 *
	 * Members, teams and policies are read straight off the replica — they are ordinary collections,
	 * already live through the sync engine, so this surface stays current without a poll of its own and
	 * a role changed in another tab lands here on the connection the shell already holds open.
	 *
	 * Invitations do not, and must not: `invitation` carries token digests and is client-opaque, so it
	 * never enters the replica. They come from `api.listInvitations()`, which projects the fields an
	 * administrator needs on the server.
	 *
	 * `role !== 'admin'` renders a refusal here, and that refusal is *not* the authorization. Every
	 * endpoint behind `api` checks admin server-side; this only avoids showing a person controls that
	 * would fail.
	 */
	let {
		workspaceApi,
		user,
		api
	}: {
		workspaceApi: CollectionClient<ErasedCollectionRegistry>;
		user: { readonly role: string | null };
		api: WorkspaceSettingsApi;
	} = $props();

	const isAdmin = $derived(user.role === 'admin');
	const ROLES = UserRoleSchema.options;
	const PAGE = 200;

	type Section = 'members' | 'teams' | 'invitations';
	const SECTIONS: { key: Section; label: string }[] = [
		{ key: 'members', label: 'Members' },
		{ key: 'teams', label: 'Teams' },
		{ key: 'invitations', label: 'Invitations' }
	];
	let section = $state<Section>('members');

	const memberQuery = $derived(
		isAdmin
			? workspaceApi.db.user?.findMany({
					where: { kind: 'human' },
					orderBy: { email: 'asc' },
					limit: PAGE
				})
			: undefined
	);
	const teamQuery = $derived(
		isAdmin ? workspaceApi.db.team?.findMany({ orderBy: { name: 'asc' }, limit: PAGE }) : undefined
	);
	const policyQuery = $derived(
		isAdmin
			? workspaceApi.db.policy?.findMany({ orderBy: { name: 'asc' }, limit: PAGE })
			: undefined
	);

	const membershipQuery = $derived(
		isAdmin ? workspaceApi.db.team_members?.findMany({ limit: 1000 }) : undefined
	);

	const members = $derived((memberQuery?.current ?? []).flatMap(toMemberRow));
	const teams = $derived((teamQuery?.current ?? []).flatMap(toTeamRow));
	const policies = $derived((policyQuery?.current ?? []).flatMap(toPolicyRow));
	const memberships = $derived((membershipQuery?.current ?? []).flatMap(toTeamMembershipRow));
	const membersById = $derived(new Map(members.map((member) => [member.norbital_id, member])));

	function teamMembers(team: TeamRow): { membershipId: string; member: MemberRow }[] {
		return memberships.flatMap((membership) => {
			if (membership.team_id !== team.norbital_id) return [];
			const member = membersById.get(membership.user_id);
			return member ? [{ membershipId: membership.norbital_id, member }] : [];
		});
	}

	function joinable(team: TeamRow): MemberRow[] {
		const already = new Set(
			memberships
				.filter((membership) => membership.team_id === team.norbital_id)
				.map((membership) => membership.user_id)
		);
		return members.filter((member) => !already.has(member.norbital_id));
	}

	let invitations = $state<readonly WorkspaceInvitation[]>([]);
	let invitationsLoaded = $state(false);
	let busy = $state(false);
	let failure = $state<string | null>(null);
	let mintedLink = $state<{ email: string; acceptUrl: string } | null>(null);
	let inviteEmail = $state('');
	let inviteRole = $state<TUserRole>('basic');
	let teamName = $state('');

	async function run(work: () => Promise<void>): Promise<void> {
		if (busy) return;
		busy = true;
		failure = null;
		try {
			await work();
		} catch (cause) {
			failure = cause instanceof Error ? cause.message : String(cause);
		} finally {
			busy = false;
		}
	}

	async function loadInvitations(): Promise<void> {
		invitations = await api.listInvitations();
		invitationsLoaded = true;
	}

	// Invitations are not replicated, so this surface asks for them — once when an admin opens the
	// section, and again after any change it made itself. There is nothing to listen to.
	$effect(() => {
		if (!isAdmin || section !== 'invitations' || invitationsLoaded) return;
		void run(loadInvitations);
	});

	function invite(event: SubmitEvent): void {
		event.preventDefault();
		const email = inviteEmail.trim();
		if (!email) return;
		void run(async () => {
			const minted = await api.invite({ email, role: inviteRole });
			// The plaintext token exists only in this response, so it is shown to the administrator who
			// asked rather than stored anywhere.
			//
			// The server returns an origin-relative path and the origin is composed here. This browser is
			// already looking at the workspace, so where it is IS an address that reaches it — which is
			// truer than any value a host could have been configured with, and needs no host to have been
			// configured at all.
			mintedLink = { email: minted.email, acceptUrl: `${location.origin}${minted.acceptPath}` };
			inviteEmail = '';
			await loadInvitations();
		});
	}

	function revoke(invitationId: string): void {
		void run(async () => {
			await api.revokeInvitation(invitationId);
			await loadInvitations();
		});
	}

	function changeRole(userId: string, role: string): void {
		const parsed = UserRoleSchema.safeParse(role);
		if (!parsed.success) return;
		void run(async () => {
			await api.setMemberRole(userId, parsed.data);
		});
	}

	function createTeam(event: SubmitEvent): void {
		event.preventDefault();
		const name = teamName.trim();
		if (!name) return;
		void run(async () => {
			await api.createTeam(name);
			teamName = '';
		});
	}

	function assignPolicy(teamId: string, policyId: string): void {
		void run(async () => {
			await api.setTeamPolicy(teamId, policyId === '' ? null : policyId);
		});
	}

	function addMember(teamId: string, userId: string): void {
		if (!userId) return;
		void run(async () => {
			await api.addTeamMember(teamId, userId);
		});
	}

	function removeMember(membershipId: string): void {
		void run(async () => {
			await api.removeTeamMember(membershipId);
		});
	}

	const FIELD =
		'h-8 rounded-md border border-input bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring';
</script>

{#if !isAdmin}
	<Stack
		grow
		fill
		align="center"
		justify="center"
		class="p-6 text-sm text-destructive"
		data-testid="settings-denied"
	>
		Workspace settings are for admins
	</Stack>
{:else}
	<Scroll name="Workspace settings" inset grow>
		<Center measure="wide">
			<Stack gap="lg" class="py-2 sm:py-4 lg:py-6">
				<Stack as="header" gap="xs">
					<h1 class="text-base font-semibold text-foreground">Workspace settings</h1>
					<p class="text-xs text-muted-foreground">
						Who is in this workspace, which teams they are in, and who has been invited.
					</p>
				</Stack>

				<Inline as="nav" gap="xs" class="border-b" aria-label="Workspace settings sections">
					{#each SECTIONS as entry (entry.key)}
						<button
							type="button"
							role="tab"
							aria-selected={section === entry.key}
							class="-mb-px border-b-2 px-3 py-1.5 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring {section ===
							entry.key
								? 'border-primary text-foreground'
								: 'border-transparent text-muted-foreground hover:text-foreground'}"
							onclick={() => (section = entry.key)}
						>
							{entry.label}
						</button>
					{/each}
				</Inline>

				{#if failure}
					<p
						class="rounded-md border border-destructive/40 px-3 py-2 text-tiny text-destructive"
						role="alert"
					>
						{failure}
					</p>
				{/if}

				{#if section === 'members'}
					<Stack as="section" gap="sm" data-testid="settings-members">
						{#if members.length === 0}
							<p
								class="rounded-lg border border-dashed p-6 text-center text-xs text-muted-foreground"
							>
								{memberQuery?.loading ? 'Loading…' : 'No members yet'}
							</p>
						{:else}
							<ul class="divide-y rounded-lg border">
								{#each members as member (member.norbital_id)}
									<Inline as="li" gap="md" class="px-3 py-2" data-testid="member-row">
										<div class="min-w-0 flex-1">
											<p class="truncate text-xs font-medium text-foreground">
												{member.name || member.email}
											</p>
											<p
												class="truncate text-micro text-muted-foreground"
												data-testid="member-email"
											>
												{member.email}
											</p>
										</div>
										<span class="text-micro text-muted-foreground">{member.status}</span>
										<select
											class={FIELD}
											aria-label={`Role for ${member.email}`}
											disabled={busy}
											value={member.role}
											onchange={(event) =>
												changeRole(member.norbital_id, event.currentTarget.value)}
										>
											{#each ROLES as role (role)}
												<option value={role}>{role}</option>
											{/each}
										</select>
									</Inline>
								{/each}
							</ul>
						{/if}
					</Stack>
				{:else if section === 'teams'}
					<Stack as="section" gap="md" data-testid="settings-teams">
						<Inline as="form" gap="sm" onsubmit={createTeam}>
							<input
								class="{FIELD} min-w-0 flex-1"
								placeholder="New team name"
								aria-label="New team name"
								value={teamName}
								oninput={(event) => (teamName = event.currentTarget.value)}
							/>
							<Button type="submit" class="h-8 px-3 text-tiny" disabled={busy}>Add team</Button>
						</Inline>
						{#if teams.length === 0}
							<p
								class="rounded-lg border border-dashed p-6 text-center text-xs text-muted-foreground"
							>
								{teamQuery?.loading ? 'Loading…' : 'No teams yet'}
							</p>
						{:else}
							<ul class="divide-y rounded-lg border">
								{#each teams as team (team.norbital_id)}
									<Stack as="li" gap="sm" class="px-3 py-2" data-testid="team-row">
										<Inline gap="md">
											<p class="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
												{team.name}
											</p>
											<!-- A picker over the policies this workspace declares, never an editor: a policy
										     is authored as `+<name>.policy.ts` and reconciled at migrate, so the only
										     runtime decision is which one a team holds. -->
											<!-- Teams and policies are independent live queries. Recreate the native select
											     when its options change so a policy id that arrived first is applied once
											     the matching option exists; otherwise the browser keeps its empty fallback. -->
											{#key policies.map((policy) => policy.norbital_id).join(':')}
												<select
													class={FIELD}
													aria-label={`Policy for ${team.name}`}
													disabled={busy}
													value={team.policy_id ?? ''}
													onchange={(event) =>
														assignPolicy(team.norbital_id, event.currentTarget.value)}
												>
													<option value="">No policy</option>
													{#each policies as policy (policy.norbital_id)}
														<option value={policy.norbital_id}>
															{policy.name}{policy.is_active ? '' : ' (inactive)'}
														</option>
													{/each}
												</select>
											{/key}
										</Inline>
										<Cluster gap="xs">
											{#each teamMembers(team) as entry (entry.membershipId)}
												<Inline
													as="span"
													gap="xs"
													class="rounded-full border px-2 py-0.5 text-micro"
													data-testid="team-member"
												>
													{entry.member.email}
													<button
														type="button"
														class="text-muted-foreground hover:text-destructive"
														aria-label={`Remove ${entry.member.email} from ${team.name}`}
														disabled={busy}
														onclick={() => removeMember(entry.membershipId)}
													>
														×
													</button>
												</Inline>
											{:else}
												<span class="text-micro text-muted-foreground">Nobody in this team yet</span
												>
											{/each}
											<!-- Membership is what a policy actually reaches a person through: a team with a
										     policy and no members grants nothing. -->
											<select
												class="{FIELD} ml-auto"
												aria-label={`Add someone to ${team.name}`}
												disabled={busy}
												value=""
												onchange={(event) => {
													addMember(team.norbital_id, event.currentTarget.value);
													event.currentTarget.value = '';
												}}
											>
												<option value="">Add member…</option>
												{#each joinable(team) as candidate (candidate.norbital_id)}
													<option value={candidate.norbital_id}>{candidate.email}</option>
												{/each}
											</select>
										</Cluster>
									</Stack>
								{/each}
							</ul>
						{/if}
					</Stack>
				{:else}
					<Stack as="section" gap="md" data-testid="settings-invitations">
						<Inline as="form" gap="sm" onsubmit={invite}>
							<input
								class="{FIELD} min-w-0 flex-1"
								type="email"
								placeholder="person@example.com"
								aria-label="Invitation email"
								value={inviteEmail}
								oninput={(event) => (inviteEmail = event.currentTarget.value)}
							/>
							<select
								class={FIELD}
								aria-label="Invitation role"
								value={inviteRole}
								onchange={(event) => {
									const parsed = UserRoleSchema.safeParse(event.currentTarget.value);
									if (parsed.success) inviteRole = parsed.data;
								}}
							>
								{#each ROLES as role (role)}
									<option value={role}>{role}</option>
								{/each}
							</select>
							<Button type="submit" class="h-8 px-3 text-tiny" disabled={busy}>Invite</Button>
						</Inline>

						{#if mintedLink}
							<p
								class="rounded-md border bg-muted/40 px-3 py-2 text-tiny break-all text-foreground"
								data-testid="minted-invitation"
							>
								Send this link to {mintedLink.email}: {mintedLink.acceptUrl}
							</p>
						{/if}

						{#if invitations.length === 0}
							<p
								class="rounded-lg border border-dashed p-6 text-center text-xs text-muted-foreground"
							>
								{invitationsLoaded ? 'Nobody is waiting on an invitation' : 'Loading…'}
							</p>
						{:else}
							<ul class="divide-y rounded-lg border">
								{#each invitations as invitation (invitation.norbital_id)}
									<Inline as="li" gap="md" class="px-3 py-2" data-testid="invitation-row">
										<div class="min-w-0 flex-1">
											<p class="truncate text-xs font-medium text-foreground">{invitation.email}</p>
											<p class="truncate text-micro text-muted-foreground">
												{invitation.role} · {invitation.status}
											</p>
										</div>
										{#if invitation.status === 'pending'}
											<Button
												type="button"
												variant="ghost"
												class="h-6 px-2 text-tiny"
												disabled={busy}
												onclick={() => revoke(invitation.norbital_id)}
											>
												Revoke
											</Button>
										{/if}
									</Inline>
								{/each}
							</ul>
						{/if}
					</Stack>
				{/if}
			</Stack>
		</Center>
	</Scroll>
{/if}
