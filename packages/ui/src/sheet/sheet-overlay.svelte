<script lang="ts">
	import { cn } from '#lib/utils';
	import { Dialog as SheetPrimitive } from 'bits-ui';

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: SheetPrimitive.OverlayProps = $props();

	export { className as class };
</script>

<SheetPrimitive.Overlay
	bind:ref
	class={cn(
		// repository-health:allow UI19 -- bits-ui owns the overlay element (presence and data-state animation); Imposter's `as` renders plain tags, not a bits-ui component, so the fixed inset-0 z-50 scrim stays on the library's element
		'fixed inset-0 z-50',
		className
	)}
	{...restProps}
/>
