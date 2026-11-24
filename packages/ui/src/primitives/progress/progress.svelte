<!--
@component
A progress bar of `value` out of `max`.
-->
<script lang="ts">
	import type { HTMLAttributes } from 'svelte/elements';
	import { cn, type WithElementRef, type WithoutChildrenOrChild } from '../utils.js';

	let {
		ref = $bindable(null),
		class: className,
		max = 100,
		value = null,
		...restProps
	}: WithoutChildrenOrChild<WithElementRef<HTMLAttributes<HTMLDivElement>, HTMLDivElement>> & {
		/** Maximum progress value (default `100`). */
		max?: number;
		/** Current progress value, or `null` when indeterminate. */
		value?: number | null;
	} = $props();

	const safeMax = $derived(max > 0 ? max : 100);
	const clamped = $derived(value === null ? 0 : Math.max(0, Math.min(safeMax, value)));
	const state = $derived(
		value === null ? 'indeterminate' : clamped >= safeMax ? 'complete' : 'loading'
	);
</script>

<div
	bind:this={ref}
	role="progressbar"
	aria-valuemin={0}
	aria-valuemax={safeMax}
	aria-valuenow={value === null ? undefined : clamped}
	data-state={state}
	data-value={value === null ? undefined : clamped}
	data-max={safeMax}
	class={cn('relative h-2 w-full overflow-clip rounded-full bg-secondary', className)}
	{...restProps}
>
	<div
		class="h-full w-full flex-1 bg-primary transition-transform duration-200 ease-out motion-reduce:transition-none"
		style={`transform: translateX(-${100 - (100 * clamped) / safeMax}%)`}
	></div>
</div>
