<!--
@component
Stored files as rows: a thumbnail (an image's own, else its type's icon), name and size, download, and an image preview.
`onRemove` adds a remove button; `pending` rows show uploads in flight or failed.
-->
<script lang="ts" module>
	import type { FileRef } from './kind.js';

	/** An upload in flight (`error` absent) or failed (retry or dismiss). */
	export type PendingFile = { key: number; file: File; error?: string };
	/** A file's icon by its MIME type. */
	export const fileIcon = (mime: string) =>
		mime.startsWith('image/') ? 'lucide:image' : mime === 'application/pdf' ? 'lucide:file-text'
		: mime.includes('spreadsheet') || mime.includes('excel') || mime === 'text/csv' ? 'lucide:file-spreadsheet'
		: mime.startsWith('audio/') ? 'lucide:file-audio' : mime.startsWith('video/') ? 'lucide:file-video'
		: mime.startsWith('text/') ? 'lucide:file-text' : 'lucide:file';
</script>

<script lang="ts">
	import Icon from '@iconify/svelte';
	import * as Dialog from '../primitives/dialog/index.js';
	import Spinner from '../primitives/spinner/spinner.svelte';
	import { cn, formatFileSize, uiText } from '../primitives/utils.js';
	import { useKinds } from './context.js';

	let { refs, pending = [], onRemove, onRetry, onDismiss, disabled = false, class: className }: {
		refs: readonly FileRef[];
		pending?: readonly PendingFile[];
		onRemove?(ref: FileRef): void;
		onRetry?(p: PendingFile): void;
		onDismiss?(p: PendingFile): void;
		disabled?: boolean;
		class?: string;
	} = $props();
	const host = useKinds();
	const t = uiText();
	let previewing = $state<FileRef | null>(null);
	const ROW = 'flex min-w-0 items-center gap-2 rounded-md border border-border bg-background p-2';
	const ICON_BUTTON = 'grid size-7 shrink-0 place-items-center rounded-sm text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50';
</script>

<ul class={cn('grid min-w-0 gap-1.5', className)}>
	{#each pending as p (p.key)}
		<li class={ROW}>
			<span class="grid size-8 shrink-0 place-items-center rounded bg-muted"><Icon icon={fileIcon(p.file.type)} class="size-4 text-muted-foreground" /></span>
			<span class="grid min-w-0 flex-1">
				<span class="truncate text-sm font-medium">{p.file.name}</span>
				<span class="flex min-w-0 items-center gap-1.5 text-meta">
					{formatFileSize(p.file.size)} ·
					{#if p.error === undefined}
						<span class="inline-flex items-center gap-1 text-brand"><Spinner class="size-3" />{t('uploading')}</span>
					{:else}
						<span class="inline-flex min-w-0 items-center gap-1 text-destructive" title={p.error}><Icon icon="lucide:circle-alert" class="size-3 shrink-0" /><span class="truncate">{p.error}</span></span>
					{/if}
				</span>
			</span>
			{#if p.error !== undefined}
				{#if onRetry}<button type="button" class={ICON_BUTTON} aria-label={t('retry')} title={t('retry')} {disabled} onclick={() => onRetry(p)}><Icon icon="lucide:refresh-cw" class="size-3.5" /></button>{/if}
				{#if onDismiss}<button type="button" class={ICON_BUTTON} aria-label={t('remove')} title={t('remove')} onclick={() => onDismiss(p)}><Icon icon="lucide:x" class="size-3.5" /></button>{/if}
			{/if}
		</li>
	{/each}
	{#each refs as ref (ref.id)}
		{@const url = host.fileUrl?.(ref)}
		{@const image = ref.mime.startsWith('image/') && url !== undefined}
		<li class={ROW}>
			{#if image}
				<button type="button" class="size-8 shrink-0 overflow-hidden rounded outline-none focus-visible:ring-2 focus-visible:ring-ring/50" aria-label={`${t('preview')} ${ref.name}`} onclick={() => (previewing = ref)}>
					<img src={url} alt="" loading="lazy" class="size-full object-cover" />
				</button>
			{:else}
				<span class="grid size-8 shrink-0 place-items-center rounded bg-muted"><Icon icon={fileIcon(ref.mime)} class="size-4 text-muted-foreground" /></span>
			{/if}
			<span class="grid min-w-0 flex-1">
				{#if url !== undefined}
					<a class="truncate text-sm font-medium underline-offset-2 hover:underline" href={url} target="_blank" rel="noopener">{ref.name}</a>
				{:else}
					<span class="truncate text-sm font-medium">{ref.name}</span>
				{/if}
				{#if ref.size !== undefined}<span class="text-meta">{formatFileSize(ref.size)}</span>{/if}
			</span>
			{#if url !== undefined}
				<a class={ICON_BUTTON} href={url} download={ref.name} target="_blank" rel="noopener" aria-label={`${t('download')} ${ref.name}`} title={t('download')}><Icon icon="lucide:download" class="size-3.5" /></a>
			{/if}
			{#if onRemove}
				<button type="button" class={cn(ICON_BUTTON, 'hover:bg-destructive/10 hover:text-destructive')} aria-label={`${t('remove')} ${ref.name}`} title={t('remove')} {disabled} onclick={() => onRemove(ref)}>
					<Icon icon="lucide:x" class="size-3.5" />
				</button>
			{/if}
		</li>
	{/each}
</ul>

<Dialog.Root open={previewing !== null} onOpenChange={(open) => { if (!open) previewing = null; }}>
	{#if previewing !== null}
		{@const url = host.fileUrl?.(previewing)}
		<Dialog.Content class="max-w-[min(56rem,calc(100vw-2rem))] gap-3 p-4">
			<Dialog.Title class="truncate pr-8 text-sm">{previewing.name}</Dialog.Title>
			{#if url !== undefined}
				<img src={url} alt={previewing.name} class="max-h-[70dvh] w-full rounded-md bg-muted object-contain" />
				<a class="inline-flex items-center gap-1.5 justify-self-start text-sm underline-offset-2 hover:underline" href={url} download={previewing.name} target="_blank" rel="noopener">
					<Icon icon="lucide:download" class="size-4" />{t('download')}
				</a>
			{/if}
		</Dialog.Content>
	{/if}
</Dialog.Root>
