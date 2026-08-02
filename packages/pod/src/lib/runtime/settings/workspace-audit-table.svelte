<script lang="ts">
	import type {
		CollectionClient,
		CollectionRecord,
		ErasedCollectionRegistry
	} from '@norbital-ai/platform-utils/collection';
	import { CollectionTable } from '@norbital-ai/ui/collection-table';
	import { Inline, Stack } from '@norbital-ai/ui/layout';
	import { cn, renderSnippet } from '@norbital-ai/ui/utils';

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
		)}>{text(row, 'event_type') ?? 'event'}</span
	>
{/snippet}

<CollectionTable
	{client}
	collection="audit_event"
	view="workspace-settings-audit"
	query={{ orderBy: { norbital_created_at: 'desc' }, limit: 100 }}
	title="Audit events"
	description="Append-only tenant activity recorded beside the data it describes."
	features={{ search: true, filter: true, bulk: false, create: false }}
	class="h-[min(42rem,calc(100dvh-14rem))] min-h-[28rem]"
>
	{#snippet columns({ Column })}
		<Column
			name="event_type"
			label="Event"
			width={120}
			render={({ row }) => renderSnippet(eventCell, { row })}
		/>
		<Column name="collection_name" label="Collection" minWidth={170} />
		<Column
			name="actor_id"
			label="Actor"
			minWidth={150}
			render={({ row }) => (text(row, 'actor_id') ? `${text(row, 'actor_id')!.slice(0, 8)}…` : '—')}
		/>
		<Column
			name="norbital_created_at"
			label="Timestamp"
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
				{text(row, 'collection_name') ?? 'System'}
			</p>
		</Stack>
	{/snippet}
</CollectionTable>
