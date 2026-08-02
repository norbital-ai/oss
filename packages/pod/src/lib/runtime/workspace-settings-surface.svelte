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
	import WorkspacePoliciesTable from './settings/workspace-policies-table.svelte';
	import WorkspaceTeamChart from './settings/workspace-team-chart.svelte';
	import {
		toMemberRow,
		toPolicyRow,
		toTeamMembershipRow,
		toTeamRow,
		type WorkspaceInvitation,
		type WorkspaceSettingsApi
	} from './workspace-settings.js';

	type DeclaredChannel = {
		readonly key: string;
		readonly transport: string;
		readonly policy: string;
		readonly description?: string | null;
	};

	let {
		workspaceApi,
		user,
		api,
		channels = [],
		hostChannelSettingsHref = null
	}: {
		workspaceApi: CollectionClient<ErasedCollectionRegistry>;
		user: { readonly role: string | null };
		api: WorkspaceSettingsApi;
		channels?: readonly DeclaredChannel[];
		hostChannelSettingsHref?: string | null;
	} = $props();

	const isAdmin = $derived(user.role === 'admin');
	const PAGE = 500;
	type Section = 'members' | 'teams' | 'invitations' | 'policies' | 'audit' | 'channels';
	const sections: readonly { key: Section; label: string; icon: string }[] = [
		{ key: 'members', label: 'Members', icon: 'lucide:users' },
		{ key: 'teams', label: 'Teams', icon: 'lucide:network' },
		{ key: 'invitations', label: 'Invitations', icon: 'lucide:mail-plus' },
		{ key: 'policies', label: 'Roles & grants', icon: 'lucide:shield-check' },
		{ key: 'audit', label: 'Audit log', icon: 'lucide:scroll-text' },
		{ key: 'channels', label: 'Channels', icon: 'lucide:messages-square' }
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
		if (!isAdmin || section !== 'invitations' || invitationsLoaded) return;
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
						<p class="text-micro font-semibold tracking-wide text-muted-foreground uppercase">
							Tenant-owned configuration
						</p>
						<h1 class="text-base font-semibold">Workspace settings</h1>
						<p class="max-w-2xl text-xs text-muted-foreground">
							People, access, audit history, and channel declarations remain with this tenant and
							move with its database.
						</p>
					</Stack>

					{#if failure}<p
							class="rounded-md border border-destructive/40 px-3 py-2 text-xs text-destructive"
							role="alert"
						>
							{failure}
						</p>{/if}

					{#if section === 'members'}
						<WorkspaceMembersTable client={workspaceApi} {busy} onRoleChange={changeRole} />
					{:else if section === 'teams'}
						<WorkspaceTeamChart {teams} {members} {memberships} {policies} {api} {busy} {run} />
					{:else if section === 'invitations'}
						<WorkspaceInvitationsTable
							{invitations}
							loaded={invitationsLoaded}
							{busy}
							{mintedLink}
							onInvite={invite}
							onRevoke={revoke}
							onRefresh={loadInvitations}
						/>
					{:else if section === 'policies'}
						<WorkspacePoliciesTable client={workspaceApi} />
					{:else if section === 'audit'}
						<WorkspaceAuditTable client={workspaceApi} />
					{:else}
						<Stack gap="md">
							<div>
								<h2 class="text-sm font-semibold">Agent channels</h2>
								<p class="mt-1 text-xs text-muted-foreground">
									Channel identity, policy, and task are code-declared. Host transport credentials
									are configured separately and never stored in the tenant database.
								</p>
							</div>
							{#each channels as channel (channel.key)}
								<Inline gap="md" class="rounded-lg border bg-card p-4">
									<Icon icon="lucide:message-circle" class="size-4 text-muted-foreground" />
									<div class="min-w-0 flex-1">
										<p class="text-xs font-semibold">{channel.key}</p>
										<p class="mt-1 text-micro text-muted-foreground">
											{channel.transport} · policy {channel.policy}{channel.description
												? ` · ${channel.description}`
												: ''}
										</p>
									</div>
								</Inline>
							{:else}
								<p
									class="rounded-lg border border-dashed p-8 text-center text-xs text-muted-foreground"
								>
									No channels are declared in this workspace.
								</p>
							{/each}
							{#if hostChannelSettingsHref}
								<a
									href={hostChannelSettingsHref}
									class="inline-flex h-9 w-fit items-center gap-2 rounded-md border border-input bg-background px-3 text-xs font-medium hover:bg-accent"
									><Icon icon="lucide:key-round" class="size-4" />Configure host transport
									credentials</a
								>
							{/if}
						</Stack>
					{/if}
				</Stack>
			</Scroll>
		</div>
	</Bound>
{/if}
