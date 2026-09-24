<script lang="ts" module>
	import type { Snippet } from 'svelte';
	import type { Collapsible as CollapsiblePrimitive } from 'bits-ui';

	export interface QueueSectionContentProps extends CollapsiblePrimitive.ContentProps {
		children?: Snippet;
	}
</script>

<script lang="ts">
	import { CollapsibleContent } from '#lib/collapsible';

	let { children, ref = $bindable(null), ...restProps }: QueueSectionContentProps = $props();
</script>

<CollapsibleContent bind:ref {...restProps}>
	{@render children?.()}
</CollapsibleContent>
