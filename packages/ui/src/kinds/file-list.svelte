<!--
@component
Files already uploaded share one preview control. Pending uploads have their own retry and dismiss chips.
The add control sits at the end.
-->
<script lang="ts" module>
	import type { FileRef } from './kind.js';

	/** An upload in flight (`error` absent) or failed (retry or dismiss). */
	export type PendingFile = { key: number; file: File; error?: string };
</script>

<script lang="ts">
	import Icon from '@iconify/svelte';
	import type { Snippet } from 'svelte';
	import Spinner from '../primitives/spinner/spinner.svelte';
	import { cn, uiText } from '../primitives/utils.js';
	import FileCollection from './file-collection.svelte';

	let {
		refs,
		pending = [],
		onRemove,
		onRetry,
		onDismiss,
		disabled = false,
		class: className,
		children
	}: {
		refs: readonly FileRef[];
		pending?: readonly PendingFile[];
		onRemove?(ref: FileRef): void;
		onRetry?(p: PendingFile): void;
		onDismiss?(p: PendingFile): void;
		disabled?: boolean;
		class?: string;
		children?: Snippet;
	} = $props();
	const t = uiText();
	const CHIP =
		'inline-flex h-7 max-w-48 min-w-0 items-center gap-1.5 rounded-sm border border-border bg-muted/50 px-2 text-xs font-medium';
	const ICON_BUTTON =
		'grid size-5 shrink-0 place-items-center rounded-sm text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50';
</script>

<span class={cn('flex min-w-0 flex-wrap items-center gap-1', className)}>
	{#each pending as p (p.key)}
		<span
			class={cn(CHIP, p.error !== undefined && 'border-destructive/40 text-destructive')}
			title={p.error ?? t('uploading')}
		>
			{#if p.error === undefined}<Spinner class="size-3 shrink-0" />{:else}<Icon
					icon="lucide:circle-alert"
					class="size-3.5 shrink-0"
				/>{/if}
			<span class="truncate">{p.file.name}</span>
			{#if p.error !== undefined}
				{#if onRetry}<button
						type="button"
						class={ICON_BUTTON}
						aria-label={`${t('retry')} ${p.file.name}`}
						title={t('retry')}
						{disabled}
						onclick={() => onRetry(p)}><Icon icon="lucide:refresh-cw" class="size-3" /></button
					>{/if}
				{#if onDismiss}<button
						type="button"
						class={ICON_BUTTON}
						aria-label={`${t('remove')} ${p.file.name}`}
						title={t('remove')}
						onclick={() => onDismiss(p)}><Icon icon="lucide:x" class="size-3" /></button
					>{/if}
			{/if}
		</span>
	{/each}
	{#each shown as ref (ref.id)}
		{@const url = host.file_url?.(ref, { preview: 64 })}
		<Popover.Root open={open === ref.id} onOpenChange={(o) => (open = o ? ref.id : null)}>
			<Popover.Trigger>
				{#snippet child({ props })}
					<button
						{...props}
						type="button"
						class={cn(
							CHIP,
							'hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none'
						)}
						title={ref.name}
						data-file-chip
					>
						{#if ref.mime.startsWith('image/') && url !== undefined}
							<Image
								src={url}
								alt=""
								width={16}
								height={16}
								class="size-4 shrink-0 rounded-xs"
								imageClass="size-full object-cover"
							/>
						{:else}
							<Icon icon={fileIcon(ref.mime)} class="size-3.5 shrink-0 text-muted-foreground" />
						{/if}
						<span class="truncate">{ref.name}</span>
					</button>
				{/snippet}
			</Popover.Trigger>
			<Popover.Content
				class="w-80 max-w-[calc(100vw-2rem)] p-3"
				align="start"
				aria-label={`${t('preview')} ${ref.name}`}
				onCloseAutoFocus={() => {}}
			>
				<FilePreview
					file={ref}
					onRemove={onRemove && !disabled
						? () => {
								open = null;
								onRemove(ref);
							}
						: undefined}
				/>
			</Popover.Content>
		</Popover.Root>
	{/each}
	{#if refs.length > shown.length}<span class="shrink-0 text-xs text-muted-foreground"
			>+{refs.length - shown.length}</span
		>{/if}
	{@render children?.()}
</span>
