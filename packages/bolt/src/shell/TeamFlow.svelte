<!--
	The team hierarchy as a Svelte Flow graph (staging's `teams-flow`): one node per team (name, member avatars and count),
	one edge per parent → child; pan, zoom, fit view. A search keeps the matches and the teams above them. Selecting a node
	hands its id to the page, which opens that team. Colours are the theme's tokens, so dark mode follows the shell.
-->
<script lang="ts">
	import { Background, Controls, SvelteFlow, type Edge, type Node } from '@xyflow/svelte';
	import '@xyflow/svelte/dist/style.css';
	import { Input } from '@norbital-ai/ui';
	import { Bound } from '@norbital-ai/ui/layout';
	import TeamNodeView from './TeamNode.svelte';
	import { layoutTeams, searchTeams, type TeamNode } from './teams.ts';

	let { teams, members, selected = null, onSelect, t }: {
		teams: readonly TeamNode[]; members: readonly { name: string; team: string | null }[]; selected?: string | null;
		onSelect: (id: string) => void; t: (key: string) => string;
	} = $props();

	let query = $state('');
	const shown = $derived(searchTeams(teams, query));
	const chart = $derived(layoutTeams(shown));
	const byTeam = $derived(Map.groupBy(members, (m) => m.team ?? ''));
	const nodes = $derived(chart.positions.map((p): Node => {
		const team = shown.find((x) => x.id === p.id)!, in_ = byTeam.get(p.id) ?? [];
		return { id: p.id, type: 'team', position: { x: p.x, y: p.y }, draggable: false, connectable: false,
			data: { name: team.name, members: in_.slice(0, 5).map((m) => m.name), count: in_.length, selected: p.id === selected, none: t('No members') } };
	}));
	const edges = $derived(chart.edges.map((e): Edge => ({ id: `${e.parent}->${e.child}`, source: e.parent, target: e.child, type: 'smoothstep' })));
	// xyflow's own variables, set to the theme's tokens (light and dark alike)
	const THEME = ['--xy-background-color: transparent', '--xy-background-pattern-dots-color: var(--color-border)', '--xy-edge-stroke: var(--color-muted-foreground)',
		'--xy-edge-stroke-selected: var(--color-foreground)', '--xy-controls-button-background-color: var(--color-card)', '--xy-controls-button-background-color-hover: var(--color-muted)',
		'--xy-controls-button-color: var(--color-foreground)', '--xy-controls-button-color-hover: var(--color-foreground)', '--xy-controls-button-border-color: var(--color-border)',
		'--xy-controls-box-shadow: none', '--xy-attribution-background-color: transparent'].join(';');
</script>

<div class="flex min-w-0 flex-col gap-2">
	<Input class="h-8 max-w-sm" type="search" placeholder={t('Search teams')} aria-label={t('Search teams')} bind:value={query} />
	<Bound size="fit" clip class="rounded-md border bg-card" style={THEME} aria-label={t('Team hierarchy')} role="region">
		{#if teams.length === 0}
			<p class="grid h-full place-items-center p-6 text-sm text-muted-foreground">{t('No teams yet.')}</p>
		{:else if shown.length === 0}
			<p class="grid h-full place-items-center p-6 text-sm text-muted-foreground">{t('No teams match this search.')}</p>
		{:else}
			<SvelteFlow {nodes} {edges} nodeTypes={{ team: TeamNodeView }} fitView fitViewOptions={{ padding: 0.2 }} minZoom={0.2}
				nodesDraggable={false} nodesConnectable={false} proOptions={{ hideAttribution: true }} onnodeclick={({ node }) => onSelect(node.id)}>
				<Background />
				<Controls showLock={false} />
			</SvelteFlow>
		{/if}
	</Bound>
</div>
