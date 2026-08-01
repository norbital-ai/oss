<script lang="ts">
	import { cn, type WithElementRef } from '#lib/utils';
	import type { HTMLFieldsetAttributes } from 'svelte/elements';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLFieldsetAttributes> = $props();
</script>

<!-- stupidity:allow UI6 -- this leaf component root is the reusable layout boundary being defined -->
<fieldset
	bind:this={ref}
	data-slot="field-set"
	class={cn(
		'flex flex-col gap-6',
		'has-[>[data-slot=checkbox-group]]:gap-3 has-[>[data-slot=radio-group]]:gap-3',
		className
	)}
	{...restProps}
>
	{@render children?.()}
</fieldset>
