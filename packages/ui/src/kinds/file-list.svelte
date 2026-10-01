<!--
@component
Files as compact chips: an icon (an image's own thumbnail) and the truncated name. A chip is a button opening a popover
with the file's preview, metadata and Download; `onRemove` adds Remove there. `pending` chips show uploads in flight or
failed (retry, dismiss); `dense` shows the first chip and how many more; `children` ends the row (the field's "+").
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
	import type { Snippet } from 'svelte';
	import * as Popover from '../primitives/popover/index.js';
	import Spinner from '../primitives/spinner/spinner.svelte';
	import { cn, uiText } from '../primitives/utils.js';
	import { useKinds } from './context.js';
	import FilePreview from './file-preview.svelte';

	let { refs, pending = [], onRemove, onRetry, onDismiss, disabled = false, dense = false, class: className, children }: {
		refs: readonly FileRef[];
		pending?: readonly PendingFile[];
		onRemove?(ref: FileRef): void;
		onRetry?(p: PendingFile): void;
		onDismiss?(p: PendingFile): void;
		disabled?: boolean;
		dense?: boolean;
		class?: string;
		children?: Snippet;
	} = $props();
	const host = useKinds();
	const t = uiText();
	const shown = $derived(dense ? refs.slice(0, 1) : refs);
	let open = $state<string | null>(null);
	const CHIP = 'inline-flex h-7 max-w-48 min-w-0 items-center gap-1.5 rounded-sm border border-border bg-muted/50 px-2 text-xs font-medium';
	const ICON_BUTTON = 'grid size-5 shrink-0 place-items-center rounded-sm text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50';
</script>

<span class={cn('flex min-w-0 flex-wrap items-center gap-1', dense && 'flex-nowrap', className)}>
	{#each pending as p (p.key)}
		<span class={cn(CHIP, p.error !== undefined && 'border-destructive/40 text-destructive')} title={p.error ?? t('uploading')}>
			{#if p.error === undefined}<Spinner class="size-3 shrink-0" />{:else}<Icon icon="lucide:circle-alert" class="size-3.5 shrink-0" />{/if}
			<span class="truncate">{p.file.name}</span>
			{#if p.error !== undefined}
				{#if onRetry}<button type="button" class={ICON_BUTTON} aria-label={`${t('retry')} ${p.file.name}`} title={t('retry')} {disabled} onclick={() => onRetry(p)}><Icon icon="lucide:refresh-cw" class="size-3" /></button>{/if}
				{#if onDismiss}<button type="button" class={ICON_BUTTON} aria-label={`${t('remove')} ${p.file.name}`} title={t('remove')} onclick={() => onDismiss(p)}><Icon icon="lucide:x" class="size-3" /></button>{/if}
			{/if}
		</span>
	{/each}
	{#each shown as ref (ref.id)}
		{@const url = host.fileUrl?.(ref)}
		<Popover.Root open={open === ref.id} onOpenChange={(o) => (open = o ? ref.id : null)}>
			<Popover.Trigger>
				{#snippet child({ props })}
					<button {...props} type="button" class={cn(CHIP, 'hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none')} title={ref.name} data-file-chip>
						{#if ref.mime.startsWith('image/') && url !== undefined}
							<img src={url} alt="" loading="lazy" class="size-4 shrink-0 rounded-xs object-cover" />
						{:else}
							<Icon icon={fileIcon(ref.mime)} class="size-3.5 shrink-0 text-muted-foreground" />
						{/if}
						<span class="truncate">{ref.name}</span>
					</button>
				{/snippet}
			</Popover.Trigger>
			<Popover.Content class="w-80 max-w-[calc(100vw-2rem)] p-3" align="start" aria-label={`${t('preview')} ${ref.name}`} onCloseAutoFocus={() => {}}>
				<FilePreview file={ref} onRemove={onRemove && !disabled ? () => { open = null; onRemove(ref); } : undefined} />
			</Popover.Content>
		</Popover.Root>
	{/each}
	{#if refs.length > shown.length}<span class="shrink-0 text-xs text-muted-foreground">+{refs.length - shown.length}</span>{/if}
	{@render children?.()}
</span>
