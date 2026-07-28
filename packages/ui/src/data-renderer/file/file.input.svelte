<script lang="ts" generics="T extends boolean">
	import Icon from '@iconify/svelte';
	import { cn } from '#lib/utils';
	import { Button, buttonVariants } from '#lib/button';
	import * as Carousel from '#lib/carousel';
	import type { IFileUploadClient } from '#lib/file-upload';
	import { isActiveUploadStage, UPLOAD_STAGE_MESSAGES } from '#lib/file-upload';
	import * as Popover from '#lib/popover';
	import { FileMetadataTooltip } from '#lib/file-value';
	import FileThumbnail from './file-thumbnail.svelte';
	import type { AllowedFileType as TAllowedFileType, FileValue as TFileValue } from '#lib/file-value';

	interface Props<T extends boolean> {
		multiple: T;
		value?: T extends true ? TFileValue[] : TFileValue;
		onValueChange?: (value: T extends true ? TFileValue[] : TFileValue) => void;
		/** App-provided upload client (e.g. MinIO `/api/file` + SSE progress). */
		client: IFileUploadClient;
		maxFiles?: number;
		maxFileSize: number;
		accept: TAllowedFileType[];
		style?: string;
		class?: string;
		disabled?: boolean;
		readonly?: boolean;
		/**
		 * When true, renders without borders. Used in collection table cells for inline display.
		 */
		borderless?: boolean;
		allowClear?: boolean;
		onUploadStart?: (files: File[]) => void;
		onUploadError?: (error: string, file?: File) => void;
		onFileRejected?: (rejection: { reason: string; file: File }) => void;
	}

	let {
		multiple,
		value,
		onValueChange,
		client,
		maxFiles: maxFilesProp,
		maxFileSize,
		accept,
		allowClear = true,
		style,
		class: className = '',
		disabled = false,
		readonly = false,
		borderless = false,
		onUploadStart,
		onUploadError,
		onFileRejected
	}: Props<T> = $props();

	const maxFiles = $derived(maxFilesProp ?? (multiple ? 10 : 1));

	const formatFileSize = (bytes: number): string => {
		if (bytes < 0) return '0 B';
		if (bytes === 0) return '0 B';

		const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
		const k = 1024;
		const i = bytes === 0 ? 0 : Math.floor(Math.log(bytes) / Math.log(k));

		if (i >= units.length)
			return `${(bytes / Math.pow(k, units.length - 1)).toFixed(1)} ${units[units.length - 1]}`;

		const value = bytes / Math.pow(k, i);
		return i === 0 ? `${Math.round(value)} ${units[i]}` : `${value.toFixed(1)} ${units[i]}`;
	};

	const validateFile = (file: File): { valid: boolean; reason?: string } => {
		if (file.size > maxFileSize) {
			return {
				valid: false,
				reason: `File "${file.name}" (${formatFileSize(
					file.size
				)}) exceeds the ${formatFileSize(maxFileSize)} limit`
			};
		}
		const accepted = accept.some(
			(pattern) =>
				pattern === '*/*' ||
				pattern === file.type ||
				(pattern.endsWith('/*') && file.type.startsWith(pattern.slice(0, -1)))
		);
		if (!accepted) {
			return {
				valid: false,
				reason: `File type "${file.type}" is not allowed for "${file.name}"`
			};
		}
		return { valid: true };
	};

	const downloadFile = (file: TFileValue) => {
		const link = document.createElement('a');
		link.href = file.url;
		link.download = file.name;
		document.body.appendChild(link);
		link.click();
		document.body.removeChild(link);
	};

	let editingFiles = $derived.by(() => {
		if (!value) {
			return [];
		} else if (Array.isArray(value)) {
			return [...value];
		} else {
			return [value];
		}
	});
	let fileInput = $state<HTMLInputElement>();
	let isOpen = $state(false);
	const activePendingCount = $derived.by(
		() => client.uploads.filter((p) => isActiveUploadStage(p.stage)).length
	);
	const clientUploadBusy = $derived(activePendingCount > 0);

	const hasValidFiles = $derived(editingFiles.length > 0);

	const triggerText = $derived.by(() => {
		if (!hasValidFiles) {
			return multiple ? 'No files uploaded' : 'No file uploaded';
		}
		if (editingFiles.length === 1) {
			return editingFiles[0].name;
		}
		return `${editingFiles.length} files selected`;
	});

	// For stacked previews in trigger
	const MAX_DISPLAY_PREVIEWS = 3;
	const displayFiles = $derived(editingFiles.slice(0, MAX_DISPLAY_PREVIEWS));
	const extraCount = $derived(Math.max(0, editingFiles.length - MAX_DISPLAY_PREVIEWS));

	const notifyParent = () => {
		if (readonly || !onValueChange) return;

		if (!multiple) {
			// Single mode: pass the first file or undefined
			const result = editingFiles[0] || undefined;
			onValueChange(result as T extends true ? TFileValue[] : TFileValue);
		} else {
			// Multiple mode: pass array of files
			onValueChange(editingFiles as T extends true ? TFileValue[] : TFileValue);
		}
	};

	const handleFileSelection = async (files: FileList) => {
		if (readonly) return;

		const validFiles: File[] = [];
		const rejectedFiles: { file: File; reason: string }[] = [];

		for (const file of Array.from(files)) {
			const validation = validateFile(file);
			if (!validation.valid) {
				rejectedFiles.push({ file, reason: validation.reason! });
				continue;
			}
			if (editingFiles.length + activePendingCount + validFiles.length >= maxFiles) {
				rejectedFiles.push({
					file,
					reason: `Cannot add "${file.name}": maximum ${maxFiles} file${
						maxFiles > 1 ? 's' : ''
					} allowed`
				});
				continue;
			}
			validFiles.push(file);
		}

		rejectedFiles.forEach(({ file, reason }) => onFileRejected?.({ file, reason }));
		if (validFiles.length === 0) return;

		onUploadStart?.(validFiles);
		try {
			const results = await client.uploadMany(validFiles);
			if (results.length > 0) editingFiles = [...editingFiles, ...results];
			notifyParent();
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Upload failed';
			onUploadError?.(message);
		}
	};

	const handleFileInputChange = async (event: Event) => {
		const input = event.target as HTMLInputElement;
		if (input.files && input.files.length > 0) {
			await handleFileSelection(input.files);
			input.value = '';
		}
	};

	const openFileBrowser = () => {
		if (readonly) return;
		fileInput?.click();
	};

	const removeFile = (index: number) => {
		if (readonly) return;

		const file = editingFiles[index];
		if (file?.url) {
			void client.delete(file.url);
		}

		// For single mode, reset to empty instead of removing
		if (!multiple && editingFiles.length <= 1) {
			editingFiles = [];
		} else {
			editingFiles = editingFiles.filter((_, i) => i !== index);
		}
		notifyParent();
	};

	const handleClear = () => {
		if (readonly) return;
		for (const file of editingFiles) {
			if (file.url) void client.delete(file.url);
		}
		editingFiles = [];
		client.clearAllUploads();
		notifyParent();
	};

	const cancelPendingUpload = (id: string) => client.cancel(id);
	const removePendingUpload = (id: string) => client.clear(id);
