<script lang="ts">
	import { cn } from '#lib/utils';
	import { Dialog as DialogPrimitive } from 'bits-ui';

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: DialogPrimitive.OverlayProps = $props();
</script>

<DialogPrimitive.Overlay
	bind:ref
	data-slot="dialog-overlay"
	class={cn(
		// repository-health:allow UI19 -- bits-ui owns the overlay element (presence and data-state animation); Imposter's `as` renders plain tags, not a bits-ui component, so the fixed inset-0 z-50 scrim stays on the library's element
		'fixed inset-0 z-50 bg-black/80  data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0',
		className
	)}
	{...restProps}
/>
