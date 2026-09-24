<script lang="ts">
	import { resetInset } from '#lib/layout/inset.svelte';
	import { cn } from '#lib/utils';
	import { AlertDialog as AlertDialogPrimitive, type WithoutChild } from 'bits-ui';
	import AlertDialogOverlay from './alert-dialog-overlay.svelte';

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: WithoutChild<AlertDialogPrimitive.ContentProps> = $props();
	// An overlay is a new page edge: it does not inherit the page's inset owner.
	resetInset(true);
</script>

<AlertDialogPrimitive.Portal>
	<AlertDialogOverlay />
	<AlertDialogPrimitive.Content
		bind:ref
		class={cn(
			// repository-health:allow UI19 -- bits-ui owns the modal element (focus trap, dismissal); it is viewport-centred with translate and animates zoom/slide on the same transform, which Imposter's placement classes would fight
			// repository-health:allow UI6 -- the content box is the bits-ui element itself; consumers restyle its rhythm through `class` (`gap-0 p-0`), so its children cannot move into a nested primitive
			// repository-health:allow UI27 -- same bits-ui content box as UI6 above: `gap-4` is the overridable default rhythm of its direct children
			'fixed top-[50%] left-[50%] z-50 grid w-full origin-center translate-x-[-50%] translate-y-[-50%] gap-4 border bg-popover p-6 shadow-lg duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:animate-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-1/2 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-1/2 sm:rounded-lg',
			className
		)}
		{...restProps}
	/>
</AlertDialogPrimitive.Portal>
