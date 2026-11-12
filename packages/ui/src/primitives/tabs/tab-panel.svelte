<script lang="ts">
	import { Tabs } from 'bits-ui';
	import type { Snippet } from 'svelte';
	import { provisional_inset } from '../../layout/inset.svelte.js';
	import { INSET_X_CLASS } from '../../layout/layout.shared.js';
	import { cn } from '../utils.js';

	let { value, label, children }: { value: string; label: string; children: Snippet } = $props();
	const inset = provisional_inset();
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
