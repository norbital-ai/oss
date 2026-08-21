<script lang="ts">
	import type { IFileUploadClient } from '#lib/file-upload';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { cn } from '#lib/utils';
	import { watch } from 'runed';
	import type { DataRendererRuntime } from '../data-renderer-runtime.js';
	import type { DataRendererProps } from '../data-renderer.types.js';
	import FileInput from './file.input.svelte';
	import type { FileValue as TFileValue } from '#lib/file-value';

	const MAX_WORKSPACE_FILE_SIZE = 10 * 1024 * 1024;

	const { t } = useI18n<UiKeys>();

	let {
		field,
		value,
		runtime,
		disabled = false,
		class: className,
		onValueChange
	}: DataRendererProps & { runtime?: DataRendererRuntime } = $props();

	// svelte-ignore state_referenced_locally -- the identity watch replaces this initial client.
	let client = $state<IFileUploadClient | undefined>(runtime?.createFileUploadClient());
	watch(
		() => runtime,
		(nextRuntime) => {
			client = nextRuntime?.createFileUploadClient();
		},
		{ lazy: true }
	);

	/**
	 * What a `file()` column holds: `{storage_key, file_name, file_size, mime_type}`, or an array of
	 * them under `multiple: true`.
	 *
	 * There is no fetch here and that is the whole change. The column used to hold a `uuid` naming a
	 * `document_asset` row, so rendering a filename meant a second query per record — and the upload
	 * path never wrote that row, so the query resolved against nothing and every file rendered
	 * empty. The value now describes the file, so this reads it.
	 */
	type FileRef = {
		storage_key: string;
		file_name: string;
		file_size: number;
		mime_type: string;
	};
	const asRef = (candidate: unknown): FileRef | null => {
		if (typeof candidate !== 'object' || candidate === null) return null;
		const record = candidate as Record<string, unknown>;
		const key = record['storage_key'];
		if (typeof key !== 'string' || key === '') return null;
		return {
			storage_key: key,
			file_name: typeof record['file_name'] === 'string' ? record['file_name'] : key,
			file_size: typeof record['file_size'] === 'number' ? record['file_size'] : 0,
			mime_type:
				typeof record['mime_type'] === 'string' ? record['mime_type'] : 'application/octet-stream'
		};
	};
	const toFileValue = (ref: FileRef): TFileValue => ({
		norbital_id: ref.storage_key,
		name: ref.file_name,
		size: ref.file_size,
		type: ref.mime_type,
		url: `/api/files/${encodeURIComponent(ref.storage_key)}`
	});
	const selectedFiles = $derived.by((): TFileValue[] => {
		const candidates = Array.isArray(value) ? value : value == null ? [] : [value];
		return candidates.flatMap((candidate) => {
			const ref = asRef(candidate);
			return ref === null ? [] : [toFileValue(ref)];
		});
	});
	const selectedFile = $derived(selectedFiles[0]);
	const acceptedTypes = $derived(field.mimeTypes?.length ? [...field.mimeTypes] : ['*/*']);

	/**
	 * `FileInput` speaks `TFileValue` because that is what it renders; the column stores a `FileRef`.
	 * Writing the input's own shape back would persist a `url` and a `norbital_id` the server never
	 * agreed to, so the conversion is explicit in both directions.
	 */
	const toRef = (file: TFileValue): FileRef => ({
		storage_key: file.norbital_id,
		file_name: file.name,
		file_size: file.size,
		mime_type: file.type
	});
</script>

{#if !client}
	<p
		class={cn('rounded-md border border-destructive/40 p-3 text-sm text-destructive', className)}
		role="alert"
	>
		{t('dataRenderer.fileProviderMissing')}
	</p>
{:else if field.array}
	<FileInput
		multiple={true}
		value={selectedFiles}
		{client}
		maxFileSize={MAX_WORKSPACE_FILE_SIZE}
		accept={acceptedTypes}
		{disabled}
		class={className}
		onValueChange={(files) => onValueChange?.(files.map(toRef))}
	/>
{:else}
	<FileInput
		multiple={false}
		value={selectedFile}
		{client}
		maxFileSize={MAX_WORKSPACE_FILE_SIZE}
		accept={acceptedTypes}
		{disabled}
		class={className}
		onValueChange={(file) => onValueChange?.(file ? toRef(file) : null)}
	/>
{/if}
