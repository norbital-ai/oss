<script lang="ts">
	import { SvelteFlow } from '@xyflow/svelte';
	import type { Edge, Node } from '@xyflow/svelte';
	import '@xyflow/svelte/dist/style.css';
	import { layoutTeamHierarchy, type TeamNode } from './team-hierarchy.js';
	import TeamFlowNode from './teams-flow-node.svelte';

	/**
	 * The team hierarchy drawn as a Svelte Flow graph: one node per team, one edge per
	 * parent-child nesting.
	 *
	 * The geometry is the pure layout from `team-hierarchy.ts` — a parent sits over the midpoint of
	 * its own subtree — and every node is read-only: the chart shows how the teams nest, it is not a
	 * surface to rearrange.
	 */
	let {
		teams = []
	}: {
		teams?: ReadonlyArray<TeamNode>;
	} = $props();

	type TeamFlowData = Readonly<{
		readonly name: string;
	}>;

	const chart = $derived(layoutTeamHierarchy(teams));
	const nodes = $derived(
		chart.positions.map((position): Node<TeamFlowData, 'team'> => {
			const team = teams.find((candidate) => candidate.id === position.id);
			return {
				id: position.id,
				type: 'team',
				position: { x: position.x, y: position.y },
				draggable: false,
				selectable: false,
				connectable: false,
				data: { name: team?.name ?? position.id }
			};
		})
	);
	const edges = $derived(
		chart.edges.map(
			(edge): Edge => ({
				id: `${edge.parentId}->${edge.childId}`,
				source: edge.parentId,
				target: edge.childId,
				type: 'smoothstep',
				style: 'stroke: var(--muted-foreground)'
			})
		)
	);
</script>

{#if teams.length === 0}
	<div class="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
		No teams configured.
	</div>
{:else}
	<div class="h-72 overflow-hidden rounded-lg border border-border/70 bg-card/20">
		<SvelteFlow
			nodes={[...nodes]}
			edges={[...edges]}
			nodeTypes={{ team: TeamFlowNode }}
			fitView
			fitViewOptions={{ padding: 0.1 }}
			nodesDraggable={false}
			nodesConnectable={false}
			elementsSelectable={false}
			panOnDrag={false}
			zoomOnScroll={false}
			zoomOnPinch={false}
			proOptions={{ hideAttribution: true }}
		/>
	</div>
{/if}
