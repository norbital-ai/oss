<script lang="ts">
	import Icon from '@iconify/svelte';
	import { Button } from '../../../button/index.js';
	import {
		type IFileUploadClient,
		type UploadStage,
		isActiveUploadStage,
		UPLOAD_STAGE_MESSAGES
	} from '../../../file-upload/index.js';
	import * as Popover from '../../../popover/index.js';
	import { ScrollArea } from '../../../scroll-area/index.js';
	import { Tooltip } from '../../../tooltip/index.js';
	import { cn } from '../../../utils/index.js';
	import type { Editor, NodeViewRendererProps } from '@tiptap/core';
	import { marked } from 'marked';
	import Papa from 'papaparse';
	import { type Snippet } from 'svelte';
	import { toast } from 'svelte-sonner';
	import AttachmentPreviewImage from './attachment-preview-image.svelte';
	import AttachmentPreviewPdf from './attachment-preview-pdf.svelte';
	import AttachmentPreviewCsv from './attachment-preview-csv.svelte';
	import AttachmentPreviewText from './attachment-preview-text.svelte';
	import { Inline, Stack } from '#lib/layout';

	let {
		editor,
		node,
		getPos
	}: {
		editor: Editor;
		node: NodeViewRendererProps['node'];
		getPos: NodeViewRendererProps['getPos'];
	} = $props();

	let fileName = $derived(node.attrs.name);
	let fileType = $derived(node.attrs.type);
	let fileSize = $derived(node.attrs.size);
	let fileUrl = $derived(node.attrs.url);
	let metadata = $derived(node.attrs.metadata);
	let uploadId = $derived(node.attrs.id as string | null);

	let uploadClient = $derived(getUploadClient());
	let liveUpload = $derived(
		uploadId && uploadClient ? uploadClient.uploads.find((u) => u.id === uploadId) : undefined
	);
	let stage = $derived((liveUpload?.stage ?? node.attrs.stage) as UploadStage | null);
	let uploading = $derived(stage !== null && isActiveUploadStage(stage));

	type PreviewContent =
		| { type: 'image' }
		| { type: 'pdf'; dataUrl: string }
		| {
				type: 'csv';
				data: Record<string, unknown>[];
				headers: string[];
				totalRows: number;
				errors: Papa.ParseError[];
		  }
		| { type: 'markdown'; renderedHtml: string }
		| { type: 'text'; content: string };

	type PreviewKind = 'image' | 'pdf' | 'csv' | 'markdown' | 'text';

	const PREVIEW_ICONS: Record<PreviewKind | 'default', string> = {
		image: 'lucide:image',
		pdf: 'lucide:file-text',
		csv: 'lucide:table',
		markdown: 'lucide:file-text',
		text: 'lucide:file-text',
		default: 'lucide:file'
	};

	let preview = $state({
		open: false,
		loading: false,
		error: null as string | null,
		content: null as PreviewContent | null
	});

	let previewIcon = $derived(PREVIEW_ICONS[resolvePreviewKind(fileType) ?? 'default']);

	function resolvePreviewKind(type: string): PreviewKind | null {
		if (type.startsWith('image/')) return 'image';
		if (type === 'application/pdf') return 'pdf';
		if (type === 'text/csv' || type === 'text/tab-separated-values') return 'csv';
		if (type === 'text/markdown') return 'markdown';
		if (type === 'text/plain') return 'text';
		return null;
	}

	function getUploadClient(): IFileUploadClient | undefined {
		const fileAttachment = editor.storage.fileAttachment;
		return fileAttachment?.uploadClient;
	}

	function formatFileSize(bytes: number) {
		if (bytes === 0) return '0 Bytes';
		const k = 1024;
		const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
		const i = Math.floor(Math.log(bytes) / Math.log(k));
		return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
	}

	function removeFile(event?: MouseEvent) {
		event?.stopPropagation();
		const url = fileUrl as string | null | undefined;
		if (url) {
			void getUploadClient()
				?.delete(url)
				.catch(() => {});
		}
		cancelUpload();
		const pos = getPos();
		editor.commands.deleteRange({ from: pos!, to: pos! + node.nodeSize });
	}

	function cancelUpload() {
		if (!uploadId) return;
		getUploadClient()?.cancel(uploadId);
	}

	async function fetchFileAsBlob(url: string): Promise<Blob> {
		const response = await fetch(url);
		if (!response.ok) {
			toast.error('Failed to fetch file.');
		}
		const contentType =
			response.headers.get('Content-Type') || fileType || 'application/octet-stream';
		const arrayBuffer = await response.arrayBuffer();
		return new Blob([arrayBuffer], { type: contentType });
	}

	async function fetchText(url: string): Promise<string> {
		const blob = await fetchFileAsBlob(url);
		return blob.text();
	}

	async function loadPdfPreview(url: string): Promise<PreviewContent> {
		const response = await fetch(url);
		if (!response.ok) {
			toast.error('Failed to load PDF');
		}
		const arrayBuffer = await response.arrayBuffer();
		const base64 = btoa(
			new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), '')
		);
		return { type: 'pdf', dataUrl: `data:application/pdf;base64,${base64}` };
	}

	async function loadCsvPreview(url: string): Promise<PreviewContent> {
		const text = await fetchText(url);
		const result = Papa.parse<Record<string, unknown>>(text, {
			header: true,
			skipEmptyLines: true,
			dynamicTyping: true,
			delimitersToGuess: [',', '\t', '|', ';'],
			...(fileType === 'text/tab-separated-values' ? { delimiter: '\t' } : {})
		});
		if (result.errors.length > 0) {
			console.warn('CSV parsing errors:', result.errors);
		}
		return {
			type: 'csv',
			data: result.data,
			headers: result.meta.fields || [],
			totalRows: result.data.length,
			errors: result.errors
		};
	}

	async function loadMarkdownPreview(url: string): Promise<PreviewContent> {
		const text = await fetchText(url);
		return { type: 'markdown', renderedHtml: marked.parse(text, { async: false }) };
	}

	async function loadTextPreview(url: string): Promise<PreviewContent> {
		const text = await fetchText(url);
		return { type: 'text', content: text };
	}

	const previewLoaders: Record<PreviewKind, (url: string) => Promise<PreviewContent>> = {
		image: async () => ({ type: 'image' }),
		pdf: loadPdfPreview,
		csv: loadCsvPreview,
		markdown: loadMarkdownPreview,
		text: loadTextPreview
	};

	async function togglePreview() {
		if (preview.open) {
			preview.open = false;
			return;
		}
		const kind = resolvePreviewKind(fileType);
		if (!kind || !fileUrl) return;
		preview.open = true;
		preview.loading = true;
		preview.error = null;
		try {
			preview.content = await previewLoaders[kind](fileUrl);
		} catch {
			preview.error = 'Error loading preview';
		} finally {
			preview.loading = false;
		}
	}
