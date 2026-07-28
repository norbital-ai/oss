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
	}: PaginationPrimitive.NextButtonProps = $props();
</script>

{#snippet Fallback()}
	<Icon icon="lucide:chevron-right" class="size-4" />
{/snippet}

<PaginationPrimitive.NextButton
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
