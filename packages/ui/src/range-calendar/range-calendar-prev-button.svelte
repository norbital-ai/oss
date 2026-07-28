<script lang="ts">
	import { buttonVariants } from '#lib/button';
	import { cn } from '#lib/utils';
	import Icon from '@iconify/svelte';
	import { RangeCalendar as RangeCalendarPrimitive } from 'bits-ui';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: RangeCalendarPrimitive.PrevButtonProps = $props();
</script>

{#snippet Fallback()}
	<Icon icon="lucide:chevron-left" class="size-4" />
{/snippet}

<RangeCalendarPrimitive.PrevButton
	bind:ref
	class={cn(
		buttonVariants({ variant: 'outline' }),
		'size-7 bg-transparent p-0 opacity-50 hover:opacity-100',
		className
	)}
	children={children || Fallback}
	{...restProps}
/>
