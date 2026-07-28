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

	// Pass getter to delay reading - maintains reactivity
	setToggleGroupCtx(() => () => toggleGroupCtx);
</script>

<ToggleGroupPrimitive.Root
	bind:ref
	class={cn('flex items-center justify-center gap-1', className)}
	bind:value={
		value as unknown /* stupidity: boundary-cast -- Svelte cannot preserve bits-ui's single/multiple binding discriminant */ as string &
			string[]
	}
	{...restProps}
/>
