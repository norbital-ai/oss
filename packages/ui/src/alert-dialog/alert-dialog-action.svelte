<script lang="ts">
	import { buttonVariants } from '#lib/button';
	import { cn } from '#lib/utils';
	import { AlertDialog as AlertDialogPrimitive } from 'bits-ui';

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: AlertDialogPrimitive.ActionProps = $props();
</script>

<!-- repository-health:allow UI25 -- the button recipe is a tailwind-variants `tv()` whose literal classes live in button.svelte -->
<AlertDialogPrimitive.Action bind:ref class={cn(buttonVariants(), className)} {...restProps} />
