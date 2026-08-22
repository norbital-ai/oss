<script lang="ts">
	import { cn } from '#lib/utils';
	import { Number as Number_ } from 'effect';

	let {
		value,
		class: className,
		size = 16,
		strokeWidth = 2
	}: {
		value: number;
		class?: string;
		size?: number;
		strokeWidth?: number;
	} = $props();

	const radius = $derived((size - strokeWidth) / 2);
	const circumference = $derived(2 * Math.PI * radius);
	const dashOffset = $derived(
		circumference * (1 - Number_.clamp(value, { minimum: 0, maximum: 1 }))
	);
</script>

<svg
	class={cn('shrink-0', className)}
	width={size}
	height={size}
	viewBox="0 0 {size} {size}"
	aria-hidden="true"
>
	<circle
		cx={size / 2}
		cy={size / 2}
		r={radius}
		fill="none"
		class="stroke-foreground/15"
		stroke-width={strokeWidth}
	/>
	<circle
		cx={size / 2}
		cy={size / 2}
		r={radius}
		fill="none"
		class="stroke-current text-primary transition-[stroke-dashoffset] duration-150 ease-out"
		stroke-width={strokeWidth}
		stroke-linecap="round"
		stroke-dasharray={circumference}
		stroke-dashoffset={dashOffset}
		transform="rotate(-90 {size / 2} {size / 2})"
	/>
</svg>
