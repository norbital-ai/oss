<script lang="ts">
	import Icon from '@iconify/svelte';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { cn, formatFileSize } from '#lib/utils';
	import { useId } from 'bits-ui';
	import { Inline, Scroll, Stack } from '#lib/layout';
	import { isActiveUploadStage, UPLOAD_STAGE_MESSAGES } from '../file-upload/index.js';
	import type { FileValue as TFileValue } from '../file-value/index.js';
	import { Spinner } from '../spinner/index.js';
	import { FileMetadataTooltip } from '../file-value/index.js';
	import type { FileDropZoneProps } from './index.js';

	const { t } = useI18n<UiKeys>();

	type UploadStage = import('../file-upload/index.js').UploadStage;
	type FileRejectedReason = import('./index.js').FileRejectedReason;
	type UploadItem = {
		id: string;
		file: File;
		stage: UploadStage;
		error?: string;
		result?: TFileValue;
		isUploaded?: boolean;
	};

	let {
		id = useId(),
		client,
		maxFiles,
		maxFileSize,
		fileCount = 0,
		disabled = false,
		readonly = false,
		onFileRejected,
		onUploadStart,
		onUploadSuccess,
		onUploadError,
		accept = [],
		uploadedFiles = [],
		onRemoveFile,
		isCompact = false,
		class: className,
		...rest
	}: FileDropZoneProps = $props();

	const isInteractive = $derived(!readonly && !disabled);
	const canUpload = $derived(
		isInteractive && !(maxFiles && fileCount + client.uploads.length >= maxFiles)
	);

	const allFiles = $derived.by(() => {
		const settledFiles = uploadedFiles.map(
			(file) =>
				({
					id: `uploaded-${file.name}-${file.url}`,
					file: new File([], file.name, { type: file.type }),
					stage: 'complete' as UploadStage,
					result: file,
					isUploaded: true
				}) satisfies UploadItem
		);
		const pending = client.uploads.map(
			(u) =>
				({
					id: u.id,
					file: u.file,
					stage: u.stage,
					error: u.error,
					result: u.result as TFileValue | undefined,
					isUploaded: false
				}) satisfies UploadItem
		);
		return [...pending, ...settledFiles];
	});

	const hasFiles = $derived(allFiles.length > 0);
	const htmlAccept = $derived(accept.length > 0 ? accept.join(',') : undefined);

	function validateFile(file: File, currentCount: number): FileRejectedReason | undefined {
		if (maxFileSize && file.size > maxFileSize) return 'Maximum file size exceeded';
		if (maxFiles && currentCount >= maxFiles) return 'Maximum files uploaded';
		if (
			accept.length > 0 &&
			!accept.some((type) => new RegExp(type.replace('*', '.*')).test(file.type))
		) {
			return 'File type not allowed';
		}
		return undefined;
	}

	async function processUploads(files: File[]) {
		if (!isInteractive) return;
		onUploadStart?.(files);

		const validFiles: File[] = [];
		for (const file of files) {
			const reason = validateFile(file, fileCount + client.uploads.length + validFiles.length);
			if (reason) {
				onFileRejected?.({ file, reason });
				continue;
			}
			validFiles.push(file);
		}
		if (validFiles.length === 0) return;

		const results = await client.uploadMany(validFiles);
		if (results.length > 0) onUploadSuccess?.(results as TFileValue[]);
		clearCompletedUploadEntries();
	}

	function clearCompletedUploadEntries() {
		for (const entry of client.uploads) {
			if (entry.stage === 'complete') client.clear(entry.id);
		}
	}

	async function handleDrop(e: DragEvent) {
		if (!canUpload) return;
		e.preventDefault();
		const files = Array.from(e.dataTransfer?.files ?? []);
		if (files.length > 0) await processUploads(files);
	}

	async function handleFileSelect(e: Event) {
		if (!canUpload) return;
		const input = e.target as HTMLInputElement;
		const files = Array.from(input.files ?? []);
		if (files.length > 0) await processUploads(files);
		input.value = ''; // Reset input to allow selecting the same file again
	}

	function removeFile(item: UploadItem) {
		if (!isInteractive) return;
		if (item.isUploaded && item.result) {
			void client.delete(item.result.url);
			const uploadedIndex = uploadedFiles.findIndex((f) => f.url === item.result?.url);
			if (uploadedIndex !== -1) onRemoveFile?.(uploadedIndex);
		} else {
			client.clear(item.id);
		}
	}

	async function retryUpload(item: UploadItem) {
		if (!isInteractive) return;
		client.clear(item.id);
		const { promise } = client.beginUpload(item.file);
		try {
			const result = await promise;
			onUploadSuccess?.([result as TFileValue]);
			clearCompletedUploadEntries();
		} catch (error) {
			if ((error as Error).name !== 'AbortError') {
				onUploadError?.(error instanceof Error ? error.message : t('dataRenderer.uploadFailed'), item.file);
			}
		}
	}

	function getFileIcon(type: string): string {
		if (type.startsWith('image/')) return 'lucide:image';
		if (type === 'application/pdf') return 'lucide:file-text';
		if (type.includes('spreadsheet') || type === 'text/csv') return 'lucide:file-spreadsheet';
		return 'lucide:file';
	}
