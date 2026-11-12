<!--
	The record sheet the shell opens for `?record=<model>/<id|new>`: ui's `RecordShell` over the page client. The shell
	provides the representation registry (lazy, one chunk each) above it and above every page; the opener's contexts
	(`open_record`'s third argument) are set above it, so a create keeps the scope of the page that opened it.
-->
<script lang="ts">
	import { Sheet, type UiContext } from '@norbital-ai/ui';
	import { carried_contexts, on_page_contexts, page_contexts, RecordShell } from '@norbital-ai/ui';
	import { onDestroy } from 'svelte';
	import Carry from './Carry.svelte';

	let { ctx, model, id, on_close }: { ctx: UiContext; model: string; id: string; on_close: () => void } = $props();
	// the opener's contexts; else the page's (a reload or a link), which may mount after this sheet: it remounts once then
	// svelte-ignore state_referenced_locally
	const carried = carried_contexts(model, id);
	// svelte-ignore state_referenced_locally
	let page = $state(carried === undefined ? page_contexts(model) : undefined);
	onDestroy(
		on_page_contexts(() => {
			if (carried === undefined && page === undefined) page = page_contexts(model);
		})
	);
	// hook:agent-ui — the sheet's accessible title is the record's own heading, which the `RecordShell` inside claims (the
	// record's label, or the author's title); nothing to pass here
</script>

<!-- the opener's contexts (a page's create scope) sit above the sheet, which then resets its own; the shell mounts one
     sheet per record, and it remounts once if the page's contexts arrive after it -->
{#key page}
	<Carry contexts={carried ?? page}>
		<Sheet
			open
			on_open_change={(open) => {
				if (!open) on_close();
			}}
		>
			{#if id === 'new'}<RecordShell {ctx} of={model} mode="create" />{:else}<RecordShell {ctx}
					of={model}
					{id}
				/>{/if}
		</Sheet>
	</Carry>
{/key}
