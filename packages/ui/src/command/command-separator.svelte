<script lang="ts">
	import { cn } from '#lib/utils';
	import type { CommandSeparatorProps } from '#lib/command/types';

	let { ref = $bindable(null), class: className, ...restProps }: CommandSeparatorProps = $props();
</script>

<div bind:this={ref} class={cn('-mx-1 h-px bg-border', className)} {...restProps}></div>
