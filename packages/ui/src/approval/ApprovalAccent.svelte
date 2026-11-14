<!--
@component
The right-hand accent a list row or card carries while an open approval request holds its record (`$approval`), with a
one-line tooltip: who asked, where it stands, whom it waits on. Its container is `relative`.
-->
<script lang="ts">
	import type { UiContext } from '../client/contract.js';
	import { bolt_of } from '../client/context.js';
	import { approvalOf, approvalText } from './row.js';
	let {
		ctx,
		row
	}: {
		/** The page context the tooltip's words come from. */
		ctx: UiContext;
		/** The row or card as read, its `$approval` included. */
		row: unknown;
	} = $props();
	const bolt = $derived(bolt_of(ctx));
	const a = $derived(approvalOf(row));
	const text = $derived(a === null ? '' : approvalText(bolt, a));
</script>

{#if a !== null}<span
		class={[
			'absolute inset-y-0 right-0 w-1 rounded-r-sm',
			a.state === 'Pending' ? 'bg-warning' : 'bg-primary'
		]}
		role="img"
		aria-label={text}
		title={text}
		data-approval={a.state}
	></span>{/if}
