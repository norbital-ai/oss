<!--
@component
A stored file's popover body: its content where the browser can show it (an image, a PDF's first page, a text file's
first lines, else its type's icon), its name, size, type, who uploaded it and when and its SHA-256 (read from `sys_file`
when the host reads), Download, and Remove when `onRemove` is given.
-->
<script lang="ts">
	import Icon from '@iconify/svelte';
	import Button from '../primitives/button/button.svelte';
	import { formatFileSize, uiText } from '../primitives/utils.js';
	import { useKinds } from './context.js';
	import { fileIcon } from './file-list.svelte';
	import type { FileRef, Json } from './kind.js';

	let { file, onRemove }: { file: FileRef; onRemove?(): void } = $props();
	const host = useKinds();
	const t = uiText();
	const url = $derived(host.fileUrl?.(file));
	const text = $derived(/^text\/|^application\/(json|xml|csv)/.test(file.mime));
	type Row = { readonly [f: string]: Json };
	const one = (collection: string, id: string, fields: readonly string[]): Promise<Row | undefined> =>
		Promise.resolve(host.read!(collection, { select: Object.fromEntries(fields.map((f) => [f, true])), limit: 1, where: { id: { eq: id } } })).then((p) => p.rows[0]);
	// the stored row's provenance and digest when this caller may read it; nothing (never an error) when not
	const meta = $derived(host.read === undefined ? Promise.resolve(null) : one('sys_file', file.id, ['size', 'sha256', 'created_at', 'created_by']).then(async (row) => {
		if (row === undefined) return null;
		const by = typeof row['created_by'] === 'string' ? await one('sys_user', row['created_by'], ['name', 'email']).catch(() => undefined) : undefined;
		return { size: typeof row['size'] === 'number' ? row['size'] : null, sha256: typeof row['sha256'] === 'string' && row['sha256'] !== '' ? row['sha256'] : null, at: when(row['created_at']),
			by: typeof (by?.['name'] ?? by?.['email']) === 'string' ? String(by?.['name'] ?? by?.['email']) : null };
	}, () => null));
	const when = (v: Json | undefined) => {
		const d = typeof v === 'string' ? new Date(v) : null;
		return d === null || Number.isNaN(d.getTime()) ? null
			: new Intl.DateTimeFormat(host.locale, { dateStyle: 'medium', timeStyle: 'short', ...(host.zone === undefined ? {} : { timeZone: host.zone }) }).format(d);
	};
	// the first lines only: one chunk of the stream, then cancelled
	async function head(u: string): Promise<string> {
		const res = await fetch(u, { credentials: 'same-origin' });
		const reader = res.body!.getReader();
		const { value } = await reader.read();
		void reader.cancel();
		return new TextDecoder().decode(value ?? new Uint8Array()).split(/\r?\n/).slice(0, 12).join('\n');
	}
</script>

<div class="grid min-w-0 gap-3" data-file-preview>
	<div class="grid min-h-24 place-items-center overflow-hidden rounded-md bg-muted">
		{#if url !== undefined && file.mime.startsWith('image/')}
			<img src={url} alt={file.name} class="max-h-60 w-full object-contain" />
		{:else if url !== undefined && file.mime === 'application/pdf'}
			<iframe src={`${url}#page=1&view=FitH`} title={file.name} class="h-64 w-full border-0 bg-background"></iframe>
		{:else if url !== undefined && text}
			{#await head(url)}
				<Icon icon={fileIcon(file.mime)} class="size-8 text-muted-foreground" />
			{:then lines}
				<pre class="max-h-60 w-full overflow-auto p-2 text-xs leading-snug">{lines}</pre>
			{:catch}
				<Icon icon={fileIcon(file.mime)} class="size-8 text-muted-foreground" />
			{/await}
		{:else}
			<Icon icon={fileIcon(file.mime)} class="size-8 text-muted-foreground" />
		{/if}
	</div>
	<p class="truncate text-sm font-medium" title={file.name}>{file.name}</p>
	<dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
		{#if file.size !== undefined}<dt class="text-muted-foreground">{t('fileSize')}</dt><dd>{formatFileSize(file.size)}</dd>{/if}
		<dt class="text-muted-foreground">{t('fileType')}</dt><dd class="truncate">{file.mime}</dd>
		{#await meta then m}
			{#if file.size === undefined && m?.size != null}<dt class="text-muted-foreground">{t('fileSize')}</dt><dd>{formatFileSize(m.size)}</dd>{/if}
			{#if m?.at}<dt class="text-muted-foreground">{t('uploaded')}</dt><dd>{m.at}</dd>{/if}
			{#if m?.by}<dt class="text-muted-foreground">{t('uploadedBy')}</dt><dd class="truncate">{m.by}</dd>{/if}
			{#if m?.sha256}<dt class="text-muted-foreground">SHA-256</dt><dd class="truncate font-mono select-all" title={m.sha256}>{m.sha256}</dd>{/if}
		{/await}
	</dl>
	{#if url !== undefined || onRemove}
		<div class="flex items-center gap-2">
			{#if url !== undefined}
				<Button variant="outline" size="sm" href={url} download={file.name} target="_blank" rel="noopener"><Icon icon="lucide:download" class="size-3.5" />{t('download')}</Button>
			{/if}
			{#if onRemove}
				<Button variant="ghost" size="sm" class="ml-auto text-destructive hover:bg-destructive/10 hover:text-destructive" onclick={onRemove}><Icon icon="lucide:trash-2" class="size-3.5" />{t('remove')}</Button>
			{/if}
		</div>
	{/if}
</div>
