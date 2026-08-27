<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '#lib/utils';

	let {
		mode = 'display',
		class: className,
		children
	}: {
		mode?: 'display' | 'edit';
		class?: string;
		children: Snippet;
	} = $props();
</script>

<!--
	The frame, not an individual surface, owns field-control geometry. Renderers may be direct
	inputs or trigger-and-overlay controls; both occupy the same input-sized footprint wherever a
	field is placed. Complex controls may grow taller, hence min-height rather than a fixed height.
-->
<div
	class={cn('flex min-h-9 min-w-0 w-full items-center text-sm', className)}
	data-data-renderer-control
	data-mode={mode}
>
	{@render children()}
</div>
