<script module lang="ts">
	import type { Snippet } from 'svelte';

	export interface DataGridCellContext<TRow extends object> {
		readonly row: TRow;
		readonly value: unknown;
	}

	export interface DataGridColumn<TRow extends object> {
		readonly id: string;
		readonly label: string;
		readonly width?: number;
		readonly minWidth?: number;
		readonly maxWidth?: number;
		readonly sortable?: boolean;
		readonly resizable?: boolean;
		readonly hideable?: boolean;
		readonly pinnable?: boolean;
		readonly value?: (row: TRow) => unknown;
		readonly render?: (context: DataGridCellContext<TRow>) => unknown;
	}

	export interface DataGridProps<TRow extends object> {
		readonly rows: readonly TRow[];
		readonly rowId: (row: TRow) => string;
		readonly columns: readonly DataGridColumn<TRow>[];
		readonly view: string;
		readonly loading?: boolean;
		readonly error?: string;
		readonly disabled?: boolean;
		readonly class?: string;
		readonly bounded?: boolean;
		readonly emptyPlaceholder?: Snippet;
		readonly details?: Snippet<[TRow]>;
		readonly hasDetails?: (row: TRow) => boolean;
		/** Controlled disclosure state. Bind this above refreshable data to survive grid remounts. */
		expandedRowIds?: string[];
		readonly onExpandedRowIdsChange?: (rowIds: string[]) => void;
	}
</script>

<script lang="ts" generics="TRow extends object">
	import CollectionGrid from './internal/collection-grid.svelte';
	import {
		RowAPI,
		TableAPI,
		type TableSortEntry,
		type TCreateColumnProps
	} from './internal/collection-table-state.svelte.js';

	interface GridRow extends Record<string, unknown> {
		__dataGridRowId: string;
		record: TRow;
	}

	let {
		rows,
		rowId,
		columns,
		view,
		loading = false,
		error = '',
		disabled = false,
		class: className,
		bounded = false,
		emptyPlaceholder,
		details,
		hasDetails,
		expandedRowIds = $bindable<string[] | undefined>(),
		onExpandedRowIdsChange
	}: DataGridProps<TRow> = $props();

	let sort = $state<readonly TableSortEntry[]>([]);
	let internalExpandedRowIds = $state<string[]>([]);
	const resolvedExpandedRowIds = $derived(expandedRowIds ?? internalExpandedRowIds);

	function columnValue(column: DataGridColumn<TRow>, row: TRow): unknown {
		return column.value?.(row) ?? Reflect.get(row, column.id);
	}

	function compareValues(left: unknown, right: unknown): number {
		if (left == null && right == null) return 0;
		if (left == null) return 1;
		if (right == null) return -1;
		if (typeof left === 'number' && typeof right === 'number') return left - right;
		if (typeof left === 'boolean' && typeof right === 'boolean')
			return Number(left) - Number(right);
		return String(left).localeCompare(String(right), undefined, {
			numeric: true,
			sensitivity: 'base'
		});
	}

	// svelte-ignore state_referenced_locally -- a mounted grid keeps one declared column contract.
	const gridColumns: TCreateColumnProps<GridRow>[] = columns.map((column) => ({
		id: column.id,
		header: () => column.label,
		accessor: (row: RowAPI<GridRow>) => columnValue(column, row.raw.record),
		cell: ({ row }: { row: RowAPI<GridRow> }) => {
			const value = columnValue(column, row.raw.record);
			return column.render?.({ row: row.raw.record, value }) ?? String(value ?? '');
		},
		width: column.width,
		minWidth: column.minWidth,
		maxWidth: column.maxWidth,
		enableSorting: column.sortable ?? true,
		enableResizing: column.resizable ?? true,
		enableHiding: column.hideable ?? false,
		enablePinning: column.pinnable ?? false
	}));

	// svelte-ignore state_referenced_locally -- view is the stable identity of this mounted grid.
	const table = new TableAPI<GridRow>({
		rowKey: '__dataGridRowId',
		persistenceKey: view,
		viewKey: view,
		persistState: false,
		columns: gridColumns,
		conditionDefault: undefined,
		parseCondition: () => undefined,
		callbacks: {
			onSortChange: (next) => (sort = next),
			onExpandedChange: (next) => {
				if (expandedRowIds === undefined) internalExpandedRowIds = next;
				else expandedRowIds = next;
				onExpandedRowIdsChange?.(next);
			}
		}
	});

	const sortedRows = $derived.by(() => {
		const output = rows.map((record) => ({ __dataGridRowId: rowId(record), record }));
		if (sort.length === 0) return output;
		return [...output].sort((left, right) => {
			for (const entry of sort) {
				const columnId = entry.field.replace(/^default\./, '');
				const column = columns.find((candidate) => candidate.id === columnId);
				if (!column) continue;
				const result = compareValues(
					columnValue(column, left.record),
					columnValue(column, right.record)
				);
				if (result !== 0) return entry.order === 'asc' ? result : -result;
			}
			return 0;
		});
	});

	// The table instance is external state: it is fed through its own setters rather than by
	// reaching into its fields, so the write is a call a reader can follow into the class.
	$effect(() => {
		table.setData(sortedRows);
		table.setTotalRows(sortedRows.length);
	});

	$effect(() => {
		// The parent owns disclosure identity. Polling may replace every row object — or remount this
		// grid through a refreshed tab snippet — without being allowed to collapse a row the person
		// explicitly opened. Missing ids are intentionally retained so a transient empty result cannot
		// erase the choice before the next snapshot arrives.
		table.setExpanded(Object.fromEntries(resolvedExpandedRowIds.map((rowKey) => [rowKey, true])));
	});
</script>

{#snippet rowDetails({ row }: { row: RowAPI<GridRow> })}
	{#if details}
		{@render details(row.raw.record)}
	{/if}
{/snippet}

<CollectionGrid
	{table}
	{disabled}
	class={className}
	isLoading={loading}
	{error}
	enableSorting
	enableColumnReordering={false}
	enableRowExpansion={details != null}
	getRowHasChildren={(row) => details != null && (hasDetails?.(row.record) ?? true)}
	subComponent={details ? rowDetails : undefined}
	{emptyPlaceholder}
	{bounded}
/>
