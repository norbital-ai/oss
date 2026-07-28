<script lang="ts">
	import { buttonVariants } from '#lib/button';
	import { cn } from '#lib/utils';
	import Icon from '@iconify/svelte';
	import { Pagination as PaginationPrimitive } from 'bits-ui';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: PaginationPrimitive.PrevButtonProps = $props();
</script>

{#snippet Fallback()}
	<Icon icon="lucide:chevron-left" class="size-4" />
{/snippet}

<PaginationPrimitive.PrevButton
	bind:ref
	class={cn(
		buttonVariants({
			variant: 'ghost',
			size: 'icon'
		}),
		className
	)}
	children={children || Fallback}
	{...restProps}
/>
