<script lang="ts">
	import { cn } from '#lib/utils';
	import { Inline } from '#lib/layout';
	import { Calendar as CalendarPrimitive } from 'bits-ui';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: CalendarPrimitive.HeaderProps = $props();
</script>

<CalendarPrimitive.Header bind:ref class={cn('relative w-full pt-1', className)} {...restProps}>
	{#snippet child({ props })}
		<Inline as="header" gap="none" justify="between" {...props}>
			{@render children?.()}
		</Inline>
	{/snippet}
</CalendarPrimitive.Header>
