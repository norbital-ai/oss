<script lang="ts">
	import Icon from '@iconify/svelte';
	import { Tooltip } from '#lib/tooltip';
	import type { FileMetadata } from './file-value.types.js';

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

	const hasMetadata = $derived(Boolean(metadata.summary || metadata.structure_hint));
</script>

{#if hasMetadata}
	<Tooltip align="end" side="top" contentClass="max-w-sm">
		{#snippet trigger({ props })}
			<button
				type="button"
				{...props}
				class={className}
				aria-label="View summary"
				onclick={(event) => {
					event.stopPropagation();
					if (preventDefault) event.preventDefault();
				}}
			>
				<Icon icon="lucide:info" class={iconClass} />
			</button>
		{/snippet}
		{#snippet content()}
			<div class="space-y-1">
				{#if metadata.structure_hint}
					<div class="text-xs font-medium text-foreground">{metadata.structure_hint}</div>
				{/if}
				{#if metadata.summary}
					<div class="text-xs text-muted-foreground">{metadata.summary}</div>
				{/if}
			</div>
		{/snippet}
	</Tooltip>
{/if}
