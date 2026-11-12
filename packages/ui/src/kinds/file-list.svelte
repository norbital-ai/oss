<!--
@component
Files already uploaded share one preview control. Pending uploads have their own retry and dismiss chips.
The add control sits at the end.
-->
<script lang="ts" module>
	import type { UiContext } from '../client/contract.js';
	import type { FileRef } from './kind.js';

	/** An upload in flight (`error` absent) or failed (retry or dismiss). */
	export type PendingFile = { key: number; file: File; error?: string };
</script>

<script lang="ts">
	import Icon from '@iconify/svelte';
	import type { Snippet } from 'svelte';
	import Spinner from '../primitives/spinner/spinner.svelte';
	import { cn, ui_text } from '../primitives/utils.js';
	import FileCollection from './file-collection.svelte';

	let {
		ctx,
		refs,
		pending = [],
		on_remove,
		on_retry,
		on_dismiss,
		disabled = false,
		class: className,
		children
	}: {
		ctx: UiContext;
		refs: readonly FileRef[];
		pending?: readonly PendingFile[];
		on_remove?(ref: FileRef): void;
		on_retry?(p: PendingFile): void;
		on_dismiss?(p: PendingFile): void;
		disabled?: boolean;
		class?: string;
		children?: Snippet;
	} = $props();
	const t = ui_text();
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
				{#if on_retry}<button
						type="button"
						class={ICON_BUTTON}
						aria-label={`${t('retry')} ${p.file.name}`}
						title={t('retry')}
						{disabled}
						onclick={() => on_retry(p)}><Icon icon="lucide:refresh-cw" class="size-3" /></button
					>{/if}
				{#if on_dismiss}<button
						type="button"
						class={ICON_BUTTON}
						aria-label={`${t('remove')} ${p.file.name}`}
						title={t('remove')}
						onclick={() => on_dismiss(p)}><Icon icon="lucide:x" class="size-3" /></button
					>{/if}
			{/if}
		</span>
	{/each}
	{#if refs.length}<FileCollection {ctx} {refs} on_remove={disabled ? undefined : on_remove} />{/if}
	{@render children?.()}
</span>
