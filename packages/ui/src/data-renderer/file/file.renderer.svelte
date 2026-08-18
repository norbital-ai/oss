<script lang="ts">
	import type { CollectionRecord, RemoteQuery } from '@norbital-ai/std/collection';
	import type { IFileUploadClient } from '#lib/file-upload';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { cn } from '#lib/utils';
	import { watch } from 'runed';
	import type { DataRendererRuntime } from '../data-renderer-runtime.js';
	import type { DataRendererProps } from '../data-renderer.types.js';
	import FileInput from './file.input.svelte';
	import type { FileValue as TFileValue } from '#lib/file-value';
	import { getCollectionClientContext } from '#lib/collection-runtime';

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
	const records = getCollectionClientContext().records;

	// svelte-ignore state_referenced_locally -- the identity watch replaces this initial client.
	let client = $state<IFileUploadClient | undefined>(runtime?.createFileUploadClient());
	watch(
		() => runtime,
		(nextRuntime) => {
			client = nextRuntime?.createFileUploadClient();
		},
		{ lazy: true }
	);

	const selectedIds = $derived.by((): string[] => {
		const candidates = Array.isArray(value) ? value : value == null ? [] : [value];
		return candidates.filter((candidate): candidate is string => typeof candidate === 'string');
	});
	const selectedQueryInput = $derived.by(() =>
		selectedIds.length > 0
			? {
					records,
					query: {
						where: { norbital_id: { in: selectedIds } },
						limit: selectedIds.length
					}
				}
			: null
	);
	let selectedQuery = $state<RemoteQuery<CollectionRecord[]> | null>(null);
	watch(
		() => selectedQueryInput,
		(input) => {
			selectedQuery = input ? input.records.findMany('document_asset', input.query) : null;
		},
		{ lazy: false }
	);
	const selectedFiles = $derived.by((): TFileValue[] =>
		(selectedQuery?.current ?? []).flatMap((record: CollectionRecord) => {
			const id = record.norbital_id;
			const name = record.file_name;
			const size = record.file_size;
			const type = record.mime_type;
			const storageKey = record.storage_key;
			if (
				typeof id !== 'string' ||
				typeof name !== 'string' ||
				typeof size !== 'number' ||
				typeof storageKey !== 'string'
			) {
				return [];
			}
			return [
				{
					norbital_id: id,
					name,
					size,
					type: typeof type === 'string' ? type : 'application/octet-stream',
					url: `/api/files/${encodeURIComponent(storageKey)}`
				}
			];
		})
	);
	const selectedFile = $derived(selectedFiles[0]);
	const acceptedTypes = $derived(field.mimeTypes?.length ? [...field.mimeTypes] : ['*/*']);
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
		onValueChange={(files) => onValueChange?.(files.map((file) => file.norbital_id))}
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
		onValueChange={(file) => onValueChange?.(file?.norbital_id ?? null)}
	/>
{/if}
