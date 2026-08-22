<script lang="ts" module>
	import { createContext } from 'svelte';
	import type { ToggleVariants } from '#lib/toggle';

	type ToggleGroupCtxGetter = () => ToggleVariants;
	export const [getToggleGroupCtx, setToggleGroupCtx] = createContext<() => ToggleGroupCtxGetter>();
</script>

<script lang="ts">
	import { cn } from '#lib/utils';
	import { ToggleGroup as ToggleGroupPrimitive } from 'bits-ui';

	let {
		ref = $bindable(null),
		value = $bindable(),
		class: className,
		size = 'default',
		variant = 'default',
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
		class={cn('flex items-center justify-center gap-1', className)}
		value={typeof value === 'string' ? value : undefined}
		onValueChange={updateSingle}
	/>
{:else}
	<ToggleGroupPrimitive.Root
		{...restProps}
		type="multiple"
		bind:ref
		class={cn('flex items-center justify-center gap-1', className)}
		value={Array.isArray(value) ? value : undefined}
		onValueChange={updateMultiple}
	/>
{/if}
