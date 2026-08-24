<script lang="ts">
	import type { IFileUploadClient } from '#lib/file-upload';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { cn } from '#lib/utils';
	import { watch } from 'runed';
	import type { DataRendererRuntime } from '#lib/data-renderer/data-renderer-runtime';
	import type { DataRendererProps } from '#lib/data-renderer/data-renderer.types';
	import FileInput from './file.input.svelte';
	import {
		fileRefFromFileValue,
		fileValueFromFileRef,
		readFileRef
	} from '#lib/data-renderer/file/file.types';
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
	 * `FileInput` speaks `TFileValue` because that is what it renders; the column stores a `FileRef`.
	 * Writing the input's own shape back would persist a `url` and a `id` the server never
	 * agreed to, so the conversion is explicit in both directions.
	 */
	const selectedFiles = $derived.by((): TFileValue[] => {
		if (runtime === undefined) return [];
		const candidates = Array.isArray(value) ? value : value == null ? [] : [value];
		return candidates.flatMap((candidate) => {
			const ref = readFileRef(candidate);
			return ref === null ? [] : [fileValueFromFileRef(ref, runtime.fileUrl)];
		});
	});
	const selectedFile = $derived(selectedFiles[0]);
	const acceptedTypes = $derived(field.mimeTypes?.length ? [...field.mimeTypes] : ['*/*']);

	/**
	 * `FileInput` speaks `TFileValue` because that is what it renders; the column stores a `FileRef`.
	 * Writing the input's own shape back would persist a `url` and a `id` the server never
	 * agreed to, so the conversion is explicit in both directions.
	 */
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
		onValueChange={(files) => onValueChange?.(files.map(fileRefFromFileValue))}
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
		onValueChange={(file) => onValueChange?.(file ? fileRefFromFileValue(file) : null)}
	/>
{/if}
