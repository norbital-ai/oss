<script lang="ts" module>
	import { setContext } from 'svelte';

	const COMMAND_GROUP_KEY = Symbol('command-group-id');

	function setCommandGroupId(getter: () => string) {
		setContext(COMMAND_GROUP_KEY, getter);
	}
</script>

<script lang="ts">
	import { Bound } from '#lib/layout';
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

<!-- A content-height group clipping its item rows at the popup edge; uncontained, so a popover still sizes to its rows. -->
<Bound
	bind:ref
	size="auto"
	clip
	pad="xs"
	class={cn('text-foreground [container-type:normal]', className)}
	data-command-group="true"
	data-group-id={groupId}
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
</Bound>
