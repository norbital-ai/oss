<script lang="ts" module>
	import type { Snippet } from 'svelte';
	import type { Collapsible as CollapsiblePrimitive } from 'bits-ui';

	export interface QueueSectionProps extends CollapsiblePrimitive.RootProps {
		children?: Snippet;
	}
</script>

<script lang="ts">
	import { Collapsible } from '#lib/collapsible';

	let {
		open = $bindable(true),
		children,
		ref = $bindable(null),
		...restProps
	}: QueueSectionProps = $props();
</script>

<Collapsible bind:ref bind:open {...restProps}>
	{@render children?.()}
</Collapsible>
