<script lang="ts">
	import { Accordion as AccordionPrimitive } from 'bits-ui';

	let {
		ref = $bindable(null),
		value = $bindable(),
		...restProps
	}: AccordionPrimitive.RootProps = $props();
</script>

{#if restProps.type === 'multiple'}
	<AccordionPrimitive.Root
		bind:ref
		bind:value={
			() => (Array.isArray(value) ? value : undefined),
			(next: string[] | undefined) => (value = next)
		}
		data-slot="accordion"
		{...restProps}
	/>
{:else}
	<AccordionPrimitive.Root
		bind:ref
		bind:value={
			() => (typeof value === 'string' ? value : undefined),
			(next: string | undefined) => (value = next)
		}
		data-slot="accordion"
		{...restProps}
	/>
{/if}
