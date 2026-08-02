<script lang="ts">
	import type {
		CollectionClient,
		ErasedCollectionRegistry
	} from '@norbital-ai/platform-utils/collection';
	import { UserRoleSchema, type TUserRole } from '@norbital-ai/platform-utils/system/types';
	import { Bound, Scroll, Stack } from '@norbital-ai/ui/layout';
	import { Tabs, type TabConfig } from '@norbital-ai/ui/tabs';
	import WorkspaceAuditTable from './settings/workspace-audit-table.svelte';
	import WorkspaceInvitationsTable from './settings/workspace-invitations-table.svelte';
	import WorkspaceMembersTable from './settings/workspace-members-table.svelte';
	import WorkspaceTeamChart from './settings/workspace-team-chart.svelte';
	import {
		toMemberRow,
		toPolicyRow,
		toTeamMembershipRow,
		toTeamRow,
		type WorkspaceInvitation,
		type WorkspaceSettingsApi
	} from './workspace-settings.js';

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
	const PAGE = 500;
	type SettingsTab = 'members' | 'invitations' | 'teams' | 'audit';
	let activeTab = $state<SettingsTab>('members');

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
		isAdmin ? workspaceApi.db.team_members?.findMany({ limit: 2000 }) : undefined
	);
	const members = $derived((memberQuery?.current ?? []).flatMap(toMemberRow));
	const teams = $derived((teamQuery?.current ?? []).flatMap(toTeamRow));
	const policies = $derived((policyQuery?.current ?? []).flatMap(toPolicyRow));
	const memberships = $derived((membershipQuery?.current ?? []).flatMap(toTeamMembershipRow));

	let invitations = $state<readonly WorkspaceInvitation[]>([]);
	let invitationsLoaded = $state(false);
	let busy = $state(false);
	let failure = $state<string | null>(null);
	let mintedLink = $state<{ email: string; acceptUrl: string } | null>(null);

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

	$effect(() => {
		if (!isAdmin || activeTab !== 'invitations' || invitationsLoaded) return;
		void run(loadInvitations);
	});

	function changeRole(userId: string, role: string): void {
		const parsed = UserRoleSchema.safeParse(role);
		if (!parsed.success) return;
		void run(async () => {
			await api.setMemberRole(userId, parsed.data);
		});
	}

	function invite(email: string, role: TUserRole): void {
		void run(async () => {
			const minted = await api.invite({ email, role });
			mintedLink = { email: minted.email, acceptUrl: `${location.origin}${minted.acceptPath}` };
			await loadInvitations();
		});
	}

	function revoke(invitationId: string): void {
		void run(async () => {
			await api.revokeInvitation(invitationId);
			await loadInvitations();
		});
	}
</script>

{#snippet membersContent()}
	<WorkspaceMembersTable client={workspaceApi} {busy} onRoleChange={changeRole} />
{/snippet}

{#snippet invitationsContent()}
	<WorkspaceInvitationsTable
		{invitations}
		loaded={invitationsLoaded}
		{busy}
		{mintedLink}
		onInvite={invite}
		onRevoke={revoke}
		onRefresh={loadInvitations}
	/>
{/snippet}

{#snippet teamsContent()}
	<WorkspaceTeamChart {teams} {members} {memberships} {policies} {api} {busy} {run} />
{/snippet}

{#snippet auditContent()}
	<WorkspaceAuditTable client={workspaceApi} />
{/snippet}

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
	<Bound size="full" clip class="bg-background">
		<Scroll name="Tenant settings" class="h-full">
			<Stack gap="lg" class="mx-auto min-h-full w-full max-w-7xl p-4 sm:p-6">
				<Stack as="header" gap="xs">
					<h1 class="text-lg font-semibold">Tenant settings</h1>
					<p class="max-w-2xl text-xs text-muted-foreground">
						Manage the people, team assignments, and audit history stored in this tenant database.
					</p>
				</Stack>

				{#if failure}<p
						class="rounded-md border border-destructive/40 px-3 py-2 text-xs text-destructive"
						role="alert"
					>
						{failure}
					</p>{/if}

				<Tabs
					bind:value={activeTab}
					animate={false}
					contentPadding={false}
					listClass="mx-0 w-full"
					class="min-h-[32rem]"
					config={[
						{ name: 'members', label: 'Members', icon: 'lucide:users', content: membersContent },
						{
							name: 'invitations',
							label: 'Invitations',
							icon: 'lucide:mail-plus',
							content: invitationsContent
						},
						{ name: 'teams', label: 'Teams', icon: 'lucide:network', content: teamsContent },
						{
							name: 'audit',
							label: 'Audit log',
							icon: 'lucide:scroll-text',
							content: auditContent
						}
					] satisfies TabConfig[]}
				/>
			</Stack>
		</Scroll>
	</Bound>
{/if}
