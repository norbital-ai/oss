<script lang="ts" module>
	import type { Snippet } from 'svelte';
	import type { LayoutAttributes, LayoutElement, LayoutGap } from '#lib/layout/layout.shared';

	export type SwitcherThreshold = 'compact' | 'narrow' | 'wide';
	export interface SwitcherProps extends LayoutAttributes {
		as?: LayoutElement;
		/**
		 * The container width below which every child takes a full row. Intrinsic (Every Layout's
		 * Switcher): no media or container query, so it responds to the space it is actually given.
		 */
		threshold?: SwitcherThreshold;
		gap?: LayoutGap;
		align?: 'start' | 'center' | 'end' | 'stretch';
		/** Stacked, the last child comes first — a dialog footer's primary action on top. */
		reverse?: boolean;
		children: Snippet;
	}
</script>

<script lang="ts">
	import { cn } from '#lib/utils';
	import { GAP_CLASSES } from '#lib/layout/layout.shared';

	let {
		as = 'div',
		ref = $bindable(null),
		threshold = 'narrow',
		gap = 'sm',
		align = 'stretch',
		reverse = false,
		class: className,
		children,
		...restProps
	}: SwitcherProps = $props();
	const thresholds: Record<SwitcherThreshold, string> = {
		compact: '30rem',
		narrow: '40rem',
		wide: '60rem'
	};
	const alignClasses = {
		start: 'items-start',
		center: 'items-center',
		end: 'items-end',
		stretch: 'items-stretch'
	} as const;
	const { style: styleProp, ...attributes } = $derived(
		restProps as { style?: string } & Record<string, unknown>
	);
</script>

<svelte:element
	this={as}
	bind:this={ref}
	class={cn(
		'switcher flex min-h-0 min-w-0 flex-wrap',
		reverse && 'flex-wrap-reverse',
		GAP_CLASSES[gap],
		alignClasses[align],
		// The caller's class last: floors, layers and colours it names win; layout itself is props (doctor-enforced).
		className
	)}
	style={`--switcher-threshold: ${thresholds[threshold]};${styleProp ? ` ${styleProp}` : ''}`}
	data-layout="switcher"
	{...attributes}
>
	{@render children()}
</svelte:element>

<style>
	/* Negative (so zero) above the threshold, enormous below it: all in one row, or all stacked. */
	.switcher > :global(*) {
		flex-grow: 1;
		flex-basis: calc((var(--switcher-threshold) - 100%) * 999);
		min-width: 0;
	}
</style>
