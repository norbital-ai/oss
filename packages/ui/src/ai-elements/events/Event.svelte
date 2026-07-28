<script lang="ts">
	import { Collapsible } from '#lib/collapsible';
	import { cn } from '#lib/utils';
	import { Collapsible as CollapsiblePrimitive } from 'bits-ui';
	import type { Snippet } from 'svelte';

	export interface EventProps extends CollapsiblePrimitive.RootProps {
		class?: string;
		children?: Snippet;
	}

	let { open = $bindable(true), class: className, children, ...restProps }: EventProps = $props();
</script>

<Collapsible
	class={cn(
		'duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:animate-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-1 data-[state=open]:animate-in data-[state=open]:slide-in-from-top-1',
		className
	)}
	bind:open
	{...restProps}
>
	{@render children?.()}
</Collapsible>
