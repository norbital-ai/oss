<script lang="ts">
	import { Accordion as AccordionPrimitive } from 'bits-ui';
	import type { SnakeProps } from '../bits.js';

	let {
		ref = $bindable(null),
		value = $bindable(),
		...restProps
	}: SnakeProps<AccordionPrimitive.RootProps, { on_value_change: 'onValueChange' }> = $props();
</script>

{#if restProps.type === 'multiple'}
	{@const { on_value_change, ...props } = restProps}
	<AccordionPrimitive.Root
		bind:ref
		bind:value={
			() => (Array.isArray(value) ? value : undefined),
			(next: string[] | undefined) => (value = next)
		}
		data-slot="accordion"
		{...props}
		onValueChange={on_value_change}
	/>
{:else}
	{@const { on_value_change, ...props } = restProps}
	<AccordionPrimitive.Root
		bind:ref
		bind:value={
			() => (typeof value === 'string' ? value : undefined),
			(next: string | undefined) => (value = next)
		}
		data-slot="accordion"
		{...props}
		onValueChange={on_value_change}
	/>
{/if}
