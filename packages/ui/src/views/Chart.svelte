<!--
@component
A bar, line, area or donut chart over an aggregate, a read, a collection query or rows: `x` names the category, `y` the
numbers (`count`, `sum.amount`).
@example
<Chart of={bolt.aggregate('jobs', { count: true, by: 'status', limit: 20 })} x="status" y="count" kind="bar" />
-->
<script lang="ts" module>
	import type { ViewSource } from './source.svelte.js';
	/** `of` is an aggregate, a read, a collection query or rows; `y` names numbers (`count`, `sum.amount`). */
	export type ChartProps = { of: ViewSource; x: string; y: string | readonly string[]; kind?: 'bar' | 'line' | 'area' | 'donut'; stack?: boolean; title?: string; every?: string };
</script>

<script lang="ts">
	import { AreaChart, BarChart, LineChart, PieChart } from 'layerchart';
	import { useBolt } from './bolt.js';
	import { humanize, msg, series } from './model.js';
	import ReadGate from './ReadGate.svelte';
	import { readSource } from './source.svelte.js';

	let { of, x, y, kind = 'bar', stack = false, title, every }: ChartProps = $props();
	const bolt = useBolt();
	const ys = $derived(typeof y === 'string' ? [y] : [...y]);
	const read = readSource(bolt, () => of, () => every);
	const COLORS = ['var(--chart-1, #2563eb)', 'var(--chart-2, #60a5fa)', 'var(--chart-3, #0f766e)', 'var(--chart-4, #84cc16)', 'var(--chart-5, #f59e0b)'];
	const lines = $derived(ys.map((key, i) => ({ key, label: humanize(key), value: key, color: COLORS[i % COLORS.length]! })));
</script>

<figure class="flex min-w-0 flex-col gap-2" data-view="chart">
	{#if title}<figcaption class="text-sm font-semibold">{title}</figcaption>{/if}
	<ReadGate state={read.state} what={title ?? msg(bolt, 'chart.data', 'this chart')}>
		{#snippet children(value)}
			{@const data = series(value, x, ys)}
			{#if data.length === 0}
				<p class="text-muted-foreground rounded-md border border-dashed p-4 text-sm" data-read="empty">{msg(bolt, 'chart.empty', 'No data')}</p>
			{:else if kind === 'donut'}
				<div class="h-56"><PieChart data={data.map((d) => ({ key: String(d[x]), value: Number(d[ys[0]!] ?? 0) }))} key="key" value="value" label="key" innerRadius={0.68} /></div>
			{:else}
				<div class="h-72 min-w-0 overflow-x-auto">
					{#if kind === 'bar'}<BarChart {data} {x} series={lines} seriesLayout={stack ? 'stack' : 'group'} legend />
					{:else if kind === 'line'}<LineChart {data} {x} series={lines} legend />
					{:else}<AreaChart {data} {x} series={lines} seriesLayout={stack ? 'stack' : 'overlap'} legend />{/if}
				</div>
			{/if}
		{/snippet}
	</ReadGate>
</figure>
