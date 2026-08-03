<script lang="ts">
	import Icon from '@iconify/svelte';
	import { Inline } from '@norbital-ai/ui/layout';
	import { Handle, Position } from '@xyflow/svelte';

	let {
		data
	}: {
		data: {
			teamId: string;
			label: string;
			memberCount: number;
			description: string | null;
			selected: boolean;
		};
	} = $props();
</script>

<button
	type="button"
	data-testid="team-node"
	data-team-id={data.teamId}
	class={`relative flex w-56 flex-col rounded-lg border bg-card px-3 py-2.5 text-sm shadow-card transition-colors ${data.selected ? 'border-primary ring-2 ring-primary/20' : 'hover:border-foreground/30'}`}
>
	<Handle type="target" position={Position.Top} class="!size-1.5 !border-0 !bg-border !opacity-0" />
	<Inline align="center" gap="xs">
		<Icon icon="lucide:users" class="size-3.5 shrink-0 text-muted-foreground" />
		<span class="truncate font-medium text-foreground">{data.label}</span>
		<span class="shrink-0 text-micro tabular-nums text-muted-foreground">{data.memberCount}</span>
	</Inline>
	{#if data.description}
		<p class="mt-0.5 truncate text-micro text-muted-foreground">{data.description}</p>
	{/if}
	<Handle
		type="source"
		position={Position.Bottom}
		class="!size-1.5 !border-0 !bg-border !opacity-0"
	/>
</button>
