<!--
	What tool steps made (a screenshot, a document, a sandbox output), outside their fold, the agent panel's and each
	sub-agent's: a stored image is a small thumbnail that opens full size in a dialog (fit to the viewport; Escape or the
	backdrop closes it) with its download in the corner; any other file is a chip that downloads it.
-->
<script lang="ts">
	import { Dialog, Icon } from '@norbital-ai/ui';
	import type { AgentRow } from '../../protocol/wire.ts';

	let {
		files,
		fileHref,
		t
	}: {
		files: readonly NonNullable<AgentRow['files']>[number][];
		fileHref: (id: string) => string;
		t: (key: string) => string;
	} = $props();

	/** The image open full size. */
	let shown = $state<{ name: string; href: string } | null>(null);
</script>

<div class="mt-2 flex flex-wrap items-end gap-2" data-made-files>
	{#each files as f, i (i)}
		{@const href = f.id === undefined ? undefined : fileHref(f.id)}
		{#if href !== undefined && f.mime.startsWith('image/')}
			<span class="relative inline-block" data-made-file={f.name}>
				<button
					type="button"
					class="block overflow-hidden rounded-lg border border-border focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
					title={f.name}
					onclick={() => (shown = { name: f.name, href })}
					data-made-image
					><img
						src={`${href}?preview=512`}
						alt={f.name}
						class="block h-20 w-28 object-cover object-top"
					/></button
				>
				<a
					{href}
					target="_blank"
					rel="noreferrer"
					download={f.name}
					class="absolute right-1 bottom-1 grid size-6 place-items-center rounded-md bg-background/90 text-muted-foreground shadow-xs hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
					aria-label={`${t('Download')} ${f.name}`}
					title={t('Download')}><Icon name="lucide:download" class="size-3.5" /></a
				>
			</span>
		{:else}
			<a
				{href}
				target="_blank"
				rel="noreferrer"
				download={f.name}
				class="inline-flex max-w-full items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
				data-made-file={f.name}
			>
				<Icon
					name={f.mime.startsWith('image/')
						? 'lucide:image'
						: f.mime.includes('presentation')
							? 'lucide:presentation'
							: f.mime.includes('sheet') || f.mime.includes('csv')
								? 'lucide:sheet'
								: 'lucide:file-text'}
					class="size-4 shrink-0 text-muted-foreground"
				/>
				<span class="min-w-0 truncate font-medium">{f.name}</span>
				<Icon name="lucide:download" class="size-3.5 shrink-0 text-muted-foreground" />
			</a>
		{/if}
	{/each}
</div>

<Dialog.Root
	open={shown !== null}
	onOpenChange={(o) => {
		if (!o) shown = null;
	}}
>
	<Dialog.Content class="w-auto max-w-[calc(100vw-2rem)] gap-2 p-2 pt-10">
		{#if shown !== null}
			<Dialog.Title class="sr-only">{shown.name}</Dialog.Title>
			<img
				src={shown.href}
				alt={shown.name}
				class="max-h-[calc(100dvh-6rem)] max-w-full rounded object-contain"
				data-made-image-full
			/>
		{/if}
	</Dialog.Content>
</Dialog.Root>
