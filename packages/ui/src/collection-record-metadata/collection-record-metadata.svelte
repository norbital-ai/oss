<script lang="ts">
	import Icon from '@iconify/svelte';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { cn } from '#lib/utils';
	import type {
		CollectionRecordFlagTone,
		ResolvedCollectionRecordMetadata
	} from '#lib/collection-record-metadata/collection-record-metadata';
	import { collectionRecordMetadataDescription } from '#lib/collection-record-metadata/collection-record-metadata';

	let {
		metadata,
		display = 'compact',
		class: className
	}: {
		metadata: readonly ResolvedCollectionRecordMetadata[];
		display?: 'compact' | 'notice';
		class?: string;
	} = $props();

	const { t } = useI18n<UiKeys>();

	function iconFor(entry: ResolvedCollectionRecordMetadata): string {
		if (entry.kind === 'flag' && entry.icon) return entry.icon;
		if (entry.kind === 'restriction') {
			return entry.source === 'system' ? 'lucide:shield-check' : 'lucide:lock-keyhole';
		}
		switch (entry.tone) {
			case 'info':
				return 'lucide:info';
			case 'success':
				return 'lucide:circle-check';
			case 'warning':
				return 'lucide:triangle-alert';
			case 'danger':
				return 'lucide:octagon-alert';
			case 'neutral':
				return 'lucide:flag';
		}
	}

	function labelFor(entry: ResolvedCollectionRecordMetadata): string {
		if (entry.label) return entry.label;
		if (entry.kind === 'flag') return entry.label;
		const updateRestricted = entry.operations.includes('update');
		const deleteRestricted = entry.operations.includes('delete');
		if (updateRestricted && deleteRestricted) return t('recordMetadata.readOnly');
		return updateRestricted
			? t('recordMetadata.updatesRestricted')
			: t('recordMetadata.deletionRestricted');
	}

	function toneClass(tone: CollectionRecordFlagTone): string {
		switch (tone) {
			case 'info':
				return 'border-info/30 bg-info/10 text-info';
			case 'success':
				return 'border-success/30 bg-success/10 text-success';
			case 'warning':
				// warning-foreground is the dark ink for a solid amber badge. On a translucent
				// warning surface in dark mode it becomes dark-on-dark, so the tint uses amber itself.
				return 'border-warning/40 bg-warning/10 text-warning-foreground dark:text-warning';
			case 'danger':
				return 'border-destructive/30 bg-destructive/10 text-destructive';
			case 'neutral':
				return 'border-border bg-muted text-foreground';
		}
	}

	function presentationClass(entry: ResolvedCollectionRecordMetadata): string {
		if (entry.kind === 'flag') return toneClass(entry.tone);
		return entry.source === 'system'
			? 'border-brand/30 bg-brand/10 text-brand'
			: 'border-border bg-muted text-foreground';
	}
</script>

{#if metadata.length > 0}
	{#if display === 'compact'}
		<div class={cn('flex min-w-0 flex-wrap items-center gap-1.5', className)}>
			{#each metadata as entry, index (`${entry.kind}:${entry.source}:${index}`)}
				{@const label = labelFor(entry)}
				{@const description = collectionRecordMetadataDescription(entry)}
				<span
					class={cn(
						'inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium',
						presentationClass(entry)
					)}
					title={description}
					aria-label={`${label}: ${description}`}
				>
					<Icon icon={iconFor(entry)} class="size-3 shrink-0" aria-hidden="true" />
					<span class="truncate">{label}</span>
				</span>
			{/each}
		</div>
	{:else}
		<div class={cn('grid gap-2', className)}>
			{#each metadata as entry, index (`${entry.kind}:${entry.source}:${index}`)}
				<div
					class={cn(
						'flex min-w-0 items-start gap-2.5 rounded-md border px-3 py-2.5',
						presentationClass(entry)
					)}
					role="status"
				>
					<Icon icon={iconFor(entry)} class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
					<div class="min-w-0">
						<p class="text-sm font-semibold">{labelFor(entry)}</p>
						<p class="mt-0.5 text-sm leading-5 opacity-80">
							{collectionRecordMetadataDescription(entry)}
						</p>
					</div>
				</div>
			{/each}
		</div>
	{/if}
{/if}
