<script lang="ts">
	import type {
		CollectionClient,
		ErasedCollectionRegistry
	} from '@norbital-ai/platform-utils/collection';
	import { UserRoleSchema, type TUserRole } from '@norbital-ai/platform-utils/system/types';
	import { Bound, Center, Cover, Stack } from '@norbital-ai/ui/layout';
	import { Tabs, type TabConfig } from '@norbital-ai/ui/tabs';
	import WorkspaceAuditTable from '../settings/workspace-audit-table.svelte';
	import WorkspaceInvitationsTable from '../settings/workspace-invitations-table.svelte';
	import WorkspaceMembersTable from '../settings/workspace-members-table.svelte';
	import WorkspaceTeamChart from '../settings/workspace-team-chart.svelte';
	import {
		toMemberRow,
		toPolicyRow,
		toTeamMembershipRow,
		toTeamRow,
		type WorkspaceInvitation,
		type WorkspaceSettingsApi
	} from './workspace-settings.js';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import type { PodUiKeys } from '$lib/i18n/index.js';

	const { t } = useI18n<PodUiKeys>();

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

	/** Runs one settings write at a time and surfaces the failure on the page. */
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

	/** Reloads invitations from the host API after the first visit or a write. */
	async function loadInvitations(): Promise<void> { // stupidity:allow Q4 -- named helper
		invitations = await api.listInvitations();
		invitationsLoaded = true;
	}

	/** Switches tabs and loads invitations the first time that tab is opened. */
	function onTabChange(tab: string): void { // stupidity:allow Q3 -- template event handler
		activeTab = tab as SettingsTab;
		// Invitations come from the host API, not the replica; load them once, on first visit.
		if (tab === 'invitations' && isAdmin && !invitationsLoaded) {
			void run(loadInvitations);
		}
	}

	/** Persists a member role change after the schema accepts the value. */
	function changeRole(userId: string, role: string): void { // stupidity:allow Q3 -- template event handler
		const parsed = UserRoleSchema.safeParse(role);
		if (!parsed.success) return;
		void run(async () => {
			await api.setMemberRole(userId, parsed.data);
		});
	}

	/** Mints an invitation link and refreshes the pending list. */
	function invite(email: string, role: TUserRole): void {
		void run(async () => {
			const minted = await api.invite({ email, role });
			mintedLink = { email: minted.email, acceptUrl: `${location.origin}${minted.acceptPath}` };
			await loadInvitations();
		});
	}

	/** Revokes a pending invitation and refreshes the list. */
	function revoke(invitationId: string): void { // stupidity:allow Q3 -- template event handler
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

{#snippet header()}
	<Stack gap="xs" class="px-4 pt-4 sm:px-6 sm:pt-6">
		<h1 class="text-lg font-semibold">{t('pod.settings.people')}</h1>
		<p class="max-w-2xl text-xs text-muted-foreground">
			{t('pod.settings.peopleDescription')}
		</p>
		{#if failure}<p
				class="rounded-md border border-destructive/40 px-3 py-2 text-xs text-destructive"
				role="alert"
			>
				{failure}
			</p>{/if}
	</Stack>
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
		{t('pod.settings.adminsOnly')}
	</Stack>
{:else}
	<Bound size="full" clip class="bg-background">
		<Center measure="wide" class="h-full">
			<Cover top={header}>
				<Tabs
					bind:value={activeTab}
					onValueChange={onTabChange}
					animate={false}
					contentPadding={false}
					listClass="mx-0 w-full"
					class="min-h-0"
					config={[
						{
							name: 'members',
							label: t('pod.settings.members'),
							icon: 'lucide:users',
							content: membersContent
						},
						{
							name: 'invitations',
							label: t('pod.settings.invitations'),
							icon: 'lucide:mail-plus',
							content: invitationsContent
						},
						{
							name: 'teams',
							label: t('pod.settings.teams'),
							icon: 'lucide:network',
							content: teamsContent
						},
						{
							name: 'audit',
							label: t('pod.settings.auditLog'),
							icon: 'lucide:scroll-text',
							content: auditContent
						}
					] satisfies TabConfig[]}
				/>
			</Cover>
		</Center>
	</Bound>
{/if}
