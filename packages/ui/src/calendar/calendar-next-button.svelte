<script lang="ts">
	import { buttonVariants } from '#lib/button';
	import { cn } from '#lib/utils';
	import Icon from '@iconify/svelte';
	import { Calendar as CalendarPrimitive } from 'bits-ui';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: CalendarPrimitive.PrevButtonProps = $props();
</script>

{#snippet Fallback()}
	<Icon icon="lucide:chevron-right" class="size-4" />
{/snippet}

<CalendarPrimitive.PrevButton
	bind:ref
	class={cn(
		buttonVariants({ variant: 'outline' }),
		'size-7 bg-transparent p-0 opacity-50 hover:opacity-100',
		className
	)}
	children={children || Fallback}
	{...restProps}
/>
