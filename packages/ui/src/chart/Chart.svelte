<!--
@component
A bar, line, area or donut chart over a model (bucketed by `x`), an aggregate's buckets, a declared query's rows or rows,
live while shown: `x` names the category, `y` the numbers (`count`, `sum.amount`). It fills its parent, down to 18rem.
@example
<Chart {ctx} of="jobs" x="status" y="count" kind="bar" />
-->
<script lang="ts" module>
	import type { Json, UiContext } from '../client/contract.js';
	import type { ModelKey } from '../model/types.js';
	import type { ViewSource } from '../read/source.js';
	/** `of` is a model, an aggregate's page of buckets, a declared query's rows or page, or rows; `y` names numbers (`count`, `sum.amount`). */
	type ChartProps = {
		/** The page context (`ctx`), passed whole. */
		ctx: UiContext;
		/**
		 * The data: a model (one aggregate bucketed by `x`, measuring each `y`), an aggregate's buckets, a declared query's
		 * rows or page, or rows; re-read live while shown.
		 */
		of: ModelKey | ViewSource;
		/** A model's scope: only its rows are measured. */
		where?: Json;
		/** The category field: one bar, point or slice per value. */
		x: string;
		/** The numeric field, or several as series in palette order; a donut plots only the first. */
		y: string | readonly string[];
		/** The chart type. Default `'bar'`. */
		kind?: 'bar' | 'line' | 'area' | 'donut' | 'scatter';
		/** Hold each value until the next x position. Applies to line charts. */
		interpolation?: 'linear' | 'step';
		/** Bar charts only: `'horizontal'` lays categories down the side. Default `'vertical'`. */
		orientation?: 'horizontal' | 'vertical';
		/** Bar and area charts: stack the `y` series instead of grouping (bars) or overlapping (areas). Default false. */
		stack?: boolean;
		/** A caption above the chart; also names the data in loading and error states. */
		title?: string;
	};
	/** A model chart's one aggregate: bucketed by `x`, a `count` and each `sum.f`/`avg.f`/`min.f`/`max.f` the series name. */
	const measures = (x: string, ys: readonly string[], where: Json | undefined) => {
		const by: Record<string, string[]> = {};
		for (const y of ys) {
			const dot = y.indexOf('.');
			if (dot > 0) (by[y.slice(0, dot)] ??= []).push(y.slice(dot + 1));
		}
		return { by: [x], count: true, ...by, ...(where === undefined ? {} : { where }) };
	};
</script>

<script lang="ts">
	import { curveStepAfter } from 'd3-shape';
	import { bolt_of } from '../client/context.js';
	import { humanize, msg } from '../text/messages.js';
	import { series } from './series.js';
	import ReadGate from '../read/ReadGate.svelte';
	import { sourceState } from '../read/source.js';

	let {
		ctx,
		of,
		where,
		x,
		y,
		kind = 'bar',
		interpolation = 'linear',
		orientation = 'vertical',
		stack = false,
		title
	}: ChartProps = $props();
	const bolt = $derived(bolt_of(ctx));
	// Bottom holds the x tick labels (32) and the legend beneath them (32).
	const numericPadding = { top: 12, right: 16, bottom: 64, left: 64 };
	// Band/point x scales show every category by default; thin them to one label per 80px like layerchart's continuous axes.
	const xAxis = { tickSpacing: 80 };
	let plotWidth = $state(Infinity);
	const ys = $derived(typeof y === 'string' ? [y] : [...y]);
	const read = $derived(
		sourceState(typeof of === 'string' ? bolt.aggregate(of, measures(x, ys, where)) : of)
	);
	const loadPlots = () => import('./plots.js');
	const COLORS = [
		'var(--chart-1, #2563eb)',
		'var(--chart-2, #60a5fa)',
		'var(--chart-3, #0f766e)',
		'var(--chart-4, #84cc16)',
		'var(--chart-5, #f59e0b)'
	];
	const lines = $derived(
		ys.map((key, i) => {
			const color = COLORS[i % COLORS.length];
			if (color === undefined) throw new Error('The chart series has no palette color.');
			return { key, label: humanize(key), value: key, color };
		})
	);
</script>

<figure class="flex h-full min-h-72 min-w-0 flex-1 flex-col gap-2" data-view="chart">
	{#if title}<figcaption class="text-sm font-semibold">{title}</figcaption>{/if}
	<ReadGate {ctx} state={read} what={title ?? msg(bolt, 'chart.data')}>
		{#snippet children(value)}
			{@const data = series(value, x, ys)}
			{@const first_y = ys[0]}
			{#if data.length === 0}
				<p
					class="text-muted-foreground rounded-md border border-dashed p-4 text-sm"
					data-read="empty"
				>
					{msg(bolt, 'chart.empty')}
				</p>
			{:else}
				{#await loadPlots()}
					<div class="min-h-0 flex-1" aria-busy="true"></div>
				{:then { AreaChart, BarChart, LineChart, PieChart, ScatterChart }}
					{#if kind === 'donut'}
						<div class="min-h-0 flex-1">
							<PieChart
								data={data.map((d) => ({ key: String(d[x]), value: first_y === undefined ? 0 : Number(d[first_y] ?? 0) }))}
								key="key"
								value="value"
								label="key"
								innerRadius={0.68}
							/>
						</div>
					{:else}
						<div class="min-h-0 min-w-0 flex-1 overflow-x-auto" bind:clientWidth={plotWidth}>
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
													plotWidth * 0.4,
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
				{:catch}
					<p class="text-muted-foreground rounded-md border border-dashed p-4 text-sm" role="alert">
						{msg(bolt, 'chart.unavailable')}
					</p>
				{/await}
			{/if}
		{/snippet}
	</ReadGate>
</figure>
