<script lang="ts">
	import { Stack } from '#lib/layout';
	import { cn, type WithElementRef } from '#lib/utils';
	import type { HTMLAttributes, HTMLFieldsetAttributes } from 'svelte/elements';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLFieldsetAttributes> = $props();
</script>

<Stack
	as="fieldset"
	gap="lg"
	data-slot="field-set"
	class={cn(
		'has-[>[data-slot=checkbox-group]]:gap-3 has-[>[data-slot=radio-group]]:gap-3',
		className
	)}
	{...restProps as HTMLAttributes<HTMLElement>}
	{@attach (node: HTMLFieldSetElement) => {
		ref = node;
		return () => (ref = null);
	}}
>
	{@render children?.()}
</Stack>
