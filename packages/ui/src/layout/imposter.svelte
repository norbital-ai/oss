<script lang="ts" module>
	import type { Snippet } from 'svelte';
	import type { LayoutAttributes, LayoutElement } from '#lib/layout/layout.shared';

	export type ImposterPlacement =
		| 'center'
		| 'fill'
		| 'top'
		| 'bottom'
		| 'start'
		| 'end'
		| 'top-start'
		| 'top-end'
		| 'bottom-start'
		| 'bottom-end'
		| 'center-start'
		| 'center-end';
	export type ImposterOffset = 'none' | 'xs' | 'sm' | 'md';
	export type ImposterLayer = 'under' | 'raised' | 'overlay' | 'modal';
	export interface ImposterProps extends LayoutAttributes {
		as?: LayoutElement;
		/**
		 * Where the layer sits over its positioned (`relative`) parent. `fill` covers it (a scrim, a
		 * camera guide); `top`/`bottom` are full-width bars, `start`/`end` full-height strips; the
		 * corners pin a badge or control; `center-start`/`center-end` centre it on an edge.
		 */
		placement?: ImposterPlacement;
		/**
		 * Distance from the edges it is pinned to: `sm` (0.5rem) for a corner or an edge-centred
		 * control, `none` for a bar, a strip or `fill`, which run to the edge by default.
		 */
		offset?: ImposterOffset;
		/**
		 * The stacking layer. `under` sits beneath later siblings (a decorative backdrop), `raised`
		 * above them, `overlay` above page chrome (a drag preview, a table-of-contents panel),
		 * `modal` above everything (a full-screen takeover).
		 */
		layer?: ImposterLayer;
		/**
		 * `absolute` pins to the parent; `fixed` to the viewport; `sticky` stays in flow and sticks to
		 * its scrollport's edge — a table header, a rail.
		 */
		position?: 'absolute' | 'fixed' | 'sticky';
		/** Keep the layer inside the parent: never larger than it, scrolling if it must. */
		contain?: boolean;
		/** Absent for a purely decorative layer (a track line, a hit area). */
		children?: Snippet;
	}
</script>

<script lang="ts">
	import { cn } from '#lib/utils';

	let {
		as = 'div',
		ref = $bindable(null),
		placement = 'center',
		offset,
		layer = 'raised',
		position = 'absolute',
		contain = false,
		class: className,
		children,
		...restProps
	}: ImposterProps = $props();

	// Literal classes per offset: Tailwind emits only what it can read in source.
	const EDGE = {
		none: { top: 'top-0', bottom: 'bottom-0', start: 'left-0', end: 'right-0' },
		xs: { top: 'top-1', bottom: 'bottom-1', start: 'left-1', end: 'right-1' },
		sm: { top: 'top-2', bottom: 'bottom-2', start: 'left-2', end: 'right-2' },
		md: { top: 'top-3', bottom: 'bottom-3', start: 'left-3', end: 'right-3' }
	} as const;
	const LAYER: Record<ImposterLayer, string> = {
		under: 'z-0',
		raised: 'z-10',
		overlay: 'z-40',
		modal: 'z-50'
	};
	const placementClass = $derived.by(() => {
		const flush = ['fill', 'top', 'bottom', 'start', 'end', 'center'].includes(placement);
		const edge = EDGE[offset ?? (flush ? 'none' : 'sm')];
		switch (placement) {
			case 'center':
				return 'top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2';
			case 'fill':
				return 'inset-0';
			case 'top':
				return cn('inset-x-0', edge.top);
			case 'bottom':
				return cn('inset-x-0', edge.bottom);
			case 'start':
				return cn('inset-y-0', edge.start);
			case 'end':
				return cn('inset-y-0', edge.end);
			case 'top-start':
				return cn(edge.top, edge.start);
			case 'top-end':
				return cn(edge.top, edge.end);
			case 'bottom-start':
				return cn(edge.bottom, edge.start);
			case 'bottom-end':
				return cn(edge.bottom, edge.end);
			case 'center-start':
				return cn('top-1/2 -translate-y-1/2', edge.start);
			case 'center-end':
				return cn('top-1/2 -translate-y-1/2', edge.end);
		}
	});
</script>

<!-- Every Layout's Imposter: the one sanctioned way to overlap. An absolute parent names itself `relative`. -->
<svelte:element
	this={as}
	bind:this={ref}
	class={cn(
		position,
		'min-w-0',
		LAYER[layer],
		placementClass,
		contain && 'max-h-full max-w-full overflow-auto',
		className
	)}
	data-layout="imposter"
	{...restProps}
>
	{@render children?.()}
</svelte:element>
