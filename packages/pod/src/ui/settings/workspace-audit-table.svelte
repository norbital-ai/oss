<script lang="ts">
	import type {
		CollectionClient,
		CollectionRecord,
		ErasedCollectionRegistry
	} from '@norbital-ai/platform-utils/collection';
	import { CollectionTable } from '@norbital-ai/ui/collection-table';
	import { Bound, Inline, Stack } from '@norbital-ai/ui/layout';
	import { cn, renderSnippet } from '@norbital-ai/ui/utils';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import type { PodUiKeys } from '$lib/i18n/index.js';

	const { t } = useI18n<PodUiKeys>();

	type AuditRow = CollectionRecord;
	let { client }: { client: CollectionClient<ErasedCollectionRegistry> } = $props();
	const text = (row: AuditRow, field: string): string | null =>
		typeof row[field] === 'string' ? row[field] : null;
	function formatDate(value: string | null): string {
		if (!value) return '—';
		const date = new Date(value);
		return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
	}
</script>

{#snippet eventCell({ row }: { row: AuditRow })}
	<span
		class={cn(
			'inline-flex rounded-full px-2 py-0.5 text-xs font-medium',
			text(row, 'event_type') === 'create'
				? 'bg-success/10 text-success'
				: text(row, 'event_type') === 'delete'
					? 'bg-destructive/10 text-destructive'
					: 'bg-primary/10 text-primary'
		)}>{text(row, 'event_type') ?? t('pod.settings.event')}</span
	>
{/snippet}

<Bound size="fit">
	<CollectionTable
		{client}
		collection="audit_event"
		view="workspace-settings-audit"
		query={{ orderBy: { norbital_created_at: 'desc' }, limit: 100 }}
		title={t('pod.settings.auditEvents')}
		description={t('pod.settings.auditEventsDescription')}
		features={{ search: true, filter: true, bulk: false, create: false }}
	>
		{#snippet columns({ Column })}
			<Column
				name="event_type"
				label={t('pod.settings.event')}
				width={120}
				render={({ row }) => renderSnippet(eventCell, { row })}
			/>
			<Column name="collection_name" label={t('pod.settings.collection')} minWidth={170} />
			<Column
				name="actor_id"
				label={t('pod.settings.actor')}
				minWidth={150}
				render={({ row }) => (text(row, 'actor_id') ? `${text(row, 'actor_id')!.slice(0, 8)}…` : '—')}
			/>
			<Column
				name="norbital_created_at"
				label={t('pod.settings.timestamp')}
				minWidth={190}
				render={({ row }) => formatDate(text(row, 'norbital_created_at'))}
			/>
		{/snippet}
		{#snippet ListCard(row)}
			<Stack gap="sm">
				<Inline justify="between" gap="md"
					>{@render eventCell({ row })}<span class="text-xs text-muted-foreground"
						>{formatDate(text(row, 'norbital_created_at'))}</span
					></Inline
				>
				<p class="truncate text-xs text-muted-foreground">
					{text(row, 'collection_name') ?? t('pod.settings.system')}
				</p>
			</Stack>
		{/snippet}
	</CollectionTable>
</Bound>
