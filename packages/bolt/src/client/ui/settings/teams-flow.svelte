<script lang="ts">
	import { Effect } from 'effect';
	import Icon from '@iconify/svelte';
	import { SvelteFlow, Background, Controls } from '@xyflow/svelte';
	import type { Edge, Node } from '@xyflow/svelte';
	import '@xyflow/svelte/dist/style.css';
	import { getErrorMessage } from '@norbital-ai/std';
	import { Button } from '@norbital-ai/ui/button';
	import { Combobox } from '@norbital-ai/ui/combobox';
	import * as Dialog from '@norbital-ai/ui/dialog';
	import { Input } from '@norbital-ai/ui/input';
	import { Stack } from '@norbital-ai/ui/layout';
	import { Textarea } from '@norbital-ai/ui/textarea';
	import {
		layoutTeamHierarchy,
		searchTeamNodes,
		type TeamNode
	} from '#lib/client/ui/settings/team-hierarchy.js';
	import { memberLabel, type MemberRow } from '#lib/client/ui/settings/rows.js';
	import { readMembershipEditor } from '#lib/client/ui/system/membership-editor.svelte.js';
	import TeamFlowNode from './teams-flow-node.svelte';
	import TeamDetailPanel from './team-detail-panel.svelte';

	/**
	 * The team hierarchy drawn as a Svelte Flow graph: one node per team, one edge per parent-child
	 * nesting. A toolbar offers search and, to an administrator, creating a team; selecting a node
	 * opens the panel that renames, re-parents and re-staffs it.
	 *
	 * The geometry is the pure layout from `team-hierarchy.ts` — a parent sits over the midpoint of
	 * its own subtree — and the writes go through the membership editor the shell publishes.
	 */
	let {
		teams = [],
		members = []
	}: {
		teams?: ReadonlyArray<TeamNode>;
		members?: ReadonlyArray<MemberRow>;
	} = $props();

	type TeamFlowData = Readonly<{
		readonly name: string;
		readonly description?: string;
		readonly members?: ReadonlyArray<string>;
		readonly memberCount?: number;
		readonly selected?: boolean;
	}>;

	const readEditor = readMembershipEditor();
	const editor = $derived(readEditor());
	const canManage = $derived(editor?.canManage === true);

	let search = $state('');
	let selectedId = $state<string | null>(null);
	let createOpen = $state(false);
	let createName = $state('');
	let createDescription = $state('');
	let createParentId = $state<string | null>(null);
	let createPending = $state(false);
	let createFailure = $state<string | null>(null);

	const visibleTeams = $derived(searchTeamNodes(teams, search));
	const chart = $derived(layoutTeamHierarchy(visibleTeams));
	const teamsById = $derived(new Map(teams.map((team) => [team.id, team] as const)));
	const membersByTeam = $derived.by(() => {
		const grouped = new Map<string, Array<MemberRow>>();
		for (const member of members) {
			if (member.team === undefined) continue;
			grouped.set(member.team, [...(grouped.get(member.team) ?? []), member]);
		}
		for (const group of grouped.values())
			group.sort((left, right) => memberLabel(left).localeCompare(memberLabel(right)));
		return grouped;
	});
	const selectedTeam = $derived(selectedId === null ? null : (teamsById.get(selectedId) ?? null));

	const nodes = $derived(
		chart.positions.map((position): Node<TeamFlowData, 'team'> => {
			const team = teamsById.get(position.id);
			const teamMembers = (team === undefined ? [] : membersByTeam.get(team.name)) ?? [];
			return {
				id: position.id,
				type: 'team',
				position: { x: position.x, y: position.y },
				draggable: false,
				selectable: true,
				connectable: false,
				data: {
					name: team?.name ?? position.id,
					...(team?.description === undefined ? {} : { description: team.description }),
					members: teamMembers.slice(0, 3).map(memberLabel),
					memberCount: teamMembers.length,
					selected: position.id === selectedId
				}
			};
		})
	);
	const edges = $derived(
		chart.edges.map((edge): Edge => ({
			id: `${edge.parentId}->${edge.childId}`,
			source: edge.parentId,
			target: edge.childId,
			type: 'smoothstep',
			style: 'stroke: var(--muted-foreground)'
		}))
	);

	const clearCreate = (): void => {
		createName = '';
		createDescription = '';
		createParentId = null;
		createFailure = null;
	};
	const create = (): void => {
		const membership = editor;
		if (membership === null || createName.trim() === '') return;
		createPending = true;
		createFailure = null;
		Effect.runFork(
			membership
				.createTeam({
					name: createName.trim(),
					parentId: createParentId,
					...(createDescription.trim() === '' ? {} : { description: createDescription.trim() })
				})
				.pipe(
					Effect.match({
						onSuccess: () => {
							createPending = false;
							createOpen = false;
							clearCreate();
							membership.refresh();
						},
						onFailure: (cause) => {
							createPending = false;
							createFailure = getErrorMessage(cause);
						}
					})
				)
		);
	};
