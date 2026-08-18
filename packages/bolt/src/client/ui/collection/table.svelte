<script lang="ts">
	import { Stack } from '@norbital-ai/ui/layout';
	import { SvelteSet } from 'svelte/reactivity';
	import { getAgentRuntime } from '../agent/client.js';
	import CollectionRecordDetail from './record-detail.svelte';

	interface Row extends Readonly<Record<string, unknown>> {
		readonly norbital_id?: string;
	}

	interface TimelineEvent {
		readonly id?: string;
		readonly kind: string;
		readonly subjectId?: string;
		readonly payload?: unknown;
		readonly at?: string;
	}

	let {
		rows = [],
		loading = false,
		error,
		emptyMessage = 'No records',
		onselect,
		onretry,
		timeline = [],
		approvalId = null,
		locked = false,
		onapprove,
		onreject,
		onwithdraw
	}: {
		rows?: ReadonlyArray<Row>;
		loading?: boolean;
		error?: string;
		emptyMessage?: string;
		onselect?: (row: Row) => void;
		onretry?: () => void;
		timeline?: ReadonlyArray<TimelineEvent>;
		approvalId?: string | null;
		locked?: boolean;
		onapprove?: () => void;
		onreject?: () => void;
		onwithdraw?: () => void;
	} = $props();

	let selected = $state<Row | null>(null);
	let fetchedTimeline = $state<ReadonlyArray<TimelineEvent>>([]);
	const loadedTimeline = $derived(timeline.length > 0 ? timeline : fetchedTimeline);

	const columns = $derived.by(() => {
		if (rows.length === 0) return [] as string[];
		const keys = new SvelteSet<string>();
		for (const row of rows) {
			for (const key of Object.keys(row)) {
				if (key !== 'norbital_id') keys.add(key);
			}
		}
		return [...keys];
	});

	const readApprovalId = (record: Row | null): string | null => {
		if (record === null) return approvalId;
		const value = Reflect.get(record, 'norbital_approval_id');
		return typeof value === 'string' && value.length > 0 ? value : approvalId;
	};

	const recordLocked = (record: Row | null): boolean => {
		if (locked) return true;
		if (record === null) return false;
		if (readApprovalId(record) !== null) return true;
		return Reflect.get(record, 'approvalLock') === true;
	};

	const asTimeline = (value: unknown): ReadonlyArray<TimelineEvent> => {
		if (!Array.isArray(value)) return [];
		return value.flatMap((entry) => {
			if (entry === null || typeof entry !== 'object') return [];
			const kind = Reflect.get(entry, 'kind');
			if (typeof kind !== 'string' || kind.length === 0) return [];
			const id = Reflect.get(entry, 'id');
			const subjectId = Reflect.get(entry, 'subjectId');
			const at = Reflect.get(entry, 'at');
			return [
				{
					kind,
					payload: Reflect.get(entry, 'payload'),
					...(typeof id === 'string' ? { id } : {}),
					...(typeof subjectId === 'string' ? { subjectId } : {}),
					...(typeof at === 'string' ? { at } : {})
				}
			];
		});
	};

	const selectRow = (row: Row): void => {
		selected = row;
		onselect?.(row);
		const requestId = readApprovalId(row);
		if (requestId === null || timeline.length > 0) {
			fetchedTimeline = [];
			return;
		}
		const runtime = getAgentRuntime();
		if (runtime === undefined) {
			fetchedTimeline = [];
			return;
		}
		void runtime.transport
			.command('approvals.timeline', { requestId })
			.then((value) => {
				fetchedTimeline = asTimeline(value);
			})
			.catch(() => {
				fetchedTimeline = [];
			});
	};

	const formatCell = (value: unknown): string => {
		if (value === null || value === undefined) return '—';
		if (typeof value === 'object') return JSON.stringify(value);
		return String(value);
	};
</script>

<section aria-label="Collection records" aria-busy={loading} class="p-4 sm:p-6">
	{#if error !== undefined}
		<div
			role="alert"
			class="rounded-lg border border-destructive/30 bg-card p-4 text-sm text-destructive"
		>
			<p>{error}</p>
			{#if onretry !== undefined}
				<button type="button" class="mt-2 underline" onclick={onretry}>Try again</button>
			{/if}
		</div>
	{:else if loading && rows.length === 0}
		<p role="status" class="text-sm text-muted-foreground">Loading records…</p>
	{:else if rows.length === 0}
		<p class="text-sm text-muted-foreground">{emptyMessage}</p>
	{:else}
		<Stack gap="sm">
			<div class="overflow-x-auto rounded-lg border border-border bg-card">
				<table class="w-full min-w-[32rem] border-collapse text-sm">
					<thead>
						<tr class="border-b border-border bg-muted/40">
							{#each columns as column (column)}
								<th
									scope="col"
									class="px-3 py-2 text-left text-xs font-medium tracking-wide text-muted-foreground uppercase"
								>
									{column}
								</th>
							{/each}
						</tr>
					</thead>
					<tbody>
						{#each rows as row, index (row.norbital_id ?? `row-${index}`)}
							<tr class="border-b border-border last:border-b-0 hover:bg-muted/30">
								{#each columns as column, columnIndex (column)}
									<td class="px-3 py-2 align-top text-foreground">
										{#if columnIndex === 0}
											<button type="button" class="w-full text-left" onclick={() => selectRow(row)}>
												<span class="line-clamp-2">{formatCell(row[column])}</span>
											</button>
										{:else}
											<span class="line-clamp-2">{formatCell(row[column])}</span>
										{/if}
									</td>
								{/each}
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			{#if loading}
				<p role="status" class="text-xs text-muted-foreground">Refreshing records…</p>
			{/if}
			<CollectionRecordDetail
				record={selected}
				timeline={loadedTimeline}
				approvalId={readApprovalId(selected)}
				locked={recordLocked(selected)}
				{onapprove}
				{onreject}
				{onwithdraw}
			/>
		</Stack>
	{/if}
</section>
