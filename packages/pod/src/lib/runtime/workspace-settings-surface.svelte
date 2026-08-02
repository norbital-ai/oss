<script lang="ts">
	import Icon from '@iconify/svelte';
	import type {
		CollectionClient,
		ErasedCollectionRegistry
	} from '@norbital-ai/platform-utils/collection';
	import { UserRoleSchema, type TUserRole } from '@norbital-ai/platform-utils/system/types';
	import { Bound, Inline, Scroll, Stack } from '@norbital-ai/ui/layout';
	import { cn } from '@norbital-ai/ui/utils';
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
	type Section = 'people' | 'teams' | 'audit';
	type PeopleTab = 'members' | 'invitations';
	const sections: readonly { key: Section; label: string; icon: string }[] = [
		{ key: 'people', label: 'People', icon: 'lucide:users' },
		{ key: 'teams', label: 'Teams', icon: 'lucide:network' },
		{ key: 'audit', label: 'Audit log', icon: 'lucide:scroll-text' }
	];
	let section = $state<Section>('people');
	let peopleTab = $state<PeopleTab>('members');

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
		if (!isAdmin || section !== 'people' || peopleTab !== 'invitations' || invitationsLoaded)
			return;
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
		<div class="flex h-full min-h-0 flex-col md:flex-row">
			<Scroll
				as="nav"
				name="Tenant settings navigation"
				axis="x"
				layout="inline"
				align="start"
				gap="xs"
				class="shrink-0 border-b bg-card px-2 py-2 md:w-52 md:border-r md:border-b-0 md:px-2 md:py-4"
				aria-label="Tenant settings"
			>
				<Stack gap="xs" class="hidden w-full md:flex">
					<p
						class="px-2 pb-2 text-micro font-semibold tracking-wide text-muted-foreground uppercase"
					>
						Tenant database
					</p>
					{#each sections as entry (entry.key)}
						<button
							type="button"
							role="tab"
							aria-selected={section === entry.key}
							class={cn(
								'flex h-9 items-center gap-2 rounded-md px-2 text-left text-xs font-medium transition-colors',
								section === entry.key
									? 'bg-accent text-foreground'
									: 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
							)}
							aria-current={section === entry.key ? 'page' : undefined}
							onclick={() => (section = entry.key)}
						>
							<Icon icon={entry.icon} class="size-4 shrink-0" />{entry.label}
						</button>
					{/each}
				</Stack>
				<Inline gap="xs" class="md:hidden">
					{#each sections as entry (entry.key)}
						<button
							type="button"
							role="tab"
							aria-selected={section === entry.key}
							class={cn(
								'flex h-9 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium',
								section === entry.key ? 'bg-accent text-foreground' : 'text-muted-foreground'
							)}
							onclick={() => (section = entry.key)}
							><Icon icon={entry.icon} class="size-3.5" />{entry.label}</button
						>
					{/each}
				</Inline>
			</Scroll>

			<Scroll name="Tenant settings" class="min-w-0 flex-1">
				<Stack gap="lg" class="mx-auto w-full max-w-6xl p-4 sm:p-6">
					<Stack as="header" gap="xs">
						<h1 class="text-base font-semibold">Workspace settings</h1>
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

					{#if section === 'people'}
						<Stack gap="md">
							<Inline
								gap="none"
								role="tablist"
								aria-label="People"
								class="w-fit rounded-md border border-border/70 bg-card p-px"
							>
								{#each [{ key: 'members' as const, label: 'Members' }, { key: 'invitations' as const, label: 'Invitations' }] as tab (tab.key)}
									<button
										type="button"
										role="tab"
										aria-selected={peopleTab === tab.key}
										class={cn(
											'h-8 rounded-sm px-3 text-xs font-medium transition-colors',
											peopleTab === tab.key
												? 'bg-accent text-foreground shadow-xs'
												: 'text-muted-foreground hover:text-foreground'
										)}
										onclick={() => (peopleTab = tab.key)}
									>
										{tab.label}
									</button>
								{/each}
							</Inline>

							{#if peopleTab === 'members'}
								<WorkspaceMembersTable client={workspaceApi} {busy} onRoleChange={changeRole} />
							{:else}
								<WorkspaceInvitationsTable
									{invitations}
									loaded={invitationsLoaded}
									{busy}
									{mintedLink}
									onInvite={invite}
									onRevoke={revoke}
									onRefresh={loadInvitations}
								/>
							{/if}
						</Stack>
					{:else if section === 'teams'}
						<WorkspaceTeamChart {teams} {members} {memberships} {policies} {api} {busy} {run} />
					{:else}
						<WorkspaceAuditTable client={workspaceApi} />
					{/if}
				</Stack>
			</Scroll>
		</div>
	</Bound>
{/if}
