<script lang="ts">
	import { CollectionTable } from '@norbital-ai/ui/collection-table';
	import { Bound, Cluster, Cover, Inline, Stack } from '@norbital-ai/ui/layout';
	import { Tabs, type TabConfig } from '@norbital-ai/ui/tabs';
	import type { CollectionDefinition, CollectionRecord } from '@norbital-ai/std/collection';
	import {
		EMPTY_WORKSPACE_ACCESS,
		invitationStatusAt,
		sortAudit,
		sortMembers,
		type WorkspaceAccess
	} from '#lib/client/ui/settings/rows.js';
	import TeamChart from './teams-flow.svelte';
	import { inMemoryCollectionClient } from '#lib/client/ui/settings/table-client.js';

	/**
	 * The People surface: who is a member, how the teams nest, which invitations are outstanding,
	 * and what changed. Every tab is a collection table except Teams, which is the hierarchy flow.
	 *
	 * Membership is not stored as one collection — it is derived from the sessions and external
	 * subjects a tenant actually has — so the rows are held here and the table's own predicates
	 * answer `where`, `search` and the filter chips.
	 */
	let {
		access = EMPTY_WORKSPACE_ACCESS,
		loading = false,
		error,
		now = new Date()
	}: {
		access?: WorkspaceAccess;
		loading?: boolean;
		error?: string | undefined;
		now?: Date;
	} = $props();

	const MEMBERS_COLLECTION = 'workspace_members';
	const INVITATIONS_COLLECTION = 'workspace_invitations';
	const EVENTS_COLLECTION = 'workspace_events';

	/**
	 * One definition per tab, so the filter builder offers the real option set instead of a
	 * free-text box. The vocabulary is the one the workspace-access projection publishes.
	 */
	const DEFINITIONS: {
		readonly [MEMBERS_COLLECTION]: CollectionDefinition;
		readonly [INVITATIONS_COLLECTION]: CollectionDefinition;
		readonly [EVENTS_COLLECTION]: CollectionDefinition;
	} = {
		[MEMBERS_COLLECTION]: {
			name: MEMBERS_COLLECTION,
			recordLabel: 'name',
			system: true,
			fields: [
				{ name: 'name', kind: 'text', nullable: false, search: true },
				{ name: 'email', kind: 'text', nullable: false, search: true },
				{
					name: 'role',
					kind: 'enum',
					nullable: false,
					values: ['admin', 'manager', 'basic']
				},
				{
					name: 'status',
					kind: 'enum',
					nullable: false,
					values: ['active', 'suspended', 'invited']
				},
				// One team, nullable. It was declared as a string array, which made the filter builder
				// offer a set operation over a field that carries one name — and nullable because
				// somebody nobody has placed is an ordinary member, not a data fault.
				{ name: 'team', kind: 'text', nullable: true }
			]
		},
		[INVITATIONS_COLLECTION]: {
			name: INVITATIONS_COLLECTION,
			recordLabel: 'email',
			system: true,
			fields: [
				{ name: 'email', kind: 'text', nullable: false, search: true },
				{
					name: 'role',
					kind: 'enum',
					nullable: false,
					values: ['admin', 'manager', 'basic']
				},
				{
					name: 'status',
					kind: 'enum',
					nullable: false,
					values: ['pending', 'accepted', 'revoked', 'expired']
				},
				{ name: 'invitedBy', kind: 'text', nullable: true, search: true },
				{ name: 'expiresAt', kind: 'text', nullable: true }
			]
		},
		[EVENTS_COLLECTION]: {
			name: EVENTS_COLLECTION,
			recordLabel: 'action',
			system: true,
			fields: [
				{ name: 'action', kind: 'text', nullable: false, search: true },
				{ name: 'actor', kind: 'text', nullable: false, search: true },
				{ name: 'subject', kind: 'text', nullable: true },
				{ name: 'at', kind: 'text', nullable: false }
			]
		}
	};

	const memberRows = $derived(
		sortMembers(access.members).map((member) => ({
			...member,
			id: member.id
		})) satisfies ReadonlyArray<CollectionRecord>
	);
	const invitationRows = $derived(
		access.invitations.map((invitation) => ({
			...invitation,
			id: invitation.id,
			status: invitationStatusAt(invitation, now)
		})) satisfies ReadonlyArray<CollectionRecord>
	);
	const eventRows = $derived(
		sortAudit(access.events).map((event) => ({
			...event,
			id: event.id
		})) satisfies ReadonlyArray<CollectionRecord>
	);

	/**
	 * Derived rather than built once: the rows arrive after this surface mounts, and a client whose
	 * `db` captured the first (empty) rows would keep answering "no results" for the rest of the
	 * session no matter how many times the tables remounted.
	 */
	const peopleClient = $derived(
		inMemoryCollectionClient(DEFINITIONS, {
			[MEMBERS_COLLECTION]: memberRows,
			[INVITATIONS_COLLECTION]: invitationRows,
			[EVENTS_COLLECTION]: eventRows
		})
	);

	let activeTab = $state('people');
