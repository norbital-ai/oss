<script lang="ts" module>
	import { cn } from '#lib/utils';
	import type { Snippet } from 'svelte';
	import type { Collapsible as CollapsiblePrimitive } from 'bits-ui';

	export interface QueueSectionTriggerProps extends CollapsiblePrimitive.TriggerProps {
		children?: Snippet;
	}
</script>

<script lang="ts">
	import { CollapsibleTrigger } from '#lib/collapsible';

	let {
		class: className,
		children,
		ref = $bindable(null),
		...restProps
	}: QueueSectionTriggerProps = $props();
</script>

<CollapsibleTrigger
	bind:ref
	class={cn(
		'group bg-muted/40 text-muted-foreground hover:bg-muted flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm font-medium transition-colors',
		className
	)}
	type="button"
	{...restProps}
>
	{@render children?.()}
</CollapsibleTrigger>