</script>

{#snippet Container(children: Snippet)}
	<div
		class="inline-flex w-full max-w-full flex-col rounded border border-border bg-background p-2"
		data-file-type={fileType}
	>
		{@render children()}
	</div>
{/snippet}
{#snippet Loader()}
	<Inline gap="sm" class="text-muted-foreground">
		<Icon icon="lucide:loader-2" class="h-4 w-4 animate-spin" />
		<span class="flex-1 truncate">
			{stage ? UPLOAD_STAGE_MESSAGES[stage] : UPLOAD_STAGE_MESSAGES.uploading}
			{fileName}
		</span>
		<Inline gap="xs" shrink={false}>
			<div
				class={cn(
					'h-1.5 w-3 rounded-full',
					stage && isActiveUploadStage(stage) ? 'bg-brand' : 'bg-secondary'
				)}
			></div>
			<div
				class={cn(
					'h-1.5 w-3 rounded-full',
					stage && (stage === 'converting' || stage === 'summarizing') ? 'bg-brand' : 'bg-secondary'
				)}
			></div>
			<div
				class={cn('h-1.5 w-3 rounded-full', stage === 'summarizing' ? 'bg-brand' : 'bg-secondary')}
			></div>
		</Inline>
		{#if stage && isActiveUploadStage(stage)}
			<Button
				variant="ghost"
				size="icon"
				class="h-7 w-7 text-muted-foreground hover:text-foreground"
				aria-label="Cancel upload"
				onclick={cancelUpload}
			>
				<Icon icon="lucide:x" width="16" height="16" />
			</Button>
		{/if}
	</Inline>
{/snippet}
{#snippet Error()}
	<Inline gap="sm" class="text-destructive">
		<Icon icon="lucide:alert-circle" width="16" height="16" />
		<span>Error uploading {fileName}</span>
		<Button
			variant="ghost"
			size="icon"
			class="text-muted-foreground hover:text-destructive"
			aria-label="Remove file"
			onclick={removeFile}
		>
			<Icon icon="lucide:x" width="16" height="16" />
		</Button>
	</Inline>
{/snippet}
{#snippet Aborted()}
	<Inline gap="sm" class="text-muted-foreground">
		<Icon icon="lucide:slash" width="16" height="16" />
		<span>Cancelled {fileName}</span>
		<Button
			variant="ghost"
			size="icon"
			class="text-muted-foreground hover:text-destructive"
			aria-label="Remove file"
			onclick={removeFile}
		>
			<Icon icon="lucide:x" width="16" height="16" />
		</Button>
	</Inline>
{/snippet}
{#snippet Preview()}
	<Inline gap="md">
		<Icon icon={previewIcon} width="16" height="16" class="text-muted-foreground" />
		<div class="min-w-0 flex-1 text-start">
			<div class="font-medium wrap-break-word">{fileName}</div>
			<div class="text-xs text-muted-foreground">{formatFileSize(fileSize)}</div>
		</div>
		<Button
			variant="ghost"
			size="icon"
			class="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
			aria-label="Remove file"
			onclick={removeFile}
		>
			<Icon icon="lucide:x" width="16" height="16" />
		</Button>
		{#if metadata?.summary || metadata?.structure_hint}
			<Tooltip align="end" side="top" contentClass="max-w-sm">
				{#snippet trigger({ props })}
					<button
						type="button"
						{...props}
						class="ml-auto inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
						onclick={(e) => e.stopPropagation()}
						aria-label="View summary"
					>
						<Icon icon="lucide:info" width="16" height="16" />
					</button>
				{/snippet}
				{#snippet content()}
					<Stack gap="xs">
						{#if metadata?.structure_hint}
							<div class="text-xs font-medium text-foreground">{metadata.structure_hint}</div>
						{/if}
						{#if metadata?.summary}
							<div class="text-xs text-muted-foreground">{metadata.summary}</div>
						{/if}
					</Stack>
				{/snippet}
			</Tooltip>
		{/if}
	</Inline>
{/snippet}

<Popover.Root>
	{#if uploading}
		{@render Container(Loader)}
	{:else if stage === 'aborted'}
		{@render Container(Aborted)}
	{:else if stage === 'error'}
		{@render Container(Error)}
	{:else}
		<Popover.Trigger onclick={togglePreview} class="m-0 w-full rounded-md p-0">
			{@render Container(Preview)}
		</Popover.Trigger>
		<Popover.Content align="start" sameWidth={true} sideOffset={6}>
			<ScrollArea orientation="both" class="w-full border-t pt-3">
				{#if preview.loading}
					<Inline justify="center" gap="sm" class="p-4">
						<div class="flex h-5 w-5 animate-spin items-center justify-center">
							<Icon icon="eos-icons:loading" />
						</div>
						<span>Loading preview...</span>
					</Inline>
				{:else if preview.error}
					<div class="p-4 text-center text-destructive">
						<Icon icon="lucide:alert-circle" width="16" height="16" class="mr-1 inline" />
						<span>Failed to load preview: {preview.error}</span>
					</div>
				{:else if preview.content}
					{#if preview.content.type === 'image'}
						<AttachmentPreviewImage src={fileUrl} alt={fileName} />
					{:else if preview.content.type === 'pdf'}
						<AttachmentPreviewPdf dataUrl={preview.content.dataUrl} {fileName} {fileUrl} />
					{:else if preview.content.type === 'csv'}
						<AttachmentPreviewCsv
							headers={preview.content.headers}
							data={preview.content.data}
							totalRows={preview.content.totalRows}
							errors={preview.content.errors}
						/>
					{:else if preview.content.type === 'markdown'}
						<AttachmentPreviewText variant="markdown" renderedHtml={preview.content.renderedHtml} />
					{:else if preview.content.type === 'text'}
						<AttachmentPreviewText variant="plain" content={preview.content.content} />
					{/if}
				{/if}
			</ScrollArea>
		</Popover.Content>
	{/if}
</Popover.Root>
