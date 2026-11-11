<script lang="ts">
	import { Tabs } from 'bits-ui';
	import type { Snippet } from 'svelte';
	import { provisionalInset } from '../../layout/inset.svelte.js';
	import { INSET_X_CLASS } from '../../layout/layout.shared.js';
	import { cn } from '../utils.js';

	let {
		value,
		label,
		children,
		class: className
	}: { value: string; label: string; children: Snippet; class?: string } = $props();
	const inset = provisionalInset();
</script>

<Tabs.Content
	{value}
	aria-label={label}
	class={cn(
		'min-h-0 min-w-0 overflow-x-clip overflow-y-auto',
		inset.padded && INSET_X_CLASS,
		className
	)}
>
	{@render children()}
</Tabs.Content>
