<script lang="ts">
	import { Dialog, Icon } from '@norbital-ai/ui';
	import { SvelteSet } from 'svelte/reactivity';
	import type { AgentRow } from '../../protocol/wire.ts';

	type MessageFile = NonNullable<AgentRow['files']>[number];
	type AttachmentFile = MessageFile | File;
	let {
		files,
		file_href,
		t,
		rail = false,
		on_remove
	}: {
		files: readonly AttachmentFile[];
		file_href: (id: string) => string;
		t: (key: string) => string;
		rail?: boolean;
		on_remove?: (file: AttachmentFile) => void;
	} = $props();

	const is_draft = (file: AttachmentFile): file is File =>
		typeof File !== 'undefined' && file instanceof File;
	const mime = (file: AttachmentFile) => is_draft(file) ? file.type : file.mime;
	const href = (file: AttachmentFile) =>
		is_draft(file) || file.id === undefined ? undefined : file_href(file.id);
	const previewable = (file: AttachmentFile) =>
		(is_draft(file) || href(file) !== undefined) &&
		(mime(file).startsWith('image/') || mime(file) === 'application/pdf');
	const icon = (file: AttachmentFile) =>
		mime(file).startsWith('image/') ? 'lucide:image'
			: mime(file).startsWith('audio/') ? 'lucide:audio-lines'
				: mime(file).includes('presentation') ? 'lucide:presentation'
					: mime(file).includes('sheet') || mime(file).includes('csv') ? 'lucide:sheet'
						: 'lucide:file-text';
	const label = (file: AttachmentFile) =>
		file.name.includes('.') ? file.name.split('.').at(-1)?.toUpperCase() ?? t('File') : t('File');
	const failed_images = new SvelteSet<AttachmentFile>();
	let shown = $state<AttachmentFile | null>(null);
	let preview_error = $state(false);
	function open(file: AttachmentFile): void {
		preview_error = false;
		shown = file;
	}
	// A draft's object URL belongs to the mounted preview, including the full-size dialog.
	function media_source(file: AttachmentFile, full = false) {
		return (node: HTMLImageElement | HTMLIFrameElement) => {
			if (is_draft(file)) {
				const url = URL.createObjectURL(file);
				node.src = url;
				return () => URL.revokeObjectURL(url);
			}
			const url = href(file);
			if (url !== undefined) node.src = full ? url : `${url}${url.includes('?') ? '&' : '?'}preview=${rail ? 64 : 512}`;
		};
	}
	function download_source(file: AttachmentFile) {
		return (node: HTMLAnchorElement) => {
			if (is_draft(file)) {
				const url = URL.createObjectURL(file);
				node.href = url;
				return () => URL.revokeObjectURL(url);
			}
			const url = href(file);
			if (url !== undefined) node.href = url;
		};
	}
</script>