</script>

{#if readonly}
	<Stack gap="sm" class={className}>
		{#if uploadedFiles.length > 0}
			{#each uploadedFiles as file (file.url)}
				<Inline gap="sm" class="rounded border border-border bg-background p-2">
					<div class="flex h-6 w-6 shrink-0 items-center justify-center">
						{#if file.type.startsWith('image/') && file.url}
							<img src={file.url} alt={file.name} class="h-6 w-6 rounded object-cover" />
						{:else}
							<Icon icon={getFileIcon(file.type)} class="h-4 w-4 text-muted-foreground" />
						{/if}
					</div>
					<div class="min-w-0 flex-1">
						<div class="truncate text-xs font-medium text-foreground">{file.name}</div>
						<div class="text-xs text-muted-foreground">{formatFileSize(file.size)}</div>
					</div>
					{#if file.metadata}
						<FileMetadataTooltip
							metadata={file.metadata}
							class="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-secondary-foreground"
							iconClass="h-3.5 w-3.5"
						/>
					{/if}
				</Inline>
			{/each}
		{:else}
			<div class="text-sm text-muted-foreground">{t('dataRenderer.noFilesAttached')}</div>
		{/if}
	</Stack>
{:else}
	<Stack gap="none" class={className}>
		<label
			ondragover={(e) => {
				if (canUpload) e.preventDefault();
			}}
			ondrop={handleDrop}
			for={id}
			aria-disabled={disabled}
			class={cn(
				'relative flex flex-col overflow-hidden rounded-lg border-2 border-dashed transition-colors',
				'border-border',
				isInteractive && 'cursor-pointer hover:border-brand-400 hover:bg-brand-100/30',
				'aria-disabled:cursor-not-allowed aria-disabled:opacity-50',
				isCompact ? 'h-16' : 'h-32'
			)}
		>
			{#if !hasFiles}
				<div class={cn('flex h-full items-center justify-center', isCompact ? 'p-3' : 'p-6')}>
					<div class="text-center">
						<Icon icon="lucide:upload" class="mx-auto mb-2 h-8 w-8 text-muted-foreground" />
						<div class="text-sm font-medium text-muted-foreground">
							{canUpload ? t('misc.dropFilesHere') : t('misc.maximumFilesReached')}
						</div>
						{#if canUpload}
							<div class="mt-1 text-xs text-muted-foreground">
								{#if maxFiles}
									{t('misc.upToFiles', { count: maxFiles })}
								{/if}
								{#if maxFileSize}
									{maxFiles ? ' • ' : ''}{t('misc.maxSizeEach', { size: formatFileSize(maxFileSize) })}
								{/if}
								{#if accept.length > 0}
									{maxFiles || maxFileSize ? ' • ' : ''}
									{t('misc.fileTypes', {
										types: accept.map((type) => type.replace(/^\./, '').toUpperCase()).join(', ')
									})}
								{/if}
							</div>
						{/if}
					</div>
				</div>
			{:else}
				<Stack gap="none" fill>
					<Inline gap="sm" justify="between" class="border-b border-border px-3 py-2">
						<span class="text-xs text-secondary-foreground">{t('misc.totalFiles', { count: allFiles.length })}</span>
						{#if canUpload}
							<button
								type="button"
								onclick={(e) => {
									e.preventDefault();
									e.stopPropagation();
									document.getElementById(id!)?.click();
								}}
								class="inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-brand hover:bg-brand-100 focus:ring-2 focus:ring-brand focus:ring-offset-1 focus:outline-none"
							>
								<Icon icon="lucide:plus" class="h-3 w-3" />
								{t('common.add')}
							</button>
						{/if}
					</Inline>
					<Scroll axis="y" name={t('misc.uploadedFiles')} class="p-2">
						<Stack gap="sm">
							{#each allFiles as item (item.id)}
								{@const file = item.isUploaded ? item.result : item.file}
								{@const fileName = file?.name || t('misc.unknownFile')}
								{@const fileSize = file?.size || 0}
								{@const fileType = file?.type || 'application/octet-stream'}
								{@const fileUrl = item.result?.url}

								<Inline gap="sm" class="rounded border border-border bg-background p-2">
									<div class="flex h-8 w-8 shrink-0 items-center justify-center">
										{#if fileType.startsWith('image/') && fileUrl}
											<img src={fileUrl} alt={fileName} class="h-8 w-8 rounded object-cover" />
										{:else}
											<Icon icon={getFileIcon(fileType)} class="h-5 w-5 text-muted-foreground" />
										{/if}
									</div>

									<Stack gap="none" grow class="min-w-0">
										<div class="truncate text-start text-sm font-medium text-foreground">
											{fileName}
										</div>
										<Inline gap="sm" class="text-xs text-muted-foreground">
											<span>{formatFileSize(fileSize)}</span>
											{#if isActiveUploadStage(item.stage)}
												<Inline as="span" gap="xs" class="text-brand">
													<Spinner class="h-3 w-3" />
													{UPLOAD_STAGE_MESSAGES[item.stage]}
												</Inline>
											{:else if item.stage === 'error'}
												<Inline as="span" gap="xs" class="text-destructive">
													<Icon icon="lucide:alert-circle" class="h-3 w-3" />
													{UPLOAD_STAGE_MESSAGES[item.stage]}
												</Inline>
											{:else if item.stage === 'aborted'}
												<Inline as="span" gap="xs" class="text-muted-foreground">
													<Icon icon="lucide:slash" class="h-3 w-3" />
													{UPLOAD_STAGE_MESSAGES[item.stage]}
												</Inline>
											{:else if item.stage === 'complete'}
												<Inline as="span" gap="xs" class="text-green-600">
													<Icon icon="lucide:check" class="h-3 w-3" />
													{UPLOAD_STAGE_MESSAGES[item.stage]}
												</Inline>
											{/if}
										</Inline>
									</Stack>

									<Inline gap="xs">
										{#if item.isUploaded && item.result?.metadata}
											<FileMetadataTooltip
												metadata={item.result.metadata}
												class="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-secondary-foreground"
												iconClass="h-3 w-3"
												preventDefault
											/>
										{/if}
										{#if item.stage === 'error' && isInteractive}
											<button
												type="button"
												onclick={(e) => {
													e.stopPropagation();
													e.preventDefault();
													retryUpload(item);
												}}
												class="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-secondary-foreground"
												title={t('misc.retryUpload')}
											>
												<Icon icon="lucide:refresh-cw" class="h-3 w-3" />
											</button>
										{/if}

										{#if isInteractive}
											<button
												type="button"
												onclick={(e) => {
													e.stopPropagation();
													e.preventDefault();
													removeFile(item);
												}}
												class="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
												title={t('misc.removeFile')}
											>
												<Icon icon="lucide:x" class="h-3 w-3" />
											</button>
										{/if}
									</Inline>
								</Inline>
							{/each}
						</Stack>
					</Scroll>
				</Stack>
			{/if}
			<input
				{...rest}
				{id}
				type="file"
				accept={htmlAccept}
				multiple={!maxFiles || maxFiles > 1}
				disabled={!canUpload}
				onchange={handleFileSelect}
				class="pointer-events-none absolute inset-0 h-full w-full cursor-pointer opacity-0"
			/>
		</label>
	</Stack>
{/if}
