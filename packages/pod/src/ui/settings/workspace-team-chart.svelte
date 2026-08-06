<script lang="ts">
	import Icon from '@iconify/svelte';
	import { Background, Controls, Position, SvelteFlow, type Edge, type Node } from '@xyflow/svelte';
	import '@xyflow/svelte/dist/style.css';
	import { Button } from '@norbital-ai/ui/button';
	import * as Dialog from '@norbital-ai/ui/dialog';
	import { Input } from '@norbital-ai/ui/input';
	import { Cluster, Inline, Stack } from '@norbital-ai/ui/layout';
	import TeamNode from './team-node.svelte';
	import { layoutTeamHierarchy } from './team-hierarchy.js';
	import type {
		MemberRow,
		PolicyRow,
		TeamMembershipRow,
		TeamRow,
		WorkspaceSettingsApi
	} from '../shell/workspace-settings.js';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import type { PodUiKeys } from '$lib/i18n/index.js';

	const { t } = useI18n<PodUiKeys>();

	let {
		teams,
		members,
		memberships,
		policies,
		api,
		busy,
		run
	}: {
		teams: readonly TeamRow[];
		members: readonly MemberRow[];
		memberships: readonly TeamMembershipRow[];
		policies: readonly PolicyRow[];
		api: WorkspaceSettingsApi;
		busy: boolean;
		run: (work: () => Promise<void>) => Promise<void>;
	} = $props();

	type TeamNodeData = {
		teamId: string;
		label: string;
		memberCount: number;
		description: string | null;
		selected: boolean;
	};
	type TeamFlowNode = Node<TeamNodeData>;

	let selectedTeamId = $state<string | null>(null);
	let dialogOpen = $state(false);
	let editingTeamId = $state<string | null>(null);
	let teamName = $state('');
	let teamDescription = $state('');
	let teamParentId = $state('');
	let teamPolicyId = $state('');
	let memberToAdd = $state('');

	const selectedTeam = $derived(teams.find((team) => team.norbital_id === selectedTeamId) ?? null);
	const membersById = $derived(new Map(members.map((member) => [member.norbital_id, member])));
	const selectedMemberships = $derived(
		memberships.filter((membership) => membership.team_id === selectedTeamId)
	);
	const selectedMemberIds = $derived(new Set(selectedMemberships.map((entry) => entry.user_id)));
	const availableMembers = $derived(
		members.filter((member) => !selectedMemberIds.has(member.norbital_id))
	);
	const selectedPolicy = $derived(
		selectedTeam
			? (policies.find((policy) => policy.norbital_id === selectedTeam.policy_id) ?? null)
			: null
	);

	function memberCount(teamId: string): number {
		return memberships.filter((membership) => membership.team_id === teamId).length;
	}

	const nodes = $derived.by((): TeamFlowNode[] => {
		const positions = new Map(
			layoutTeamHierarchy(teams).map((position) => [position.id, position])
		);
		return teams.map((team) => ({
			id: team.norbital_id,
			type: 'team',
			position: positions.get(team.norbital_id) ?? { x: 0, y: 0 },
			targetPosition: Position.Top,
			sourcePosition: Position.Bottom,
			data: {
				teamId: team.norbital_id,
				label: team.name,
				memberCount: memberCount(team.norbital_id),
				description: team.description,
				selected: selectedTeamId === team.norbital_id
			}
		}));
	});
	const edges = $derived.by((): Edge[] =>
		teams.flatMap((team) =>
			team.parent_id
				? [
						{
							id: `team-${team.parent_id}-${team.norbital_id}`,
							source: team.parent_id,
							target: team.norbital_id,
							type: 'smoothstep',
							style: 'stroke: var(--color-border); stroke-width: 1.5px;'
						} satisfies Edge
					]
				: []
		)
	);
	const nodeTypes = { team: TeamNode };
	const fitViewOptions = { padding: 0.3, maxZoom: 1 };

	function openCreate(): void {
		editingTeamId = null;
		teamName = '';
		teamDescription = '';
		teamParentId = '';
		teamPolicyId = '';
		dialogOpen = true;
	}

	function openEdit(team: TeamRow): void {
		editingTeamId = team.norbital_id;
		teamName = team.name;
		teamDescription = team.description ?? '';
		teamParentId = team.parent_id ?? '';
		teamPolicyId = team.policy_id ?? '';
		dialogOpen = true;
	}

	function saveTeam(): void {
		const name = teamName.trim();
		if (!name) return;
		void run(async () => {
			const input = {
				name,
				description: teamDescription.trim() || null,
				parent_id: teamParentId || null,
				policy_id: teamPolicyId || null
			};
			if (editingTeamId) await api.updateTeam(editingTeamId, input);
			else await api.createTeam(input);
			dialogOpen = false;
		});
	}

	function deleteSelected(): void {
		if (!selectedTeam || !confirm(t('pod.settings.deleteTeamConfirm', { name: selectedTeam.name })))
			return;
		void run(async () => {
			await api.deleteTeam(selectedTeam.norbital_id);
			selectedTeamId = null;
		});
	}

	function addMember(): void {
		if (!selectedTeam || !memberToAdd) return;
		void run(async () => {
			await api.addTeamMember(selectedTeam.norbital_id, memberToAdd);
			memberToAdd = '';
		});
	}
