<script lang="ts">
	import type {
		ChartConfig as UIChartConfig,
		ChartDisplaySpec,
		ChartDisplayValueFormat
	} from './chart-utils.js';
	import ChartContainer from './chart-container.svelte';
	import ChartSkeleton from './chart-skeleton.svelte';
	import ChartTooltip from './chart-tooltip.svelte';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { Cluster, Inline, Scroll, Stack } from '#lib/layout';
	import { AreaChart, BarChart, LineChart, PieChart } from 'layerchart';

	const { t } = useI18n<UiKeys>();

	interface Props {
		spec: ChartDisplaySpec;
		class?: string;
	}

	let { spec, class: className = '' }: Props = $props();

	const isDonutChartSpec = (
		value: ChartDisplaySpec
	): value is Extract<ChartDisplaySpec, { kind: 'donut' }> => value.kind === 'donut';
	const isCartesianChartSpec = (
		value: ChartDisplaySpec
	): value is Extract<ChartDisplaySpec, { kind: 'bar' | 'line' | 'area' }> =>
		value.kind !== 'donut';

	const DEFAULT_CHART_COLORS = [
		'var(--chart-1, #2563eb)',
		'var(--chart-2, #60a5fa)',
		'var(--chart-3, #0f766e)',
		'var(--chart-4, #84cc16)',
		'var(--chart-5, #f59e0b)'
	] as const;

	const getSeriesColor = (
		index: number,
		entry: ChartDisplaySpec['config'][string] | undefined
	): string => entry?.color ?? DEFAULT_CHART_COLORS[index % DEFAULT_CHART_COLORS.length];

	const formatChartValue = (
		value: number,
		valueFormat: ChartDisplayValueFormat | undefined
	): string => {
		if (!valueFormat) return value.toLocaleString();

		const { style, ...rest } = valueFormat;
		const formatter =
			style === 'number'
				? new Intl.NumberFormat(undefined, rest)
				: new Intl.NumberFormat(undefined, {
						style,
						...rest
					});
		return formatter.format(value);
	};

	const chartKeys = $derived.by(() =>
		isDonutChartSpec(spec) ? spec.data.map((entry) => entry.key) : spec.series
	);
	const chartConfig = $derived.by<UIChartConfig>(() =>
		Object.fromEntries(
			chartKeys.map((key, index) => [
				key,
				{
					label: spec.config[key]?.label ?? key,
					color: getSeriesColor(index, spec.config[key])
				}
			])
		)
	);
	const showGrid = $derived(spec.showGrid ?? !isDonutChartSpec(spec));
	const cartesianChartWidth = $derived.by(() => {
		if (!isCartesianChartSpec(spec)) return 0;
		const pointWidth = spec.kind === 'bar' ? 48 + spec.series.length * 18 : 72;
		return Math.min(2400, Math.max(320, spec.data.length * pointWidth));
	});
	const formatAxisLabel = (value: unknown): string => {
		if (value == null) return '';

		const label = String(value);
		return label.length > 18 ? `${label.slice(0, 15)}...` : label;
	};

	const formatYAxisLabel = (value: unknown): string => {
		if (typeof value !== 'number') return String(value ?? '');
		return formatChartValue(value, spec.valueFormat);
	};
</script>

