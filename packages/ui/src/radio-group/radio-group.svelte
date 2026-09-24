<script lang="ts">
	import { Stack } from '#lib/layout';
	import { RadioGroup as RadioGroupPrimitive } from 'bits-ui';

	let {
		ref = $bindable(null),
		value = $bindable(''),
		children,
		...restProps
	}: RadioGroupPrimitive.RootProps = $props();
</script>

<RadioGroupPrimitive.Root bind:ref bind:value {...restProps}>
	{#snippet child({ props })}
		<Stack gap="sm" {...props}>{@render children?.()}</Stack>
	{/snippet}
</RadioGroupPrimitive.Root>