</script>

<Stack gap="md" data-testid="settings-teams">
	<Cluster align="center" justify="between" gap="md">
		<div>
			<h2 class="text-sm font-semibold">{t('pod.settings.orgChart')}</h2>
			<p class="mt-0.5 text-xs text-muted-foreground">
				{t('pod.settings.orgChartDescription')}
			</p>
		</div>
		<Button
			variant="outline"
			size="icon"
			hint={t('pod.settings.createTeam')}
			aria-label={t('pod.settings.createTeam')}
			onclick={openCreate}
		>
			<Icon icon="lucide:plus" class="size-4" />
		</Button>
	</Cluster>

	{#if teams.length === 0}
		<div class="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
			{t('pod.settings.noTeams')}
		</div>
	{:else}
		<div
			class={`grid overflow-hidden rounded-lg border ${selectedTeam ? 'lg:grid-cols-[minmax(0,1fr)_20rem]' : ''}`}
		>
			<div
				class="h-[clamp(24rem,58vh,44rem)] min-h-0 bg-muted/10"
				data-testid="settings-org-chart-canvas"
			>
				<SvelteFlow
					{nodes}
					{edges}
					{nodeTypes}
					fitView
					{fitViewOptions}
					nodesDraggable={false}
					nodesConnectable={false}
					onnodeclick={(event: { node: TeamFlowNode }) =>
						(selectedTeamId = selectedTeamId === event.node.id ? null : event.node.id)}
					class="!bg-transparent"
				>
					<Background gap={20} size={1} class="!text-muted-foreground/20" />
					<Controls showLock={false} {fitViewOptions} />
				</SvelteFlow>
			</div>

			{#if selectedTeam}
				<Stack gap="md" class="border-t bg-card p-4 lg:border-t-0 lg:border-l">
					<Inline align="start" justify="between" gap="sm">
						<div class="min-w-0 flex-1">
							<h3 class="truncate text-sm font-semibold">{selectedTeam.name}</h3>
							{#if selectedTeam.description}<p class="mt-1 text-xs text-muted-foreground">
									{selectedTeam.description}
								</p>{/if}
						</div>
						<Inline gap="xs" shrink={false}>
							<Button
								variant="ghost"
								size="icon"
								hint={t('pod.settings.editTeam')}
								aria-label={t('pod.settings.editAria', { name: selectedTeam.name })}
								onclick={() => openEdit(selectedTeam)}
							>
								<Icon icon="lucide:pencil" class="size-4" />
							</Button>
							<Button
								variant="ghost"
								size="icon"
								hint={t('pod.settings.deleteTeam')}
								aria-label={t('pod.settings.deleteAria', { name: selectedTeam.name })}
								class="text-muted-foreground hover:text-destructive"
								onclick={deleteSelected}
							>
								<Icon icon="lucide:trash-2" class="size-4" />
							</Button>
						</Inline>
					</Inline>

					<Stack gap="xs" class="border-t pt-3">
						<p class="text-micro font-semibold tracking-wide text-muted-foreground uppercase">
							{t('pod.settings.policy')}
						</p>
						<p class="text-xs">{selectedPolicy?.name ?? t('pod.settings.noPolicyAssigned')}</p>
					</Stack>

					<Stack gap="xs" class="border-t pt-3">
						<p class="text-micro font-semibold tracking-wide text-muted-foreground uppercase">
							{t('pod.settings.members')}
						</p>
						{#each selectedMemberships as membership (membership.norbital_id)}
							{@const member = membersById.get(membership.user_id)}
							{#if member}
								<Inline gap="sm" class="rounded-md bg-muted/50 py-1.5 pr-1 pl-2 text-xs">
									<span class="min-w-0 flex-1 truncate">{member.name || member.email}</span>
									<Button
										variant="ghost"
										size="icon"
										hint={t('pod.settings.removeMember')}
										aria-label={t('pod.settings.removeMemberAria', {
											email: member.email,
											team: selectedTeam.name
										})}
										disabled={busy}
										onclick={() =>
											void run(async () => {
												await api.removeTeamMember(membership.norbital_id);
											})}
									>
										<Icon icon="lucide:x" class="size-3.5" />
									</Button>
								</Inline>
							{/if}
						{:else}
							<p class="text-xs text-muted-foreground">{t('pod.settings.noMembersInTeam')}</p>
						{/each}
						<Inline gap="xs" class="pt-1">
							<select
								class="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-xs"
								aria-label={t('pod.settings.addSomeoneTo', { name: selectedTeam.name })}
								value={memberToAdd}
								onchange={(event) => (memberToAdd = event.currentTarget.value)}
							>
								<option value="">{t('pod.settings.addMemberPlaceholder')}</option>
								{#each availableMembers as member (member.norbital_id)}<option
										value={member.norbital_id}>{member.email}</option
									>{/each}
							</select>
							<Button
								size="sm"
								aria-label={t('pod.settings.addMemberTo', { name: selectedTeam.name })}
								disabled={!memberToAdd || busy}
								onclick={addMember}>{t('pod.settings.add')}</Button
							>
						</Inline>
					</Stack>
				</Stack>
			{/if}
		</div>
	{/if}
</Stack>

<Dialog.Root bind:open={dialogOpen}>
	<Dialog.Content class="max-w-md">
		<Dialog.Header>
			<Dialog.Title>{editingTeamId ? t('pod.settings.editTeamTitle') : t('pod.settings.createTeam')}</Dialog.Title>
			<Dialog.Description>{t('pod.settings.teamDialogDescription')}</Dialog.Description>
		</Dialog.Header>
		<Stack gap="md">
			<label class="space-y-1 text-xs font-medium"
				>{t('pod.settings.name')}<Input bind:value={teamName} placeholder={t('pod.settings.teamNamePlaceholder')} /></label
			>
			<label class="space-y-1 text-xs font-medium"
				>{t('pod.settings.description')}<Input bind:value={teamDescription} placeholder={t('pod.settings.teamDescriptionPlaceholder')} /></label
			>
			<label class="space-y-1 text-xs font-medium"
				>{t('pod.settings.parentTeam')}
				<select
					class="h-9 w-full rounded-md border border-input bg-background px-2 text-xs"
					bind:value={teamParentId}
				>
					<option value="">{t('pod.settings.noParent')}</option>
					{#each teams.filter((team) => team.norbital_id !== editingTeamId) as team (team.norbital_id)}<option
							value={team.norbital_id}>{team.name}</option
						>{/each}
				</select>
			</label>
			<label class="space-y-1 text-xs font-medium"
				>{t('pod.settings.policy')}
				<select
					class="h-9 w-full rounded-md border border-input bg-background px-2 text-xs"
					bind:value={teamPolicyId}
				>
					<option value="">{t('pod.settings.noPolicy')}</option>
					{#each policies as policy (policy.norbital_id)}<option value={policy.norbital_id}
							>{policy.name}</option
						>{/each}
				</select>
			</label>
		</Stack>
		<Dialog.Footer>
			<Dialog.Close>{t('pod.settings.cancel')}</Dialog.Close>
			<Button disabled={!teamName.trim() || busy} onclick={saveTeam}
				>{editingTeamId ? t('pod.settings.save') : t('pod.settings.create')}</Button
			>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
