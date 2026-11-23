<script lang="ts">
	import type { HTMLAttributes } from 'svelte/elements';
	import type { WithElementRef } from '../utils.js';
	import { get_dialog_context } from './context.js';

	let {
		ref = $bindable(null),
		force_mount = false,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>, HTMLDivElement> & {
		/** Keep mounted even while closed. */
		force_mount?: boolean;
	} = $props();

	const dialog = get_dialog_context();
	const open = $derived(dialog?.open ?? false);
</script>

{#if open || force_mount}
	<div
		bind:this={ref}
		data-state={open ? 'open' : 'closed'}
		aria-hidden="true"
		{...restProps}
	></div>
{/if}
