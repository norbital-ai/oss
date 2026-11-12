<!--
@component
The built-in `file` custom field's renderer: an upload input when edited and a compact preview control when shown.
-->
<script lang="ts">
	import { Array as Arr } from 'effect';
	import { ui_text } from '../../primitives/utils.js';
	import type { KindView } from '../context.js';
	import FileInput from '../file-input.svelte';
	import FileCollection from '../file-collection.svelte';
	import { isFile, type KindOf } from '../kind.js';

	let { view }: { view: KindView } = $props();
	const t = ui_text();
	const kind = $derived<KindOf<'file'>>(
		view.kind?.kind === 'file' ? view.kind : { kind: 'file', accept: ['*/*'], max: '20MiB' }
	);
	const refs = $derived((Arr.isArray(view.value) ? view.value : [view.value]).filter(isFile));
</script>

{#if view.mode === 'edit'}
	<FileInput
		{kind}
		value={view.value}
		on_change={view.on_change}
		name={view.name}
		id={view.id}
		disabled={view.disabled}
		invalid={view.error !== undefined}
	/>
{:else if refs.length === 0}
	<span class="text-muted-foreground">{t('none')}</span>
{:else}
	<span id={view.id} class="inline-flex max-w-full min-w-0 align-middle"
		><FileCollection {refs} /></span
	>
{/if}
