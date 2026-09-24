<script lang="ts">
	import { Stack } from '#lib/layout';
	import { cn, type WithElementRef } from '#lib/utils';
	import type { HTMLAttributes } from 'svelte/elements';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> = $props();
</script>

<Stack
	gap="lg"
	data-slot="field-group"
	class={cn(
		'group/field-group @container/field-group w-full data-[slot=checkbox-group]:gap-3 [&>[data-slot=field-group]]:gap-4',
		className
	)}
	{...restProps}
	{@attach (node: HTMLDivElement) => {
		ref = node;
		return () => (ref = null);
	}}
>
	{@render children?.()}
</Stack>
