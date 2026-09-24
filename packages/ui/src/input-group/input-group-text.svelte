<script lang="ts">
	import { Inline } from '#lib/layout';
	import { cn, type WithElementRef } from '#lib/utils';
	import type { HTMLAttributes } from 'svelte/elements';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLSpanElement>> = $props();
</script>

<Inline
	as="span"
	class={cn(
		"text-sm text-muted-foreground [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4",
		className
	)}
	{...restProps}
	{@attach (node: HTMLElement) => {
		ref = node as typeof ref;
		return () => (ref = null);
	}}
>
	{@render children?.()}
</Inline>
