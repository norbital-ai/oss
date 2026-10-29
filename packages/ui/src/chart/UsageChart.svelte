<!--
	One metric's trend over time as an inline SVG line chart: the first line is the use, dashed lines are what bounds it
	(a capacity, a machine's total). Hovering reads every line at that time.
-->
<script lang="ts" module>
	export type UsageChartLine = Readonly<{
		label: string;
		bound: boolean;
		points: ReadonlyArray<Readonly<{ at: number; value: number | null }>>;
	}>;

	export type UsageChartProps = {
		title: string;
		unit: string;
		lines: ReadonlyArray<UsageChartLine>;
		utilization?: number | null;
	};

	const peakValue = (values: ReadonlyArray<number | null>): number | null => {
		const known = values.filter((value) => value !== null);
		return known.length === 0 ? null : Math.max(...known);
	};
	const BYTES = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
	/** A reading in its unit, for people. */
	export function formatMetricValue(unit: string, value: number | null): string {
		if (value === null) return 'Unavailable';
		if (unit === 'bytes' || unit === 'MiB') {
			let scaled = unit === 'MiB' ? value * 1024 * 1024 : value,
				step = 0;
			while (scaled >= 1024 && step < BYTES.length - 1) {
				scaled /= 1024;
				step++;
			}
			return `${scaled.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${BYTES[step]}`;
		}
		if (unit === 'micro-SGD')
			return new Intl.NumberFormat('en-SG', { style: 'currency', currency: 'SGD' }).format(
				value / 1_000_000
			);
		if (unit === 'seconds')
			return value >= 3600
				? `${(value / 3600).toLocaleString(undefined, { maximumFractionDigits: 1 })} h`
				: `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })} s`;
		if (unit === 'load per core') return `${Math.round(value * 100)}%`;
		return `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${unit}`;
	}
</script>

<script lang="ts">
	let { title, unit, lines, utilization = null }: UsageChartProps = $props();
	const W = 600,
		H = 160;
	// the use is the brand line; its bounds take the chart palette after it
	const COLORS = [
		'var(--brand)',
		'var(--chart-2)',
		'var(--chart-3)',
		'var(--chart-4)',
		'var(--chart-5)'
	];
	const length = $derived(Math.max(0, ...lines.map((line) => line.points.length)));
	const maximum = $derived(peakValue(lines.flatMap((line) => line.points.map((p) => p.value))));
	const top = $derived((maximum ?? 0) * 1.1 || 1);
	const x = (i: number) => (length <= 1 ? 0 : (i / (length - 1)) * W);
	const y = (value: number) => H - (value / top) * H;
	const path = (line: UsageChartLine) =>
		line.points
			.map((p, i) =>
				p.value === null
					? ''
					: `${i === 0 || line.points[i - 1]?.value === null ? 'M' : 'L'}${x(i)},${y(p.value)}`
			)
			.join(' ');
	const first = $derived(lines[0]?.points[0]?.at),
		last = $derived(lines[0]?.points.at(-1)?.at);
	let hover = $state<number | null>(null);
	const at = $derived(hover === null ? null : lines[0]?.points[hover]?.at);
	function move(event: PointerEvent & { currentTarget: SVGSVGElement }) {
		const box = event.currentTarget.getBoundingClientRect();
		hover = Math.round(((event.clientX - box.left) / box.width) * Math.max(0, length - 1));
	}
	const when = (millis: number) =>
		new Date(millis).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
</script>

<figure class="grid min-w-0 gap-2 rounded-md border border-border p-3 text-xs">
	<figcaption class="flex flex-wrap items-baseline justify-between gap-2">
		<span class="text-xs font-medium">{title}</span>
		<span class="text-meta">
			{#if utilization !== null}peak {Math.round(utilization * 100)}% of capacity{:else}peak {formatMetricValue(
					unit,
					peakValue(lines[0]?.points.map((p) => p.value) ?? [])
				)}{/if}
		</span>
	</figcaption>
	<svg
		viewBox={`0 0 ${W} ${H}`}
		preserveAspectRatio="none"
		class="h-32 w-full touch-pan-y"
		role="img"
		aria-label={`${title} over time`}
		onpointermove={move}
		onpointerleave={() => (hover = null)}
	>
		<line x1="0" x2={W} y1={H} y2={H} class="stroke-border" vector-effect="non-scaling-stroke" />
		{#each lines as line, i (line.label)}
			<path
				d={path(line)}
				fill="none"
				stroke={COLORS[i % COLORS.length]}
				stroke-width="1.5"
				stroke-dasharray={line.bound ? '4 3' : undefined}
				vector-effect="non-scaling-stroke"
			/>
		{/each}
		{#if hover !== null}
			<line
				x1={x(hover)}
				x2={x(hover)}
				y1="0"
				y2={H}
				class="stroke-muted-foreground"
				vector-effect="non-scaling-stroke"
			/>
		{/if}
	</svg>
	<div class="text-meta flex flex-wrap justify-between gap-x-3 gap-y-1 tabular-nums">
		<span>{first === undefined ? '' : when(first)}</span>
		<span>max {formatMetricValue(unit, maximum)}</span>
		<span>{last === undefined ? '' : when(last)}</span>
	</div>
	<ul class="flex flex-wrap gap-x-4 gap-y-1 text-xs">
		{#each lines as line, i (line.label)}
			<li class="flex items-center gap-1.5">
				<span
					class="inline-block h-0.5 w-4"
					style:background={COLORS[i % COLORS.length]}
					style:opacity={line.bound ? 0.6 : 1}
				></span>
				{line.label}{#if hover !== null}: {formatMetricValue(
						unit,
						line.points[hover]?.value ?? null
					)}{/if}
			</li>
		{/each}
		{#if at != null}<li class="text-meta">{when(at)}</li>{/if}
	</ul>
</figure>
