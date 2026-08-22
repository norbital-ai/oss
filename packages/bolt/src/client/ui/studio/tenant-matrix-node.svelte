<script lang="ts">
	import { Handle, Position, type Node, type NodeProps } from '@xyflow/svelte';
	import { Bound, Inline, Stack } from '@norbital-ai/ui/layout';
	import type { MatrixNodeData, MatrixNodeKind } from '#lib/client/ui/studio/tenant-matrix.js';

	type MatrixFlowNode = Node<MatrixNodeData, MatrixNodeKind>;

	/**
	 * One box on the tenant matrix: a dashed lane, a routed environment, or a shared facility.
	 *
	 * Svelte Flow wraps this for position and connectors. The card itself is ordinary layout so the
	 * same facts stay readable when the graph is not interactive — SSR, a screen reader, or a
	 * poll that only changed a status chip.
	 */
	let { type, data }: NodeProps<MatrixFlowNode> = $props();

	const isLane = $derived(type === 'lane' || data.kind === 'lane');
</script>

{#if isLane}
	<Stack gap="xs" fill class="rounded-lg border border-dashed border-border/80 bg-muted/25 p-2">
		<span class="text-micro text-muted-foreground">{data.title}</span>
	</Stack>
	<Handle
		type="source"
		position={Position.Bottom}
		class="!h-px !w-px !border-0 !bg-transparent !opacity-0"
	/>
	<Handle
		type="target"
		position={Position.Top}
		class="!h-px !w-px !border-0 !bg-transparent !opacity-0"
	/>
{:else}
	<Bound
		size="full"
		clip
		pad="sm"
		class={[
			'rounded-md border bg-card shadow-card',
			data.healthy ? 'border-border' : 'border-amber-500/70'
		]}
	>
		<Stack gap="xs" fill>
			<Inline justify="between" align="center" gap="sm">
				<span class="min-w-0 truncate text-xs font-semibold text-foreground">{data.title}</span>
				<span
					class={[
						'shrink-0',
						data.healthy ? 'text-micro text-muted-foreground' : 'text-micro text-amber-500'
					]}
				>
					{data.status}
				</span>
			</Inline>
			{#each data.rows as row (row.label)}
				<Inline justify="between" align="center" gap="sm">
					<span class="shrink-0 text-micro text-muted-foreground">{row.label}</span>
					<span
						class="min-w-0 truncate text-right font-mono text-micro text-foreground"
						title={row.title ?? row.value}
					>
						{row.value}
					</span>
				</Inline>
			{/each}
		</Stack>
	</Bound>
{/if}
