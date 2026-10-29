<!--
@component
A stored file's popover body: its content where the browser can show it (an image, a PDF's first page, a text file's
first lines, else its type's icon), its name, size, type, who uploaded it and when and its SHA-256 (read from `sys_file`
when the host reads), Download, and Remove when `onRemove` is given.
-->
<script lang="ts">
	import Icon from '@iconify/svelte';
	import { Effect, Stream } from 'effect';
	import { FetchHttpClient, HttpClient } from 'effect/http';
	import { observeOnce } from '../effect/index.js';
	import type { ReadError } from '../client/contract.js';
	import type { Row } from '../model/types.js';
	import { byId } from '../read/request.js';
	import { withOutputs } from '../client/context.js';
	import Button from '../primitives/button/button.svelte';
	import Image from '../primitives/image/image.svelte';
	import { formatFileSize, uiText } from '../primitives/utils.js';
	import { useKinds } from './context.js';
	import { fileIcon } from './file-list.svelte';
	import type { FileRef, Value } from './kind.js';

	let { file, onRemove }: { file: FileRef; onRemove?(): void } = $props();
	const host = useKinds();
	const t = uiText();
	const url = $derived(host.fileUrl?.(file));
	const imageUrl = $derived(host.fileUrl?.(file, { preview: 512 }));
	const text = $derived(/^text\/|^application\/(json|xml|csv)/.test(file.mime));
	const one = (
		model: string,
		id: string,
		fields: readonly string[]
	): Effect.Effect<Row | undefined, ReadError> => {
		const read = host.query;
		return read === undefined
			? Effect.succeed(undefined)
			: read(withOutputs(byId(model, id, fields), host.catalog)).pipe(
					Effect.map((answer) => answer[model]?.rows[0])
				);
	};
	// only the fields the caller's `sys_file` output reads (a `meta` holder reads none of these)
	const details = $derived(
		['size', 'sha256', 'created_at', 'created_by'].filter(
			(f) => host.catalog === undefined || host.catalog['sys_file']?.fields[f] !== undefined
		)
	);
	const meta = observeOnce(() =>
		host.query === undefined || details.length === 0
			? null
			: Effect.gen(function* () {
					const row = yield* one('sys_file', file.id, details);
					if (row === undefined) return null;
					const by =
						typeof row['created_by'] === 'string'
							? yield* one('sys_user', row['created_by'], ['name', 'email']).pipe(
									Effect.catch((error) => Effect.logWarning(error).pipe(Effect.as(undefined)))
								)
							: undefined;
					return {
						size: typeof row['size'] === 'number' ? row['size'] : null,
						sha256:
							typeof row['sha256'] === 'string' && row['sha256'] !== '' ? row['sha256'] : null,
						at: when(row['created_at']),
						by:
							typeof (by?.['name'] ?? by?.['email']) === 'string'
								? String(by?.['name'] ?? by?.['email'])
								: null
					};
				}).pipe(Effect.catch((error) => Effect.logWarning(error).pipe(Effect.as(null))))
	);
	const m = $derived(meta.current);
	const when = (v: Value | undefined) => {
		const d = typeof v === 'string' ? new Date(v) : null;
		return d === null || Number.isNaN(d.getTime())
			? null
			: new Intl.DateTimeFormat(host.locale, {
					dateStyle: 'medium',
					timeStyle: 'short',
					...(host.zone === undefined ? {} : { timeZone: host.zone })
				}).format(d);
	};
	// Reading one chunk closes the response stream when its preview leaves.
	const content = observeOnce(() =>
		url === undefined || !text
			? null
			: HttpClient.get(url).pipe(
					Effect.flatMap((response) =>
						response.stream.pipe(Stream.take(1), Stream.decodeText(), Stream.mkString)
					),
					Effect.map((chunk) => chunk.split(/\r?\n/).slice(0, 12).join('\n')),
					Effect.provide(FetchHttpClient.layer)
				)
	);
</script>

<div class="grid min-w-0 gap-3" data-file-preview>
	<div class="grid min-h-24 place-items-center overflow-hidden rounded-md bg-muted">
		{#if url !== undefined && file.mime.startsWith('image/')}
			<Image
				src={imageUrl}
				alt={file.name}
				loading="eager"
				class="min-h-24 w-full"
				imageClass="max-h-60 min-h-24 w-full object-contain"
			/>
		{:else if url !== undefined && file.mime === 'application/pdf'}
			<iframe
				src={`${url}#page=1&view=FitH`}
				title={file.name}
				class="h-64 w-full border-0 bg-background"
			></iframe>
		{:else if url !== undefined && text}
			{#if content.loading || content.error !== undefined}<Icon
					icon={fileIcon(file.mime)}
					class="size-8 text-muted-foreground"
				/>
			{:else}<pre class="max-h-60 w-full overflow-auto p-2 text-xs leading-snug">{content.current ??
						''}</pre>{/if}
		{:else}
			<Icon icon={fileIcon(file.mime)} class="size-8 text-muted-foreground" />
		{/if}
	</div>
	<p class="truncate text-sm font-medium" title={file.name}>{file.name}</p>
	<dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
		{#if file.size !== undefined}<dt class="text-muted-foreground">{t('fileSize')}</dt>
			<dd>{formatFileSize(file.size)}</dd>{/if}
		<dt class="text-muted-foreground">{t('fileType')}</dt>
		<dd class="truncate">{file.mime}</dd>
		{#if file.size === undefined && m?.size != null}<dt class="text-muted-foreground">
				{t('fileSize')}
			</dt>
			<dd>{formatFileSize(m.size)}</dd>{/if}
		{#if m?.at}<dt class="text-muted-foreground">{t('uploaded')}</dt>
			<dd>{m.at}</dd>{/if}
		{#if m?.by}<dt class="text-muted-foreground">{t('uploadedBy')}</dt>
			<dd class="truncate">{m.by}</dd>{/if}
		{#if m?.sha256}<dt class="text-muted-foreground">SHA-256</dt>
			<dd class="truncate font-mono select-all" title={m.sha256}>{m.sha256}</dd>{/if}
	</dl>
	{#if url !== undefined || onRemove}
		<div class="flex items-center gap-2">
			{#if url !== undefined}
				<Button
					variant="outline"
					size="sm"
					href={url}
					download={file.name}
					target="_blank"
					rel="noopener"><Icon icon="lucide:download" class="size-3.5" />{t('download')}</Button
				>
			{/if}
			{#if onRemove}
				<Button
					variant="ghost"
					size="sm"
					class="ml-auto text-destructive hover:bg-destructive/10 hover:text-destructive"
					onclick={onRemove}><Icon icon="lucide:trash-2" class="size-3.5" />{t('remove')}</Button
				>
			{/if}
		</div>
	{/if}
</div>
