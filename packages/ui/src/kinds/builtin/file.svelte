<!--
@component
The built-in `file` custom field's renderer: one input-height trigger and chips when edited; the same chips (each opening
a preview with Download) when shown; the first chip and how many more in a dense line.
-->
<script lang="ts">
	import { uiText } from '../../primitives/utils.js';
	import type { CustomFieldView } from '../context.js';
	import FileInput from '../file-input.svelte';
	import FileList from '../file-list.svelte';
	import { isFile, type KindOf } from '../kind.js';

	let { view }: { view: CustomFieldView } = $props();
	const t = uiText();
	const kind = $derived<KindOf<'file'>>(view.kind?.kind === 'file' ? view.kind : { kind: 'file', accept: ['*/*'], max: '20MiB' });
	const refs = $derived((Array.isArray(view.value) ? view.value : [view.value]).filter(isFile));
</script>

{#if view.mode === 'edit'}
	<FileInput {kind} value={view.value} onChange={view.onChange} name={view.name} id={view.id} disabled={view.disabled} invalid={view.error !== undefined} />
{:else if refs.length === 0}
	<span class="text-muted-foreground">{t('none')}</span>
{:else}
	<span id={view.id} class="inline-flex max-w-full min-w-0 align-middle"><FileList {refs} dense={view.dense} /></span>
{/if}
