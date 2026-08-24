<script lang="ts">
	import { SvelteFlow } from '@xyflow/svelte';
	import '@xyflow/svelte/dist/style.css';
	import { Stack } from '@norbital-ai/ui/layout';
	import TenantMatrixNode from './tenant-matrix-node.svelte';
	import {
		buildMatrixFlow,
		buildTenantMatrix,
		type MatrixEntry
	} from '#lib/client/ui/studio/tenant-matrix.js';

	/**
	 * The tenant drawn as a Svelte Flow graph: one dashed lane carrying the environments the
	 * gateway routes to it.
	 *
	 * Every environment shares the same facilities, so no edges are drawn — a line from each box to
	 * a row of identical labels is a picture that repeats one fact per environment instead of
	 * saying it once. The shape and positions stay pure in `tenant-matrix.ts` where they can be
	 * asserted without a DOM.
	 */
	let {
		entries = [],
		commit = ''
	}: {
		entries?: ReadonlyArray<MatrixEntry>;
		commit?: string;
	} = $props();

	const matrix = $derived(buildTenantMatrix(entries, []));
	const flow = $derived(
		matrix.environments.length === 0
			? { nodes: [], edges: [] }
			: buildMatrixFlow(matrix, { commit })
	);
</script>

<Stack gap="sm" data-testid="operations-tenant-matrix">
	{#if matrix.environments.length === 0}
		<p class="text-meta">
			This tenant has no routed environment yet. Nothing has been built and promoted, so the gateway
			resolves no release for it.
		</p>
	{:else}
		<div class="h-64 overflow-hidden rounded-lg border border-border/70 bg-card/20">
			<SvelteFlow
				nodes={[...flow.nodes]}
				edges={[...flow.edges]}
				nodeTypes={{ lane: TenantMatrixNode, environment: TenantMatrixNode }}
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
</Stack>
