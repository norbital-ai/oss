<!--
@component
Stored files behind one compact trigger: up to three thumbnails and the name or count. Its popover lists the files a page
at a time; picking one shows its preview with Download, and Remove when `on_remove` is given.
-->
<script lang="ts">
	import type { UiContext } from '../client/contract.js';
	import Icon from '@iconify/svelte';
	import { tick } from 'svelte';
	import Button from '../primitives/button/button.svelte';
	import Image from '../primitives/image/image.svelte';
	import * as Popover from '../primitives/popover/index.js';
	import { ui_text } from '../primitives/utils.js';
	import FilePreview from './file-preview.svelte';
	import { file_icon, type FileRef } from './kind.js';

	let { ctx, refs, on_remove }: { ctx: UiContext; refs: readonly FileRef[]; on_remove?: (ref: FileRef) => void } =
		$props();
	const host = $derived(ctx.ui.kinds);
	const t = ui_text();
	const pageSize = 6;
	let pageIndex = $state(0);
	let selected = $state<string | null>(null);
	let open = $state(false);
	let back = $state<HTMLButtonElement | null>(null);
	let list = $state<HTMLElement>();
	const pageCount = $derived(Math.max(1, Math.ceil(refs.length / pageSize)));
	const page = $derived(Math.min(pageIndex, pageCount - 1));
	const active = $derived(refs.length === 1 ? refs[0] : refs.find((ref) => ref.id === selected));
	const label = $derived(
		refs.length === 1 && refs[0] ? refs[0].name : t('fileCount').replace('{n}', String(refs.length))
	);

	async function preview(ref: FileRef) {
		selected = ref.id;
		await tick();
		back?.focus();
	}

	async function returnToList() {
		const previous = selected;
		selected = null;
		await tick();
		Array.from(list?.querySelectorAll<HTMLButtonElement>('button[data-file-option]') ?? [])
			.find((button) => button.dataset.fileOption === previous)
			?.focus();
	}
</script>

{#snippet thumbnail(ref: FileRef)}
	{@const url = host.file_url?.(ref, { preview: 64 })}
	<span class="grid size-5 shrink-0 place-items-center overflow-hidden rounded-sm bg-muted">
		{#if ref.mime.startsWith('image/') && url !== undefined}
			<Image
				src={url}
				alt=""
				width={20}
				height={20}
				class="size-full"
				image_class="size-full object-cover"
			/>
		{:else}
			<Icon icon={file_icon(ref.mime)} class="size-3.5 text-muted-foreground" />
		{/if}
	</span>
{/snippet}

<Popover.Root
	bind:open
	on_open_change={(open) => {
		if (!open) {
			pageIndex = 0;
			selected = null;
		}
	}}
>
	<Popover.Trigger
		class="inline-flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-sm border border-border bg-muted/50 px-1.5 text-xs font-medium outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50"
		title={label}
		data-file-collection
		onclick={(event: MouseEvent) => event.stopPropagation()}
	>
		<span class="flex shrink-0 -space-x-1" aria-hidden="true">
			{#each refs.slice(0, 3) as ref (ref.id)}
				{@render thumbnail(ref)}
			{/each}
		</span>
		<span class="truncate">{label}</span>
		{#if refs.length > 1}<Icon
				icon="lucide:chevron-down"
				class="size-3 shrink-0 text-muted-foreground"
			/>{/if}
	</Popover.Trigger>
	<Popover.Content align="start" class="w-80 max-w-[calc(100vw-2rem)] p-3" aria-label={label}>
		{#if active}
			{#if refs.length > 1}
				<Button bind:ref={back} variant="ghost" class="mb-2" onclick={returnToList}>
					<Icon icon="lucide:arrow-left" class="size-4" />
					{t('back')}
				</Button>
			{/if}
			<FilePreview {ctx}
				file={active}
				on_remove={on_remove
					? () => {
							open = false;
							on_remove(active);
						}
					: undefined}
			/>
		{:else}
			<ul bind:this={list} class="grid gap-0.5">
				{#each refs.slice(page * pageSize, (page + 1) * pageSize) as ref (ref.id)}
					<li class="min-w-0">
						<Button
							variant="ghost"
							class="w-full justify-start px-1.5"
							title={ref.name}
							data-file-option={ref.id}
							onclick={() => preview(ref)}
						>
							{@render thumbnail(ref)}
							<span class="truncate">{ref.name}</span>
						</Button>
					</li>
				{/each}
			</ul>
			{#if pageCount > 1}
				<div class="mt-2 flex items-center justify-between gap-2 border-t border-border pt-2">
					<Button
						variant="ghost"
						size="icon"
						disabled={page === 0}
						aria-label={t('previous')}
						onclick={() => (pageIndex = page - 1)}
					>
						<Icon icon="lucide:chevron-left" class="size-4" />
					</Button>
					<span class="text-xs tabular-nums text-muted-foreground" aria-live="polite"
						>{page + 1} / {pageCount}</span
					>
					<Button
						variant="ghost"
						size="icon"
						disabled={page + 1 === pageCount}
						aria-label={t('next')}
						onclick={() => (pageIndex = page + 1)}
					>
						<Icon icon="lucide:chevron-right" class="size-4" />
					</Button>
				</div>
			{/if}
		{/if}
	</Popover.Content>
</Popover.Root>
