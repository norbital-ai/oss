<script lang="ts">
	import { Handle, Position, type Node, type NodeProps } from '@xyflow/svelte';
	import { Cluster, Inline } from '@norbital-ai/ui/layout';

	type TeamFlowData = Readonly<{
		readonly name: string;
		readonly description?: string;
		/** Up to three member labels, so the node says who is in the team at a glance. */
		readonly members?: ReadonlyArray<string>;
		readonly memberCount?: number;
		readonly selected?: boolean;
	}>;

	type TeamFlowNode = Node<TeamFlowData, 'team'>;

	/** One team on the hierarchy flow: a card carrying its name, a member preview and a count. */
	let { data }: NodeProps<TeamFlowNode> = $props();
</script>

<div
	class="w-56 rounded-md border bg-card px-3 py-2 shadow-card transition-colors {data.selected
		? 'border-brand ring-2 ring-brand/40'
		: 'border-border'}"
>
	<Inline align="start" justify="between" gap="sm">
		<span class="text-xs font-semibold text-foreground">{data.name}</span>
		{#if (data.memberCount ?? 0) > 0}
			<span class="shrink-0 rounded-full bg-muted px-1.5 text-[0.6rem] text-muted-foreground">
				{data.memberCount}
			</span>
		{/if}
	</Inline>
	{#if data.description}
		<p class="mt-0.5 line-clamp-2 text-[0.65rem] leading-tight text-muted-foreground">
			{data.description}
		</p>
	{/if}
	{#if (data.members ?? []).length > 0}
		<Cluster as="ul" gap="xs" align="start" class="mt-1.5 border-t border-border/60 pt-1.5">
			{#each data.members ?? [] as member (member)}
				<li
					class="max-w-full truncate rounded bg-muted/60 px-1.5 py-0.5 text-[0.6rem] text-muted-foreground"
				>
					{member}
				</li>
			{/each}
			{#if (data.memberCount ?? 0) > (data.members ?? []).length}
				<li class="px-1 py-0.5 text-[0.6rem] text-muted-foreground">
					+{(data.memberCount ?? 0) - (data.members ?? []).length}
				</li>
			{/if}
		</Cluster>
	{:else}
		<p class="mt-1 text-[0.6rem] text-muted-foreground">No members</p>
	{/if}
	<Handle
		type="target"
		position={Position.Top}
		class="!h-px !w-px !border-0 !bg-transparent !opacity-0"
	/>
	<Handle
		type="source"
		position={Position.Bottom}
		class="!h-px !w-px !border-0 !bg-transparent !opacity-0"
	/>
</div>
