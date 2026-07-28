<script lang="ts">
	import { buttonVariants } from '#lib/button';
	import { cn } from '#lib/utils';
	import Icon from '@iconify/svelte';
	import { AlertDialog as AlertDialogPrimitive } from 'bits-ui';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: AlertDialogPrimitive.CancelProps = $props();
</script>

<AlertDialogPrimitive.Cancel
	bind:ref
	class={cn(
		buttonVariants({ variant: 'ghost', size: children ? undefined : 'icon' }),
		'mt-2 sm:mt-0',
		className
	)}
	{...restProps}
>
	{#if children}
		{@render children()}
	{:else}
		<Icon icon="lucide:x" class="h-4 w-4" />
	{/if}
</AlertDialogPrimitive.Cancel>
