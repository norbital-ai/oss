<script lang="ts">
	import { cn } from '../utils.js';
	import PrimitiveOverlay from './dialog-primitive-overlay.svelte';
	import type { ComponentProps } from 'svelte';

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: ComponentProps<typeof PrimitiveOverlay> = $props();
</script>

<PrimitiveOverlay
	bind:ref
	data-slot="dialog-overlay"
	class={cn(
		// repository-health:allow UI19 -- PrimitiveOverlay owns the overlay element (presence and data-state animation), so the fixed inset-0 z-50 scrim stays on that element
		'fixed inset-0 z-50 bg-black/80 animation-duration-150 ease-out motion-reduce:animate-none data-[state=closed]:pointer-events-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:fill-mode-forwards data-[state=open]:animate-in data-[state=open]:fade-in-0',
		className
	)}
	{...restProps}
/>
