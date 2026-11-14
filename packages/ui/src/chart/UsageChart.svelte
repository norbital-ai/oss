<!--
@component
	One metric's trend over time as an inline SVG line chart: the first line is the use, dashed lines are what bounds it
	(a capacity, a machine's total). Hovering reads every line at that time.
-->
<script lang="ts" module>
	import type { UiContext } from '../client/contract.js';
	type UsageChartLine = Readonly<{
		/** The legend name. */
		label: string;
		/** A bound (capacity, total) drawn dashed and faded, rather than the use. */
		bound: boolean;
		/** Samples in time order (`at` in epoch milliseconds); a null value is a gap. */
		points: ReadonlyArray<Readonly<{ at: number; value: number | null }>>;
	}>;

	export type UsageChartProps = {
		/** The page context (`ctx`), passed whole. */
		ctx: UiContext;
		/** The metric's name above the chart; also its accessible label. */
		title: string;
		/** How values read: `bytes`, `MiB`, `micro-SGD`, `seconds`, `load per core`, else a suffix. */
		unit: string;
		/** The series: the first is the use; the x axis follows its sample times. */
		lines: ReadonlyArray<UsageChartLine>;
		/** Peak use as a fraction of capacity (0–1), shown as a percentage beside the title; null hides it. */
		utilization?: number | null;
	};

	const peakValue = (values: ReadonlyArray<number | null>): number | null => {
		const known = values.filter((value) => value !== null);
		return known.length === 0 ? null : Math.max(...known);
	};
	const BYTES = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
	/** A reading in its unit, for people. */
	export function format_metric_value(unit: string, value: number | null, locale?: string): string {
		if (value === null) return 'Unavailable';
		if (unit === 'bytes' || unit === 'MiB') {
			let scaled = unit === 'MiB' ? value * 1024 * 1024 : value,
				step = 0;
			while (scaled >= 1024 && step < BYTES.length - 1) {
				scaled /= 1024;
				step++;
			}
			return `${scaled.toLocaleString(locale, { maximumFractionDigits: 1 })} ${BYTES[step]}`;
		}
		if (unit === 'micro-SGD')
			return new Intl.NumberFormat(locale ?? 'en-SG', {
				style: 'currency',
				currency: 'SGD',
				maximumFractionDigits: value > 0 && value < 10_000 ? 6 : 2
			}).format(value / 1_000_000);
		if (unit === 'seconds')
			return value >= 3600
				? `${(value / 3600).toLocaleString(locale, { maximumFractionDigits: 1 })} h`
				: `${value.toLocaleString(locale, { maximumFractionDigits: 1 })} s`;
		if (unit === 'load per core') return `${Math.round(value * 100)}%`;
		return `${value.toLocaleString(locale, { maximumFractionDigits: 1 })} ${unit}`;
	}
</script>

<script lang="ts">
	import { ui_text } from '../primitives/utils.js';

	let { ctx, title, unit, lines, utilization = null }: UsageChartProps = $props();
	const host = $derived(ctx.ui.kinds);
	const t = ui_text();
	const metric = (value: number | null) =>
		value === null ? t('unavailable') : format_metric_value(unit, value, host.locale);
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
		new Date(millis).toLocaleString(host.locale, { dateStyle: 'short', timeStyle: 'short' });
</script>

<figure class="flex h-full min-w-0 flex-col gap-2 rounded-md border border-border p-3 text-xs">
	<figcaption class="flex flex-wrap items-baseline justify-between gap-2">
		<span class="text-xs font-medium">{title}</span>
		<span class="text-meta">
			{#if utilization !== null}{t('peakCapacity').replace(
					'{n}',
					String(Math.round(utilization * 100))
				)}{:else}{t('peak')} {metric(peakValue(lines[0]?.points.map((p) => p.value) ?? []))}{/if}
		</span>
	</figcaption>
	<svg
		viewBox={`0 0 ${W} ${H}`}
		preserveAspectRatio="none"
		class="min-h-32 w-full flex-1 touch-pan-y"
		role="img"
		aria-label={`${title} ${t('overTime')}`}
		onpointerdown={move}
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
		<span>{t('maximum')} {metric(maximum)}</span>
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
				{line.label}{#if hover !== null}: {metric(line.points[hover]?.value ?? null)}{/if}
			</li>
		{/each}
		{#if at != null}<li class="text-meta">{when(at)}</li>{/if}
	</ul>
</figure>