</script>

<section
	aria-labelledby="workspace-settings-title"
	aria-busy={loading}
	class="h-full min-h-full min-w-0"
>
	<Cover class="relative min-w-0 bg-background" gap="none">
		{#snippet top()}
			<Stack gap="lg" shrink={false} class="bg-background px-4 pt-4 sm:px-6 sm:pt-6">
				<Stack as="header" gap="xs">
					<h2 id="workspace-settings-title" class="text-heading">People</h2>
					<p class="max-w-2xl text-meta">
						Members, teams, invitations, and activity — each read as its own surface.
					</p>
				</Stack>

				{#if error}
					<p
						role="alert"
						class="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
					>
						{error}
					</p>
				{:else if loading}
					<p role="status" class="text-sm text-muted-foreground">Loading workspace access…</p>
				{:else}
					<Cluster gap="sm" align="center" shrink={false}>
						<Tabs
							value={activeTab}
							onValueChange={(next) => (activeTab = next)}
							showContent={false}
							variant="underline"
							layout="responsive"
							animate={false}
							class="min-w-0 flex-1 !shrink"
							listClass="mx-0 w-full"
							config={[
								{ name: 'people', label: 'People', icon: 'lucide:users', content: '' },
								{ name: 'teams', label: 'Teams', icon: 'lucide:network', content: '' },
								{
									name: 'invitations',
									label: 'Invitations',
									icon: 'lucide:mail-plus',
									content: ''
								},
								{ name: 'activity', label: 'Activity', icon: 'lucide:history', content: '' }
							] satisfies TabConfig[]}
						/>
					</Cluster>
				{/if}
			</Stack>
		{/snippet}

		<!-- Page gutter on Inline; each tab draws its own furniture (toolbar + card) the way a
		     standalone collection surface does, so nothing here re-boxes it a second time. -->
		<Inline align="stretch" gap="none" fill class="px-4 pt-4 pb-4 sm:px-6 sm:pt-6 sm:pb-6">
			<Bound size="full" grow clip class="relative min-w-0 w-full">
				{#if activeTab === 'people'}
					{@render membersView()}
				{:else if activeTab === 'teams'}
					{@render teamsView()}
				{:else if activeTab === 'invitations'}
					{@render invitationsView()}
				{:else}
					{@render eventsView()}
				{/if}
			</Bound>
		</Inline>
	</Cover>
</section>

{#snippet membersView()}
	{#key memberRows}
		<CollectionTable
			client={peopleClient}
			collection={MEMBERS_COLLECTION}
			view="workspace-settings:people"
			title="Members"
			description="Membership is derived from sessions and linked external subjects; it is not a table that can be edited here."
			features={{ create: false }}
			query={{ orderBy: { name: 'asc' } }}
		>
			{#snippet columns({ Column })}
				<Column name="name" label="Name" card="title" />
				<Column name="email" label="Email" card="subtitle" />
				<Column name="role" label="Role" card="badge" />
				<Column name="status" label="Status" />
				<Column
					name="team"
					label="Team"
					render={({ value }) => (typeof value === 'string' && value !== '' ? value : '—')}
				/>
			{/snippet}
		</CollectionTable>
	{/key}
{/snippet}

{#snippet teamsView()}
	<TeamChart teams={access.teams} />
{/snippet}

{#snippet invitationsView()}
	{#key invitationRows}
		<CollectionTable
			client={peopleClient}
			collection={INVITATIONS_COLLECTION}
			view="workspace-settings:invitations"
			title="Invitations"
			description="Open invitations to join this workspace, and how each one ended. A pending invitation with a passed deadline reads as expired."
			features={{ create: false }}
			query={{ orderBy: { status: 'asc' } }}
		>
			{#snippet columns({ Column })}
				<Column name="email" label="Email" card="title" />
				<Column name="role" label="Role" card="badge" />
				<Column name="status" label="Status" />
				<Column name="invitedBy" label="Invited by" />
				<Column name="expiresAt" label="Expires" />
			{/snippet}
		</CollectionTable>
	{/key}
{/snippet}

{#snippet eventsView()}
	{#key eventRows}
		<CollectionTable
			client={peopleClient}
			collection={EVENTS_COLLECTION}
			view="workspace-settings:activity"
			title="Activity"
			description="The access events the runtime has recorded — invitations, joins and revocations."
			features={{ create: false }}
			query={{ orderBy: { at: 'desc' } }}
		>
			{#snippet columns({ Column })}
				<Column name="action" label="Action" card="title" />
				<Column name="actor" label="Actor" card="subtitle" />
				<Column name="subject" label="Subject" />
				<Column name="at" label="When" />
			{/snippet}
		</CollectionTable>
	{/key}
{/snippet}
