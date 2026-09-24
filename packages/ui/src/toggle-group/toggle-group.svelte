<script lang="ts" module>
	import { createContext } from 'svelte';
	import type { ToggleVariants } from '#lib/toggle';

	type ToggleGroupCtxGetter = () => ToggleVariants;
	export const [getToggleGroupCtx, setToggleGroupCtx] = createContext<() => ToggleGroupCtxGetter>();
</script>

<script lang="ts">
	import { Inline } from '#lib/layout';
	import { ToggleGroup as ToggleGroupPrimitive } from 'bits-ui';

	let {
		ref = $bindable(null),
		value = $bindable(),
		size = 'default',
		variant = 'default',
		children,
		...restProps
	}: ToggleGroupPrimitive.RootProps & ToggleVariants = $props();

	const toggleGroupCtx = $derived({ variant, size });

	function updateSingle(next: string): void {
		value = next;
		if (restProps.type === 'single') restProps.onValueChange?.(next);
	}

	function updateMultiple(next: string[]): void {
		value = next;
		if (restProps.type === 'multiple') restProps.onValueChange?.(next);
	}

	// Pass getter to delay reading - maintains reactivity
	setToggleGroupCtx(() => () => toggleGroupCtx);
</script>

{#if restProps.type === 'single'}
	<ToggleGroupPrimitive.Root
		{...restProps}
		type="single"
		bind:ref
		value={typeof value === 'string' ? value : undefined}
		onValueChange={updateSingle}
	>
		{#snippet child({ props })}
			<Inline gap="xs" justify="center" {...props}>{@render children?.()}</Inline>
		{/snippet}
	</ToggleGroupPrimitive.Root>
{:else}
	<ToggleGroupPrimitive.Root
		{...restProps}
		type="multiple"
		bind:ref
		value={Array.isArray(value) ? value : undefined}
		onValueChange={updateMultiple}
	>
		{#snippet child({ props })}
			<Inline gap="xs" justify="center" {...props}>{@render children?.()}</Inline>
		{/snippet}
	</ToggleGroupPrimitive.Root>
{/if}