{#snippet file_label(file: AttachmentFile)}
	<span class="grid size-10 shrink-0 place-items-center overflow-hidden rounded-md bg-muted" aria-hidden="true">
		{#if (is_draft(file) || href(file) !== undefined) && mime(file).startsWith('image/') && !failed_images.has(file)}
			<img {@attach media_source(file)} alt="" width="40" height="40" loading="lazy" decoding="async" class="size-full object-cover" onerror={() => failed_images.add(file)} />
		{:else}<Icon name={icon(file)} class="size-5 text-muted-foreground" />{/if}
	</span>
	<span class="grid min-w-0 gap-0.5 text-left">
		<span class="truncate text-xs font-medium" title={file.name}>{file.name}</span>
		<span class="text-tiny text-muted-foreground">{label(file)}</span>
	</span>
{/snippet}

<div class={rail ? 'grid min-w-0 gap-1' : on_remove !== undefined ? 'flex min-w-0 flex-nowrap gap-2 overflow-x-auto py-2' : 'mt-2 flex min-w-0 max-w-full flex-wrap items-start gap-2'} data-attachments>
	{#each files as file (file)}
		{@const url = href(file)}
		{@const image = mime(file).startsWith('image/')}
		<div class={rail ? 'flex min-w-0 items-center gap-2' : 'relative max-w-full shrink-0'} data-attachment={file.name}>
			{#if !rail && image && previewable(file) && !failed_images.has(file)}
				<button type="button" class="block overflow-hidden rounded-lg border border-border bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none" aria-label={`${t('Preview')} ${file.name}`} title={file.name} onclick={() => open(file)}>
					<img {@attach media_source(file)} alt={file.name} loading="lazy" decoding="async" class={is_draft(file) ? 'h-16 w-20 object-cover' : 'h-24 w-36 object-cover'} onerror={() => failed_images.add(file)} />
				</button>
			{:else if previewable(file)}
				<button type="button" class="flex min-w-0 items-center gap-2 rounded-lg text-left hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none {rail ? 'flex-1 py-1.5' : 'w-48 max-w-full border border-border p-2 pr-7'}" aria-label={`${t('Preview')} ${file.name}`} onclick={() => open(file)}>
					{@render file_label(file)}
				</button>
			{:else if url !== undefined}
				<a href={url} target="_blank" rel="noreferrer" download={file.name} class="flex min-w-0 items-center gap-2 rounded-lg hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none {rail ? 'flex-1 py-1.5' : 'w-48 max-w-full border border-border p-2'}" aria-label={`${t('Download')} ${file.name}`}>
					{@render file_label(file)}
				</a>
			{:else}
				<span class="flex min-w-0 items-center gap-2 {rail ? 'flex-1 py-1.5' : 'w-48 max-w-full rounded-lg border border-border p-2 pr-7'}">{@render file_label(file)}</span>
			{/if}
			{#if on_remove !== undefined}
				<button type="button" class="absolute top-0.5 right-0.5 grid size-6 pointer-coarse:size-11 place-items-center rounded-md bg-background/90 text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none" aria-label={`${t('Remove')} ${file.name}`} title={`${t('Remove')} ${file.name}`} onclick={() => on_remove?.(file)}><Icon name="lucide:x" class="size-3.5" /></button>
			{:else if url !== undefined && (rail || previewable(file))}
				<a href={url} target="_blank" rel="noreferrer" download={file.name} class="grid shrink-0 place-items-center rounded-md text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none {rail ? 'size-8 pointer-coarse:size-11 hover:bg-muted' : 'absolute right-1 bottom-1 size-6 pointer-coarse:size-11 bg-background/90'}" aria-label={`${t('Download')} ${file.name}`} title={t('Download')}><Icon name="lucide:download" class="size-3.5" /></a>
			{/if}
		</div>
	{/each}
</div>

<Dialog.Root open={shown !== null} on_open_change={(open) => { if (!open) shown = null; }}>
	<Dialog.Content class="{shown !== null && mime(shown) === 'application/pdf' ? 'w-[calc(100vw-2rem)] max-w-4xl' : 'w-auto max-w-[calc(100vw-2rem)]'} gap-2 p-3 pt-10">
		{#if shown !== null}
			{@const file = shown}
			<Dialog.Title class="sr-only">{file.name}</Dialog.Title>
			{#if preview_error}<p role="alert" class="p-4 text-sm text-muted-foreground">{t('This preview could not load. Download the file to open it.')}</p>
			{:else if mime(file) === 'application/pdf'}
				<iframe {@attach media_source(file, true)} title={file.name} class="h-[75dvh] w-full rounded border-0 bg-background"></iframe>
			{:else}<img {@attach media_source(file, true)} alt={file.name} class="max-h-[calc(100dvh-9rem)] max-w-full rounded object-contain" onerror={() => preview_error = true} />{/if}
			<a href={href(file)} {@attach download_source(file)} target="_blank" rel="noreferrer" download={file.name} class="flex min-w-0 items-center gap-2 rounded px-1 py-1 text-xs text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"><span class="min-w-0 truncate">{file.name}</span><Icon name="lucide:download" class="ml-auto size-4 shrink-0" /><span>{t('Download')}</span></a>
		{/if}
	</Dialog.Content>
</Dialog.Root>