</script>

<!-- Hidden file input -->
<input
	bind:this={fileInput}
	type="file"
	{multiple}
	accept={accept.join(',')}
	class="hidden"
	onchange={handleFileInputChange}
	{disabled}
	aria-label="File upload input"
/>

{#snippet triggerContent()}
	{#if hasValidFiles}
		<div class="flex items-center gap-2">
			<div class="flex items-center -space-x-1">
				{#each displayFiles as file (file.norbital_id)}
					<div class="h-5 w-5 overflow-hidden rounded-full border border-border">
						<FileThumbnail file_value={file} ratio={1} size="small" class="m-0 h-full w-full p-0" />
					</div>
				{/each}
				{#if extraCount > 0}
					<div
						class="flex h-5 w-5 items-center justify-center rounded-full border-2 border-white bg-secondary text-xs font-medium text-muted-foreground"
					>
						+{extraCount}
					</div>
				{/if}
			</div>
		</div>
	{:else}
		<Icon
			icon="lucide:paperclip"
			class={cn('h-4 w-4', hasValidFiles ? 'text-brand' : 'text-muted-foreground')}
		/>
	{/if}
	<span class={cn('truncate text-xs', hasValidFiles ? 'text-foreground' : 'text-muted-foreground')}>
		{triggerText}
	</span>
	{#if !readonly}
		<Icon
			icon="lucide:chevrons-up-down"
			class="ml-auto h-4 w-4 flex-none text-muted-foreground {allowClear &&
			!readonly &&
			((Array.isArray(value) && value.length > 0) || (!Array.isArray(value) && value))
				? 'group-hover:invisible'
				: ''}"
		/>
	{/if}
	<!-- Clear button -->
	{#if allowClear && ((Array.isArray(value) && value.length > 0) || (!Array.isArray(value) && value)) && !readonly}
		<Button
			size="icon"
			variant="ghost"
			class="invisible absolute top-1/2 right-1 h-6 w-6 -translate-y-1/2 rounded-full p-0 group-hover:visible focus:visible"
			onclick={handleClear}
			aria-label="Clear selection"
			tabindex={-1}
		>
			<Icon icon="lucide:x" class="h-4 w-4" />
		</Button>
	{/if}
{/snippet}

{#snippet readonlyView()}
	{#if hasValidFiles}
		<Carousel.Root class="w-full">
			<Carousel.Content>
				{#each editingFiles as file, index (file.norbital_id)}
					<Carousel.Item>
						<div class="space-y-4">
							<div class="flex items-center gap-3 rounded-md bg-muted/40 p-3">
								<div class="h-12 w-12 overflow-hidden rounded-lg">
									<FileThumbnail file_value={file} ratio={1} size="small" class="h-full w-full" />
								</div>
								<div class="min-w-0 flex-1">
									<p class="truncate text-xs font-semibold text-foreground">{file.name}</p>
									<p class="text-xs text-muted-foreground">{formatFileSize(file.size)}</p>
								</div>
								{#if file.metadata}
									<FileMetadataTooltip
										metadata={file.metadata}
										class="inline-flex h-8 w-8 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-secondary-foreground"
										iconClass="h-4 w-4"
									/>
								{/if}
								<Button
									size="sm"
									variant="outline"
									onclick={() => downloadFile(file)}
									class="shrink-0"
								>
									<Icon icon="lucide:download" class="h-4 w-4" />
								</Button>
							</div>

							<div class="flex h-full flex-col space-y-2 p-2">
								<div class="flex items-center gap-2 text-sm font-medium text-secondary-foreground">
									<Icon icon="lucide:eye" class="h-4 w-4" />
									File Preview
								</div>
								<FileThumbnail
									file_value={file}
									ratio={16 / 9}
									size="medium"
									class="h-full w-full p-8"
								/>
							</div>
						</div>
					</Carousel.Item>
				{/each}
			</Carousel.Content>
			{#if editingFiles.length > 1}
				<Carousel.Previous class="left-0!" />
				<Carousel.Next class="right-0!" />
			{/if}
		</Carousel.Root>
	{:else}
		<div class="py-8 text-center text-muted-foreground">
			<Icon icon="lucide:paperclip" class="mx-auto mb-2 h-8 w-8 text-muted-foreground" />
			<p class="text-sm">No files attached</p>
		</div>
	{/if}
{/snippet}

{#snippet editableView()}
	{#if multiple && editingFiles.length === 0}
		<div class="p-4 py-8 text-center">
			<Icon icon="lucide:upload-cloud" class="mx-auto mb-3 h-12 w-12 text-muted-foreground" />
			<h4 class="mb-1 font-medium text-foreground">No files selected</h4>
			<p class="mb-4 text-sm text-muted-foreground">Upload your first file to get started</p>
			<Button
				variant="outline"
				onclick={openFileBrowser}
				class="border-dashed"
				disabled={disabled || clientUploadBusy}
			>
				<Icon icon="lucide:plus" class="mr-2 h-4 w-4" />
				{#if clientUploadBusy}
					{UPLOAD_STAGE_MESSAGES.uploading}
				{:else}
					Add first file
				{/if}
			</Button>
		</div>
	{:else}
		<div class="space-y-3 p-4">
			{#if client.uploads.length > 0}
				{#each client.uploads as pending (pending.id)}
					<div class="flex items-center gap-2">
						<div class="flex flex-1 items-center gap-3 rounded-lg border p-2">
							<div class="h-8 w-8 overflow-hidden rounded bg-muted"></div>
							<div class="min-w-0 flex-1">
								<p class="truncate text-sm font-medium">{pending.file.name}</p>
								<p class="text-xs text-muted-foreground">
									{formatFileSize(pending.file.size)} • {UPLOAD_STAGE_MESSAGES[pending.stage]}
								</p>
								{#if pending.stage === 'error' && pending.error}
									<p class="truncate text-xs text-destructive">{pending.error}</p>
								{/if}
							</div>
						</div>

						{#if isActiveUploadStage(pending.stage)}
							<Button
								variant="ghost"
								size="sm"
								onclick={() => cancelPendingUpload(pending.id)}
								class="h-8 w-8 p-0 text-muted-foreground hover:bg-muted hover:text-secondary-foreground"
								{disabled}
								title="Cancel upload"
							>
								<Icon icon="lucide:x" class="h-4 w-4" />
							</Button>
						{:else}
							<Button
								variant="ghost"
								size="sm"
								onclick={() => removePendingUpload(pending.id)}
								class="h-8 w-8 p-0 text-destructive hover:bg-destructive/10 hover:text-destructive-foreground"
								{disabled}
								title="Remove"
							>
								<Icon icon="lucide:x" class="h-4 w-4" />
							</Button>
						{/if}
					</div>
				{/each}
			{/if}

			{#each editingFiles as file, index (index)}
				<div class="flex items-center gap-2">
					<div class="flex flex-1 items-center gap-3 rounded-lg border p-2">
						<div class="h-8 w-8 overflow-hidden rounded">
							<FileThumbnail file_value={file} ratio={1} size="small" class="h-full w-full" />
						</div>
						<div class="min-w-0 flex-1">
							<p class="truncate text-sm font-medium">{file.name}</p>
							<p class="text-xs text-muted-foreground">{formatFileSize(file.size)}</p>
						</div>
					</div>

					{#if file.metadata}
						<FileMetadataTooltip
							metadata={file.metadata}
							class="inline-flex h-8 w-8 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-secondary-foreground"
							iconClass="h-4 w-4"
						/>
					{/if}

					<Button
						variant="ghost"
						size="sm"
						onclick={() => removeFile(index)}
						class="h-8 w-8 p-0 text-destructive hover:bg-destructive/10 hover:text-destructive-foreground"
						disabled={disabled || clientUploadBusy}
					>
						<Icon icon="lucide:x" class="h-4 w-4" />
					</Button>
				</div>
			{/each}

			{#if (multiple && editingFiles.length < maxFiles) || (!multiple && editingFiles.length === 0)}
				<Button
					variant="outline"
					onclick={openFileBrowser}
					class="w-min border-dashed text-muted-foreground hover:text-foreground"
					disabled={disabled || clientUploadBusy}
				>
					<Icon icon="lucide:plus" class="mr-2 h-4 w-4" />
					{#if clientUploadBusy}
						{UPLOAD_STAGE_MESSAGES.uploading}
					{:else}
						Add file
					{/if}
				</Button>
			{/if}

			<!-- File constraints info -->
			<div class="space-y-1 border-t pt-2 text-xs text-muted-foreground">
				<div>
					Max {maxFiles} file{maxFiles !== 1 ? 's' : ''} • {formatFileSize(maxFileSize)} limit
				</div>
				<div>
					Accepts: {accept.length > 3 ? `${accept.slice(0, 3).join(', ')}...` : accept.join(', ')}
				</div>
			</div>
		</div>
	{/if}
{/snippet}

<Popover.Root bind:open={isOpen}>
	<Popover.Trigger
		class={cn(
			// Base styles - always applied
			'group relative flex h-auto min-h-8 w-full items-center gap-2 rounded-md p-1 pl-2 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none focus-visible:ring-inset',
			// Conditional styles using cn's object syntax
			{
				// Readonly mode styles
				'cursor-pointer justify-start overflow-hidden hover:bg-accent': readonly && !borderless,
				// Editable mode styles
				[buttonVariants({ variant: 'outline', class: 'bg-background px-2 shadow-xs' })]:
					!readonly && !borderless,
				// Borderless mode
				'cursor-default border-none shadow-none': borderless
			},
			className
		)}
		{style}
		{disabled}
	>
		{@render triggerContent()}
	</Popover.Trigger>
	<Popover.Content sameWidth={true} class="p-0" align="start" sideOffset={4}>
		<div class="space-y-4 p-1">
			{#if readonly}
				{@render readonlyView()}
			{:else}
				{@render editableView()}
			{/if}
		</div>
	</Popover.Content>
</Popover.Root>
