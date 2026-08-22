<script lang="ts" module>
	import { setContext } from 'svelte';

	const COMMAND_GROUP_KEY = Symbol('command-group-id');

	function setCommandGroupId(getter: () => string) {
		setContext(COMMAND_GROUP_KEY, getter);
	}
</script>

<script lang="ts">
	import { cn } from '#lib/utils';

	import type { CommandGroupProps } from '#lib/command/types';

	let {
		ref = $bindable(null),
		heading,
		class: className,
		children,
		...restProps
	}: CommandGroupProps = $props();

	// Generate unique group ID
	const groupId = `command-group-${Math.random().toString(36).slice(2, 11)}`;

	// Provide group ID to child items
	setCommandGroupId(() => groupId);
</script>

<!-- stupidity:allow UI5 -- this leaf component owns a local clip or scroll boundary required by its interaction contract -->
<div
	bind:this={ref}
	data-command-group="true"
	data-group-id={groupId}
	class={cn('overflow-hidden p-1 text-foreground', className)}
	{...restProps}
>
	{#if heading}
		<div class="px-2 py-1.5 text-sm font-medium text-muted-foreground underline">
			{heading}
		</div>
	{/if}
	{#if children}
		{@render children()}
	{/if}
</div>
