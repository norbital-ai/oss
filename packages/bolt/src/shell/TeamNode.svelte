<!-- One team on the hierarchy flow (staging's `teams-flow-node`): its name, a member preview and the count. -->
<script lang="ts">
	import { Handle, Position, type Node, type NodeProps } from '@xyflow/svelte';

	type TeamData = { name: string; members: readonly string[]; count: number; selected: boolean; none: string };
	let { data }: NodeProps<Node<TeamData, 'team'>> = $props();
	const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');
</script>

<div class={['w-56 rounded-md border bg-card px-3 py-2 text-card-foreground shadow-card transition-colors', data.selected ? 'border-brand ring-2 ring-brand/40' : 'border-border']}>
	<div class="flex items-start justify-between gap-2">
		<span class="min-w-0 truncate text-sm font-medium">{data.name}</span>
		{#if data.count > 0}<span class="shrink-0 rounded-full bg-muted px-1.5 text-xs tabular-nums text-muted-foreground">{data.count}</span>{/if}
	</div>
	{#if data.members.length > 0}
		<ul class="mt-1.5 flex items-center border-t border-border pt-1.5" aria-label={data.members.join(', ')}>
			{#each data.members as m, i (i)}
				<li class="-ml-1 grid size-6 place-items-center rounded-full border-2 border-card bg-muted text-tiny font-medium text-muted-foreground first:ml-0" title={m}>{initials(m)}</li>
			{/each}
			{#if data.count > data.members.length}<li class="ml-1 text-xs text-muted-foreground">+{data.count - data.members.length}</li>{/if}
		</ul>
	{:else}
		<p class="mt-1 text-xs text-muted-foreground">{data.none}</p>
	{/if}
	<Handle type="target" position={Position.Top} class="size-px! border-0! bg-transparent! opacity-0!" />
	<Handle type="source" position={Position.Bottom} class="size-px! border-0! bg-transparent! opacity-0!" />
</div>
