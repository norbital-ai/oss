<!--
	The record sheet the shell opens for `?record=<collection>/<id|new>`: ui's `RecordShell` over `$bolt`. The shell
	provides the representation registry (lazy, one chunk each) above it and above every page; the opener's contexts
	(`openRecord`'s third argument) are set above it, so a create keeps the scope of the page that opened it.
-->
<script lang="ts">
	import { Sheet } from '@norbital-ai/ui';
	import { carriedContexts, onPageContexts, pageContexts, RecordShell, singular } from '@norbital-ai/ui';
	import { onDestroy } from 'svelte';
	import Carry from './Carry.svelte';
	import { currentBolt } from './runtime.ts';

	let { collection, id, onClose }: { collection: string; id: string; onClose: () => void } = $props();
	// the opener's contexts; else the page's (a reload or a link), which may mount after this sheet: it remounts once then
	// svelte-ignore state_referenced_locally
	const carried = carriedContexts(collection, id);
	// svelte-ignore state_referenced_locally
	let page = $state(carried === undefined ? pageContexts(collection) : undefined);
	onDestroy(onPageContexts(() => { if (carried === undefined && page === undefined) page = pageContexts(collection); }));
	const bolt = currentBolt();
	// hook:agent-ui — the sheet's accessible title is one record of the collection (ui's `singular`: `models.<c>.singular`,
	// else its label made singular); the visible heading is `RecordShell`'s, the record's own label
	const title = $derived(singular(bolt, collection));
</script>

<!-- the opener's contexts (a page's create scope) sit above the sheet, which then resets its own; the shell mounts one
     sheet per record, and it remounts once if the page's contexts arrive after it -->
{#key page}
	<Carry contexts={carried ?? page}>
		<Sheet open {title} onOpenChange={(open) => { if (!open) onClose(); }}>
			{#if id === 'new'}<RecordShell of={collection} mode="create" />{:else}<RecordShell of={collection} {id} />{/if}
		</Sheet>
	</Carry>
{/key}
