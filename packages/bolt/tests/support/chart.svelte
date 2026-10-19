<script lang="ts">
	import { provideBolt } from '../../../ui/src/client/context.js';
	import { type ViewBolt } from '../../../ui/src/client/contract.js';
	import Chart, { type ChartProps } from '../../../ui/src/chart/Chart.svelte';

	let { kind, bolt }: { kind: ChartProps['kind']; bolt: ViewBolt } = $props();
	// svelte-ignore state_referenced_locally
	provideBolt(bolt);
</script>

<div class="fixture" style="width: 358px">
	<Chart
		of={[
			{ day: '2026-10-01', price: 30 },
			{ day: '2026-10-13', price: 31 }
		]}
		x="day"
		y="price"
		{kind}
	/>
</div>

<style>
	/* Component tests use the chart's normal container without a workspace Tailwind build. */
	.fixture :global([data-view='chart'] > div) {
		height: 288px;
		overflow-x: auto;
	}
</style>
