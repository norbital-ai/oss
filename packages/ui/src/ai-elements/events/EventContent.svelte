<script lang="ts">
	import { CollapsibleContent } from '#lib/collapsible';
	import { cn } from '#lib/utils';
	import { Collapsible as CollapsiblePrimitive } from 'bits-ui';
	import type { Snippet } from 'svelte';

	export interface EventContentProps extends CollapsiblePrimitive.ContentProps {
		children?: Snippet;
		class?: string;
	}

	let { children, class: className, ...restProps }: EventContentProps = $props();
</script>

<CollapsibleContent
	class={cn(
		'text-popover-foreground outline-none duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:animate-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-1 data-[state=open]:animate-in data-[state=open]:slide-in-from-top-1',
		className
	)}
	{...restProps}
>
	<div class="mt-4 space-y-2 border-l-2 border-muted pl-4">
		{@render children?.()}
	</div>
</CollapsibleContent>
