<script lang="ts">
	import Icon from '@iconify/svelte';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { Tooltip } from '#lib/tooltip';
	import { Stack } from '#lib/layout';
	import type { FileMetadata } from '#lib/file-value/file-value.types';

	let {
		metadata,
		class: className,
		iconClass,
		preventDefault = false
	}: {
		metadata: FileMetadata;
		class?: string;
		iconClass?: string;
		preventDefault?: boolean;
	} = $props();

	const { t } = useI18n<UiKeys>();

	const hasMetadata = $derived(Boolean(metadata.summary || metadata.structure_hint));
</script>

{#if hasMetadata}
	<Tooltip align="end" side="top" contentClass="max-w-sm">
		{#snippet trigger({ props })}
			<button
				type="button"
				{...props}
				class={className}
				aria-label={t('misc.viewSummary')}
				onclick={(event) => {
					event.stopPropagation();
					if (preventDefault) event.preventDefault();
				}}
			>
				<Icon icon="lucide:info" class={iconClass} />
			</button>
		{/snippet}
		{#snippet content()}
			<Stack gap="xs">
				{#if metadata.structure_hint}
					<div class="text-xs font-medium text-foreground">{metadata.structure_hint}</div>
				{/if}
				{#if metadata.summary}
					<div class="text-meta">{metadata.summary}</div>
				{/if}
			</Stack>
		{/snippet}
	</Tooltip>
{/if}
