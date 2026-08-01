<script lang="ts">
	import { formatFileSize } from '#lib/utils';
	import { AspectRatio } from '#lib/aspect-ratio';
	import { Stack } from '#lib/layout';
	import type { FileValue as TFileValue } from '#lib/file-value';

	interface Props {
		file_value: TFileValue;
		ratio?: number;
		size?: 'small' | 'medium' | 'large' | 'xlarge';
		class?: string;
	}

	let { file_value, ratio = 16 / 9, size = 'medium', class: className = '' }: Props = $props();

	// Size configurations
	const SIZE_CONFIGS = {
		small: { width: 'w-32', fontSize: 'text-xs' },
		medium: { width: 'w-60', fontSize: 'text-sm' },
		large: { width: 'w-96', fontSize: 'text-base' },
		xlarge: { width: 'w-[450px]', fontSize: 'text-lg' }
	} as const;

	// File category detection
	function getFileCategory(type: string): string {
		if (type.startsWith('image/')) return 'image';
		if (type === 'application/pdf') return 'pdf';
		if (type === 'text/csv' || type === 'text/tab-separated-values') return 'csv';
		if (type.startsWith('text/') || type === 'text/markdown') return 'text';
		if (type.includes('spreadsheet') || type.includes('excel')) return 'spreadsheet';
		return 'unknown';
	}

	// Derived values
	const isImage = $derived(file_value.type.startsWith('image/'));
	const category = $derived(getFileCategory(file_value.type));
	const sizeClasses = $derived(SIZE_CONFIGS[size] || SIZE_CONFIGS.medium);

	// Get icon for file type
	function getFileIcon(category: string): string {
		switch (category) {
			case 'pdf':
				return '📄';
			case 'text':
				return '📝';
			case 'csv':
			case 'spreadsheet':
				return '📊';
			case 'image':
				return '🖼️';
			default:
				return '📎';
		}
	}
</script>

<div class="{sizeClasses.width} {sizeClasses.fontSize} {className}">
	<AspectRatio
		{ratio}
		class="overflow-hidden rounded-lg border border-border bg-muted shadow-sm transition-shadow hover:shadow-md"
	>
		{#if isImage}
			<img
				src={file_value.url}
				alt={file_value.name}
				class="h-full w-full object-cover"
				loading="lazy"
			/>
		{:else}
			<Stack gap="sm" fill align="center" justify="center" class="p-4 text-center">
				<div class="text-2xl">
					{getFileIcon(category)}
				</div>
				<span class="text-sm font-medium wrap-break-word text-foreground">{file_value.name}</span>
				<span class="text-xs text-muted-foreground">{formatFileSize(file_value.size)}</span>
			</Stack>
		{/if}
	</AspectRatio>
</div>