</script>

<div class="flex h-full min-h-0 flex-col gap-3">
	<div class="flex flex-wrap items-center gap-2">
		<div class="relative min-w-56 grow">
			<Icon
				icon="lucide:search"
				class="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
			/>
			<Input
				class="pl-8"
				placeholder="Search teams…"
				aria-label="Search teams"
				bind:value={search}
			/>
		</div>
		{#if canManage}
			<Button
				size="sm"
				onclick={() => {
					clearCreate();
					createOpen = true;
				}}
			>
				<Icon icon="lucide:plus" class="mr-1.5 size-4" />
				New team
			</Button>
		{/if}
	</div>

	<div class="flex min-h-0 grow gap-3">
		<!-- repository-health:allow UI22 -- the SvelteFlow canvas box clips the flow renderer inside a fixed frame; Bound's named height contract and container-type containment are not safe around the flow library's own measurement -->
		<div
			class="h-[32rem] min-w-0 grow overflow-hidden rounded-lg border border-border/70 bg-card/20"
		>
			{#if teams.length === 0}
				<div class="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
					No teams configured.
				</div>
			{:else if visibleTeams.length === 0}
				<div class="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
					No teams match “{search}”.
				</div>
			{:else}
				<SvelteFlow
					nodes={[...nodes]}
					edges={[...edges]}
					nodeTypes={{ team: TeamFlowNode }}
					fitView
					fitViewOptions={{ padding: 0.2 }}
					nodesDraggable={false}
					nodesConnectable={false}
					elementsSelectable={true}
					panOnDrag={true}
					zoomOnScroll={true}
					proOptions={{ hideAttribution: true }}
					onnodeclick={({ node }) => (selectedId = node.id)}
				>
					<Background />
					<Controls />
				</SvelteFlow>
			{/if}
		</div>

		{#if selectedTeam !== null && editor !== null}
			{#key selectedTeam.id}
				<TeamDetailPanel
					team={selectedTeam}
					{teams}
					{members}
					{editor}
					onChanged={() => editor.refresh()}
					onClose={() => (selectedId = null)}
				/>
			{/key}
		{/if}
	</div>
</div>

<Dialog.Root
	open={createOpen}
	onOpenChange={(open) => {
		if (!open && !createPending) createOpen = false;
	}}
>
	<Dialog.Content class="w-[min(28rem,calc(100vw-2rem))]">
		<Dialog.Header>
			<Dialog.Title>New team</Dialog.Title>
			<Dialog.Description>
				Add a team to the hierarchy. Authority is bound by name at release, so a new team holds
				nothing until the workspace declares it.
			</Dialog.Description>
		</Dialog.Header>
		<Stack gap="sm">
			<label class="text-sm font-medium" for="new-team-name">Name</label>
			<Input id="new-team-name" bind:value={createName} placeholder="Team name" />
			<label class="text-sm font-medium" for="new-team-description">Description</label>
			<Textarea
				id="new-team-description"
				bind:value={createDescription}
				placeholder="What this team is for."
				rows={2}
			/>
			<span class="text-sm font-medium">Parent team</span>
			<Combobox
				options={[
					{ value: '', label: 'No parent (top level)' },
					...teams.map((team) => ({ value: team.id, label: team.name }))
				]}
				value={createParentId ?? ''}
				onValueChange={(next) => {
					createParentId = typeof next === 'string' && next !== '' ? next : null;
				}}
				allowClear={false}
				ariaLabel="Parent team"
				searchPlaceholder="Search teams…"
				emptyPlaceholder="No matching team"
			/>
		</Stack>
		{#if createFailure !== null}
			<p class="text-sm text-destructive" role="alert">{createFailure}</p>
		{/if}
		<Dialog.Footer>
			<Button variant="outline" disabled={createPending} onclick={() => (createOpen = false)}>
				Cancel
			</Button>
			<Button disabled={createPending || createName.trim() === ''} onclick={create}>
				{createPending ? 'Creating…' : 'Create team'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
