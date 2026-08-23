<script lang="ts">
	import { cn, type WithElementRef, type WithoutChildren } from '#lib/utils';
	import { Stack } from '#lib/layout';
	import { getChartContext, Tooltip as TooltipPrimitive, type Tooltip } from 'layerchart';
	import type { Snippet } from 'svelte';
	import type { HTMLAttributes } from 'svelte/elements';
	import { getPayloadConfigFromPayload, useChart } from '#lib/chart/chart-utils';

	function defaultFormatter(value: string | number, _payload: Tooltip.TooltipSeries[]) {
		return `${value}`;
	}

	let {
		ref = $bindable(null),
		class: className,
		hideLabel = false,
		indicator = 'dot',
		hideIndicator = false,
		labelKey,
		label,
		labelFormatter = defaultFormatter,
		labelClassName,
		formatter,
		nameKey,
		color,
		...restProps
	}: WithoutChildren<WithElementRef<HTMLAttributes<HTMLDivElement>>> & {
		hideLabel?: boolean;
		label?: string;
		indicator?: 'line' | 'dot' | 'dashed';
		nameKey?: string;
		labelKey?: string;
		hideIndicator?: boolean;
		labelClassName?: string;
		labelFormatter?:
			| ((value: string | number, payload: Tooltip.TooltipSeries[]) => string | number | Snippet)
			| null;
		formatter?: Snippet<
			[
				{
					value: unknown;
					name: string;
					item: Tooltip.TooltipSeries;
					index: number;
					payload: Tooltip.TooltipSeries[];
				}
			]
		>;
	} = $props();

	const chart = useChart();
	const chartCtx = getChartContext();

	const tooltipData = $derived(chartCtx.tooltip);

	const formattedLabel = $derived.by(() => {
		if (hideLabel || !tooltipData?.series?.length) return null;

		const [item] = tooltipData.series;
		const key = labelKey ?? item?.label ?? item?.key ?? 'value';

		const itemConfig = getPayloadConfigFromPayload(chart.config, item, key);

		const value =
			!labelKey && typeof label === 'string'
				? (chart.config[label as keyof typeof chart.config]?.label ?? label)
				: (itemConfig?.label ?? item.label);

		if (value === undefined) return null;
		if (!labelFormatter) return value;
		return labelFormatter(value, tooltipData.series);
	});

	const nestLabel = $derived(tooltipData.series.length === 1 && indicator !== 'dot');
</script>

{#snippet TooltipLabel()}
	{#if formattedLabel}
		<div class={cn('font-medium', labelClassName)}>
			{#if typeof formattedLabel === 'function'}
				{@render formattedLabel()}
			{:else}
				{formattedLabel}
			{/if}
		</div>
	{/if}
{/snippet}

<TooltipPrimitive.Root context={chartCtx} variant="none">
	<div
		class={cn(
			'grid min-w-[9rem] items-start gap-1.5 rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl',
			className
		)}
		{...restProps}
	>
		{#if !nestLabel}
			{@render TooltipLabel()}
		{/if}
		<Stack gap="xs">
			{#each tooltipData.series as item, i (item.key + i)}
				{@const key = `${nameKey || item.key || item.label || 'value'}`}
				{@const itemConfig = getPayloadConfigFromPayload(chart.config, item, key)}
				{@const indicatorColor = color || item.color}
				<div
					class={cn(
						'flex w-full flex-wrap items-stretch gap-2 [&>svg]:size-2.5 [&>svg]:text-muted-foreground',
						indicator === 'dot' && 'items-center'
					)}
				>
					{#if formatter && item.value !== undefined && item.label}
						{@render formatter({
							value: item.value,
							name: item.label,
							item,
							index: i,
							payload: tooltipData.series
						})}
					{:else}
						{#if itemConfig?.icon}
							<itemConfig.icon />
						{:else if !hideIndicator}
							<div
								style="--color-bg: {indicatorColor}; --color-border: {indicatorColor};"
								class={cn('shrink-0 rounded-[2px] border-(--color-border) bg-(--color-bg)', {
									'size-2.5': indicator === 'dot',
									'h-full w-1': indicator === 'line',
									'w-0 border-[1.5px] border-dashed bg-transparent': indicator === 'dashed',
									'my-0.5': nestLabel && indicator === 'dashed'
								})}
							></div>
						{/if}
						<div
							class={cn(
								'flex flex-1 shrink-0 justify-between leading-none',
								nestLabel ? 'items-end' : 'items-center'
							)}
						>
							<Stack gap="xs">
								{#if nestLabel}
									{@render TooltipLabel()}
								{/if}
								<span class="text-muted-foreground">
									{itemConfig?.label || item.label}
								</span>
							</Stack>
							{#if item.value !== undefined}
								<span class="font-mono font-medium text-foreground tabular-nums">
									{item.value.toLocaleString()}
								</span>
							{/if}
						</div>
					{/if}
				</div>
			{/each}
		</Stack>
	</div>
</TooltipPrimitive.Root>