{#snippet tooltip()}
	<ChartTooltip hideLabel />
{/snippet}
<Stack gap="md" fill class={`dynamic-ui-chart-display ${className}`}>
	{#if spec.title || spec.description}
		<div class="shrink-0">
			{#if spec.title}
				<h3 class="text-sm font-semibold tracking-tight text-foreground">{spec.title}</h3>
			{/if}
			{#if spec.description}
				<p class="mt-1 text-xs text-muted-foreground">{spec.description}</p>
			{/if}
		</div>
	{/if}

	{#if spec.loading}
		<div
			class="flex h-[250px] items-center justify-center"
			aria-busy="true"
			aria-label={t('misc.chartLoading')}
		>
			<ChartSkeleton donut={isDonutChartSpec(spec)} />
		</div>
	{:else if spec.data.length === 0}
		<div
			class="flex h-[250px] items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground"
		>
			{t('misc.chartNoData')}
		</div>
	{:else if isDonutChartSpec(spec)}
		{@const data = spec.data.map((entry, index) => ({
			key: entry.key,
			label: chartConfig[entry.key]?.label ?? entry.key,
			value: entry.value,
			color: chartConfig[entry.key]?.color ?? getSeriesColor(index, spec.config[entry.key])
		}))}
		<Stack gap="none" grow>
			<div class="flex min-h-0 flex-1 items-center justify-center">
				<ChartContainer
					config={chartConfig}
					class="aspect-square h-full max-h-[180px] w-full max-w-[180px]"
				>
					<PieChart
						{data}
						key="key"
						label="label"
						value="value"
						c="key"
						cRange={data.map((entry) => entry.color)}
						innerRadius={spec.innerRadius ?? 0.68}
						padAngle={0.015}
						cornerRadius={6}
						legend={false}
						props={{
							pie: {
								motion: 'tween'
							}
						}}
						{tooltip}
					/>
				</ChartContainer>
			</div>
			<Cluster
				gap="sm"
				align="center"
				justify="center"
				shrink={false}
				class="text-xs text-muted-foreground"
			>
				{#each data as entry (entry.key)}
					<Inline gap="sm">
						<span
							class="inline-block h-2.5 w-2.5 rounded-[3px]"
							style={`background-color: ${entry.color};`}
						></span>
						<span>{entry.label}</span>
					</Inline>
				{/each}
			</Cluster>
		</Stack>
	{:else if isCartesianChartSpec(spec)}
		{@const series = spec.series.map((key, index) => ({
			key,
			label: chartConfig[key]?.label ?? key,
			value: key,
			color: chartConfig[key]?.color ?? getSeriesColor(index, spec.config[key])
		}))}
		<Scroll axis="x" name={t('misc.chartScrollable', { title: spec.title ?? t('misc.dataChart') })} class="max-">
			<ChartContainer
				config={chartConfig}
				class="h-[clamp(14rem,45dvh,18rem)] min-w-full"
				style={`width: max(100%, ${cartesianChartWidth}px);`}
			>
				{#if spec.kind === 'bar'}
					<BarChart
						data={spec.data}
						x={spec.xKey}
						axis="x"
						grid={showGrid}
						rule={showGrid}
						legend={true}
						{tooltip}
						{series}
						seriesLayout={spec.stacked ? 'stack' : 'group'}
						props={{
							bars: {
								strokeWidth: 0
							},
							xAxis: {
								format: formatAxisLabel
							},
							yAxis: {
								format: formatYAxisLabel
							}
						}}
					/>
				{:else if spec.kind === 'line'}
					<LineChart
						data={spec.data}
						x={spec.xKey}
						axis="x"
						grid={showGrid}
						rule={showGrid}
						legend={true}
						{tooltip}
						points={false}
						{series}
						seriesLayout={spec.stacked ? 'stack' : 'overlap'}
						props={{
							xAxis: {
								format: formatAxisLabel
							},
							yAxis: {
								format: formatYAxisLabel
							}
						}}
					/>
				{:else}
					<AreaChart
						data={spec.data}
						x={spec.xKey}
						axis="x"
						grid={showGrid}
						rule={showGrid}
						legend={true}
						{tooltip}
						points={false}
						{series}
						seriesLayout={spec.stacked ? 'stack' : 'overlap'}
						props={{
							xAxis: {
								format: formatAxisLabel
							},
							yAxis: {
								format: formatYAxisLabel
							}
						}}
					/>
				{/if}
			</ChartContainer>
		</Scroll>
	{/if}
</Stack>

<style>
	:global(.dynamic-ui-chart-display .lc-layout-svg-g) {
		fill: initial !important;
	}
</style>
