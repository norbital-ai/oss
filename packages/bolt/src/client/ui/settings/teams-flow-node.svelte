<script lang="ts">
	import { Handle, Position, type Node, type NodeProps } from '@xyflow/svelte';
	import { Stack } from '@norbital-ai/ui/layout';

	type TeamFlowData = Readonly<{
		readonly name: string;
	}>;

	type TeamFlowNode = Node<TeamFlowData, 'team'>;

	/** One team on the hierarchy flow: a plain card carrying the team's name. */
	let { data }: NodeProps<TeamFlowNode> = $props();
</script>

<Stack gap="xs" class="min-w-40 rounded-md border border-border bg-card px-3 py-2 shadow-card">
	<span class="text-xs font-semibold text-foreground">{data.name}</span>
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
</Stack>
