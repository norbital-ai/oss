<!--
@component
The built-in `file` custom field's renderer: the drop zone and file rows when edited; rows with thumbnails, download and
image preview when shown; overlapping thumbnails and a name or count in a dense line.
-->
<script lang="ts">
	import Icon from '@iconify/svelte';
	import { uiText } from '../../primitives/utils.js';
	import { useKinds, type CustomFieldView } from '../context.js';
	import FileInput from '../file-input.svelte';
	import FileList, { fileIcon } from '../file-list.svelte';
	import { isFile, type KindOf } from '../kind.js';

	let { view }: { view: CustomFieldView } = $props();
	const host = useKinds();
	const t = uiText();
	const kind = $derived<KindOf<'file'>>(view.kind?.kind === 'file' ? view.kind : { kind: 'file', accept: ['*/*'], max: '20MiB' });
	const refs = $derived((Array.isArray(view.value) ? view.value : [view.value]).filter(isFile));
	const first = $derived(refs[0]);
	const firstUrl = $derived(first === undefined ? undefined : host.fileUrl?.(first));
</script>

{#if view.mode === 'edit'}
	<FileInput {kind} value={view.value} onChange={view.onChange} name={view.name} id={view.id} disabled={view.disabled} invalid={view.error !== undefined} />
{:else if refs.length === 0}
	<span class="text-muted-foreground">{t('none')}</span>
{:else if view.dense}
	<span class="inline-flex max-w-full min-w-0 items-center gap-2 align-middle">
		<span class="flex shrink-0 -space-x-1.5">
			{#each refs.slice(0, 3) as f (f.id)}
				{@const url = host.fileUrl?.(f)}
				{#if f.mime.startsWith('image/') && url !== undefined}
					<img src={url} alt="" loading="lazy" class="size-5 rounded-full border border-background object-cover" />
				{:else}
					<span class="grid size-5 place-items-center rounded-full border border-background bg-muted"><Icon icon={fileIcon(f.mime)} class="size-3 text-muted-foreground" /></span>
				{/if}
			{/each}
			{#if refs.length > 3}<span class="grid size-5 place-items-center rounded-full border border-background bg-secondary text-tiny font-medium text-muted-foreground">+{refs.length - 3}</span>{/if}
		</span>
		{#if refs.length === 1 && first !== undefined && firstUrl !== undefined}
			<a class="min-w-0 truncate underline-offset-2 hover:underline" href={firstUrl} target="_blank" rel="noopener">{first.name}</a>
		{:else}
			<span class="min-w-0 truncate">{refs.length === 1 ? first?.name : t('fileCount').replace('{n}', String(refs.length))}</span>
		{/if}
	</span>
{:else}
	<div id={view.id} class="min-w-0"><FileList {refs} /></div>
{/if}
