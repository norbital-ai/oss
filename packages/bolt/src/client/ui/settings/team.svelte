<script lang="ts">
	import { Scroll, Stack } from '@norbital-ai/ui/layout';
	import { layoutTeamHierarchy, type TeamNode } from './team-hierarchy.js';

	let {
		teams = [],
		busy = false
	}: {
		teams?: ReadonlyArray<TeamNode>;
		busy?: boolean;
	} = $props();

	const NODE_WIDTH = 200;
	const NODE_HEIGHT = 56;
	const PADDING = 24;
	const chart = $derived(layoutTeamHierarchy(teams));
	const byId = $derived(new Map(chart.positions.map((position) => [position.id, position])));
	const nameById = $derived(new Map(teams.map((team) => [team.id, team.name])));
</script>

<Stack as="section" gap="md" aria-busy={busy}>
	<Stack as="header" gap="xs">
		<h2 class="text-lg font-semibold">Teams</h2>
		<p class="text-sm text-muted-foreground">How the teams in this workspace nest.</p>
	</Stack>
	{#if chart.positions.length === 0}
		<div class="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
			No teams configured.
		</div>
	{:else}
		<!-- Named distinctly from the chart's own `aria-label`, so the reel and the image are two
		     regions rather than two things claiming the same name. -->
		<Scroll axis="x" name="Team chart" class="rounded-lg border bg-card p-4">
			<svg
				role="img"
				aria-label="Team hierarchy"
				width={chart.width + NODE_WIDTH + PADDING * 2}
				height={chart.height + NODE_HEIGHT + PADDING * 2}
			>
				{#each chart.edges as edge (`${edge.parentId}->${edge.childId}`)}
					{@const parent = byId.get(edge.parentId)}
					{@const child = byId.get(edge.childId)}
					{#if parent && child}
						<line
							x1={parent.x + NODE_WIDTH / 2 + PADDING}
							y1={parent.y + NODE_HEIGHT + PADDING}
							x2={child.x + NODE_WIDTH / 2 + PADDING}
							y2={child.y + PADDING}
							stroke="var(--border)"
							stroke-width="1"
						/>
					{/if}
				{/each}
				{#each chart.positions as position (position.id)}
					<g transform={`translate(${position.x + PADDING}, ${position.y + PADDING})`}>
						<rect
							width={NODE_WIDTH}
							height={NODE_HEIGHT}
							rx="8"
							fill="var(--card)"
							stroke="var(--border)"
						/>
						<text
							x={NODE_WIDTH / 2}
							y={NODE_HEIGHT / 2 + 4}
							text-anchor="middle"
							fill="var(--foreground)"
							font-size="13">{nameById.get(position.id) ?? position.id}</text
						>
					</g>
				{/each}
			</svg>
		</Scroll>
	{/if}
</Stack>
