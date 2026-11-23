<script lang="ts">
	import type { Snippet } from 'svelte';
	import { provisional_inset } from '../../layout/inset.svelte.js';
	import { INSET_X_CLASS } from '../../layout/layout.shared.js';
	import { cn } from '../utils.js';

	let {
		id,
		labelled_by,
		active,
		label,
		vertical = false,
		children,
		class: className
	}: {
		id: string;
		labelled_by: string;
		active: boolean;
		label: string;
		vertical?: boolean;
		children: Snippet;
		class?: string;
	} = $props();
	const inset = provisional_inset();
</script>

<div
	role="tabpanel"
	{id}
	aria-labelledby={labelled_by}
	aria-label={label}
	hidden={!active}
	data-state={active ? 'active' : 'inactive'}
	class={cn(
		'min-h-0 min-w-0 overflow-x-clip overflow-y-auto',
		inset.padded && [INSET_X_CLASS, vertical && '@2xl:ps-0'],
		className
	)}
>
	{@render children()}
</div>
