<!--
@component
A bar, line, area or donut chart over an aggregate, a query, a declared query or rows, live while shown: `x` names the category, `y` the
numbers (`count`, `sum.amount`).
@example
<Chart of={bolt.aggregate('jobs', { count: true, by: 'status', limit: 20 })} x="status" y="count" kind="bar" />
-->
<script lang="ts" module>
	import type { ViewSource } from '../read/source.js';
	/** `of` is an aggregate, a query, a declared query or rows; `y` names numbers (`count`, `sum.amount`). */
	export type ChartProps = {
		of: ViewSource;
		x: string;
		y: string | readonly string[];
		kind?: 'bar' | 'line' | 'area' | 'donut' | 'scatter';
		/** Hold each value until the next x position. Applies to line charts. */
		interpolation?: 'linear' | 'step';
		orientation?: 'horizontal' | 'vertical';
		stack?: boolean;
		title?: string;
	};
</script>

<script lang="ts">
	import { curveStepAfter } from 'd3-shape';
	import { AreaChart, BarChart, LineChart, PieChart, ScatterChart } from 'layerchart';
	import { useBolt } from '../client/context.js';
	import { humanize, msg } from '../text/messages.js';
	import { series } from './series.js';
	import ReadGate from '../read/ReadGate.svelte';
	import { sourceState } from '../read/source.js';

	let {
		of,
		x,
		y,
		kind = 'bar',
		interpolation = 'linear',
		orientation = 'vertical',
		stack = false,
		title
	}: ChartProps = $props();
	const bolt = useBolt();
	// Bottom holds the x tick labels (32) and the legend beneath them (32).
	const numericPadding = { top: 12, right: 16, bottom: 64, left: 64 };
	// Band/point x scales show every category by default; thin them to one label per 80px like layerchart's continuous axes.
	const xAxis = { tickSpacing: 80 };
	const ys = $derived(typeof y === 'string' ? [y] : [...y]);
	const state = $derived(sourceState(of));
	const COLORS = [
		'var(--chart-1, #2563eb)',
		'var(--chart-2, #60a5fa)',
		'var(--chart-3, #0f766e)',
		'var(--chart-4, #84cc16)',
		'var(--chart-5, #f59e0b)'
	];
	const lines = $derived(
		ys.map((key, i) => ({
			key,
			label: humanize(key),
			value: key,
			color: COLORS[i % COLORS.length]!
		}))
	);
</script>

<figure class="flex min-w-0 flex-col gap-2" data-view="chart">
	{#if title}<figcaption class="text-sm font-semibold">{title}</figcaption>{/if}
	<ReadGate {state} what={title ?? msg(bolt, 'chart.data', 'this chart')}>
		{#snippet children(value)}
			{@const data = series(value, x, ys)}
			{#if data.length === 0}
				<p
					class="text-muted-foreground rounded-md border border-dashed p-4 text-sm"
					data-read="empty"
				>
					{msg(bolt, 'chart.empty', 'No data')}
				</p>
			{:else if kind === 'donut'}
				<div class="h-56">
					<PieChart
						data={data.map((d) => ({ key: String(d[x]), value: Number(d[ys[0]!] ?? 0) }))}
						key="key"
						value="value"
						label="key"
						innerRadius={0.68}
					/>
				</div>
			{:else}
				<div class="h-72 min-w-0 overflow-x-auto">
					{#if kind === 'scatter'}<ScatterChart
							{data}
							{x}
							padding={numericPadding}
							series={lines}
							props={{ xAxis }}
							legend
						/>
					{:else if kind === 'bar'}<BarChart
							{data}
							x={orientation === 'horizontal' ? undefined : x}
							y={orientation === 'horizontal' ? x : undefined}
							{orientation}
							padding={orientation === 'horizontal'
								? {
										bottom: 64,
										top: 12,
										right: 12,
										left: Math.min(
											320,
											Math.max(80, ...data.map((row) => String(row[x] ?? '').length * 7 + 16))
										)
									}
								: numericPadding}
							series={lines}
							seriesLayout={stack ? 'stack' : 'group'}
							props={{ xAxis }}
							legend
						/>
					{:else if kind === 'line'}<LineChart
							{data}
							{x}
							padding={numericPadding}
							series={lines}
							props={{
								xAxis,
								spline: { curve: interpolation === 'step' ? curveStepAfter : undefined }
							}}
							legend
						/>
					{:else}<AreaChart
							{data}
							{x}
							padding={numericPadding}
							series={lines}
							seriesLayout={stack ? 'stack' : 'overlap'}
							props={{ xAxis }}
							legend
						/>{/if}
				</div>
			{/if}
		{/snippet}
	</ReadGate>
</figure>
