<script lang="ts" module>
	import type { Settings } from './data.ts';

	export type TeamNodeData = {
		readonly team: Settings['teams'][number];
		readonly members: number;
		readonly selected: boolean;
		readonly t: (key: string) => string;
		readonly onEdit: (id: string) => void;
		readonly onAddChild: (parentId: string) => void;
	};
</script>

<script lang="ts">
	import { Handle, Position, type Node, type NodeProps } from '@xyflow/svelte';
	import { Badge, Icon } from '@norbital-ai/ui';

	let { data }: NodeProps<Node<TeamNodeData>> = $props();
	const team = $derived(data.team);
	const visiblePolicies = $derived(team.policies.slice(0, 3));
	const overflowPolicies = $derived(Math.max(0, team.policies.length - visiblePolicies.length));
</script>

<Handle
	type="target"
	position={Position.Top}
	class="!size-2.5 !border-2 !border-card !bg-muted-foreground/70"
/>

<div
	class={[
		'group relative flex w-[15.5rem] flex-col gap-2 rounded-lg border bg-card p-3 text-left transition-colors',
		data.selected
			? 'border-brand ring-1 ring-brand/30'
			: 'border-border hover:border-border-control'
	]}
	data-team-node={team.id}
>
	<div class="flex items-start justify-between gap-2">
		<button
			type="button"
			class="nodrag nopan min-w-0 flex-1 cursor-pointer text-left focus-visible:outline-none"
			onclick={() => data.onEdit(team.id)}
		>
			<div class="truncate text-sm font-medium text-foreground">{team.name}</div>
		</button>
		<span
			class="inline-flex shrink-0 items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-micro text-muted-foreground tabular-nums"
			title={data.t('Members')}
		>
			<Icon name="lucide:users" class="size-3" />
			{data.members}
		</span>
		<button
			type="button"
			class="nodrag nopan grid size-6 shrink-0 cursor-pointer place-items-center rounded-sm text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none group-hover:opacity-100 [@media(hover:none)]:opacity-100"
			aria-label={data.t('Add sub-team')}
			title={data.t('Add sub-team')}
			onclick={(event) => {
				event.stopPropagation();
				data.onAddChild(team.id);
			}}
		>
			<Icon name="lucide:plus" class="size-3.5" />
		</button>
	</div>

	<button
		type="button"
		class="nodrag nopan flex min-h-5 cursor-pointer flex-wrap items-center gap-1 text-left focus-visible:outline-none"
		onclick={() => data.onEdit(team.id)}
	>
		{#if visiblePolicies.length === 0}
			<span class="text-meta">{data.t('No policies')}</span>
		{:else}
			{#each visiblePolicies as policy (policy)}
				<Badge variant="outline" class="max-w-full truncate text-micro font-normal"
					>{policy}</Badge
				>
			{/each}
			{#if overflowPolicies > 0}
				<span class="text-micro text-muted-foreground tabular-nums">+{overflowPolicies}</span>
			{/if}
		{/if}
	</button>
</div>

<Handle
	type="source"
	position={Position.Bottom}
	class="!size-2.5 !border-2 !border-card !bg-muted-foreground/70"
/>
