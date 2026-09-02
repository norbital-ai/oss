<script lang="ts" module>
	import type {
		MatrixCellRendererProps,
		MatrixColumn,
		MatrixRendererAddRowsProps,
		MatrixRendererBaseProps,
		MatrixRendererProps,
		MatrixRow,
		MatrixRowActionProps
	} from './matrix.types.js';

	export type {
		MatrixCellRendererProps,
		MatrixColumn,
		MatrixRendererProps,
		MatrixRow,
		MatrixRowActionProps
	};
</script>

<script lang="ts" generics="TRow extends MatrixRow">
	import type { Snippet } from 'svelte';
	import Icon from '@iconify/svelte';
	import MatrixCell from './matrix-cell.svelte';
	import {
		CollectionGrid,
		ColumnAPI,
		RowAPI,
		TableAPI,
		type TableSortEntry,
		type TCreateColumnProps
	} from '#lib/collection-table/internal';
	import { collectionTableColumnCanSort } from '#lib/collection-table/collection-table.types';
	import { Bound, Inline, Scroll, Stack } from '#lib/layout';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { cn, renderSnippet } from '#lib/utils';
	import { decodeNumber } from '@norbital-ai/std/json';
	import { watch } from 'runed';
	type TableRow = Record<string, unknown> & { __matrixRowId: string };

	const { t } = useI18n<UiKeys>();

	let {
		rows = $bindable(),
		columns,
		disabled = false,
		emptyMessage = t('dataRenderer.noRows'),
		class: className,
		bounded = true,
		getRowId,
		isRowDisabled,
		allowAddRows = true,
		createRow,
		addRowLabel = t('dataRenderer.addRow'),
		addRowDisabled = false,
		allowRemoveRows = true,
		canRemoveRow,
		extraRowActions,
		onChange
	}: MatrixRendererProps<TRow> = $props();

	function commitRows(nextRows: TRow[]): void {
		rows = nextRows;
		onChange?.(nextRows);
	}

	function resolveRowId(row: TRow, index: number): string {
		if (getRowId) return getRowId(row, index);
		if (typeof row.id === 'string') return row.id;
		return `row-${index}`;
	}

	function resolveSource(tableRow: TableRow): { row: TRow; index: number } | null {
		const index = rows.findIndex(
			(sourceRow, sourceIndex) => resolveRowId(sourceRow, sourceIndex) === tableRow.__matrixRowId
		);
		if (index < 0) return null;
		const row = rows[index];
		return row == null ? null : { row, index };
	}

	function rowRemovable(row: TRow, index: number): boolean {
		if (!allowRemoveRows || disabled) return false;
		return canRemoveRow?.(row, index) ?? true;
	}

	function updateCell(rowId: string, column: MatrixColumn<TRow>, value: unknown): void {
		commitRows(
			rows.map((row, index) => {
				if (resolveRowId(row, index) !== rowId) return row;
				const nextRow = { ...row };
				Reflect.set(nextRow, column.key, value);
				return nextRow;
			})
		);
	}

	function patchRow(rowId: string, patch: Record<string, unknown>): void {
		commitRows(
			rows.map((sourceRow, index) =>
				resolveRowId(sourceRow, index) === rowId ? Object.assign({}, sourceRow, patch) : sourceRow
			)
		);
	}

	function removeRow(rowId: string): void {
		const match = rows.findIndex((row, index) => resolveRowId(row, index) === rowId);
		if (match < 0) return;
		const row = rows[match];
		if (row == null || !rowRemovable(row, match)) return;
		commitRows(rows.filter((_, index) => index !== match));
	}

	function toTableRow(row: TRow, index: number): TableRow {
		const tableRow: TableRow = { __matrixRowId: resolveRowId(row, index) };
		Object.assign(tableRow, row);
		return tableRow;
	}

	const tableRows = $derived.by((): TableRow[] => rows.map((row, index) => toTableRow(row, index)));

	const tableApi = new TableAPI<TableRow, unknown>({
		rowKey: '__matrixRowId',
		persistenceKey: 'matrix-renderer',
		viewKey: 'matrix-renderer',
		persistState: false,
		conditionDefault: undefined,
		parseCondition: (condition) => condition
	});

	function compareValues(left: unknown, right: unknown): number {
		if (left == null && right == null) return 0;
		if (left == null) return 1;
		if (right == null) return -1;
		if (typeof left === 'number' && typeof right === 'number') return left - right;
		if (typeof left === 'boolean' && typeof right === 'boolean') {
			return decodeNumber(left ? 1 : 0) - decodeNumber(right ? 1 : 0);
		}
		return String(left).localeCompare(String(right));
	}

	function columnIdFromSortField(field: string): string {
		return field.startsWith('default.') ? field.slice('default.'.length) : field;
	}

	function sortRows(sourceRows: TableRow[], sort: TableSortEntry[]): TableRow[] {
		if (sort.length === 0) return sourceRows;
		return [...sourceRows].sort((left, right) => {
			for (const entry of sort) {
				const result = compareValues(
					left[columnIdFromSortField(entry.field)],
					right[columnIdFromSortField(entry.field)]
				);
				if (result !== 0) return entry.order === 'asc' ? result : -result;
			}
			return 0;
		});
	}

	const displayRows = $derived.by(() => sortRows(tableRows, tableApi.sort.current));

	watch(
		() => displayRows,
		(nextRows) => {
			tableApi.setData(nextRows);
			tableApi.setTotalRows(nextRows.length);
		},
		{ lazy: false }
	);

	const columnDefinitions = $derived.by((): TCreateColumnProps<TableRow, unknown>[] =>
		columns.map((column) => ({
			id: column.key,
			header: () => column.label,
			accessor: (row) => row.raw[column.key],
			cell: ({ row }) => renderSnippet(matrixCell, { row, column }),
			width: column.width,
			enableSorting: collectionTableColumnCanSort(column.field, {}),
			enableResizing: true,
			enableHiding: false,
			enablePinning: false,
			enableSelection: false
		}))
	);

	watch(
		() => columnDefinitions,
		(nextColumns) => {
			tableApi.setColumns(
				nextColumns.map((column) => new ColumnAPI({ ...column, table: tableApi }))
			);
		},
		{ lazy: false }
	);

	const showRowActionsColumn = $derived(
		allowRemoveRows || (extraRowActions != null && extraRowActions.length > 0)
	);

	const gridRowActions = $derived.by(
		(): Snippet<
			[{ row: RowAPI<TableRow, unknown>; table: TableAPI<TableRow, unknown>; hovered: boolean }]
		>[] => (showRowActionsColumn ? [matrixRowActions] : [])
	);
</script>

{#snippet matrixCell({
	row,
	column
}: {
	row: RowAPI<TableRow, unknown>;
	column: MatrixColumn<TRow>;
})}
	{@render matrixCellEditor(row.raw, column, true)}
{/snippet}

{#snippet matrixCellEditor(tableRow: TableRow, column: MatrixColumn<TRow>, borderless: boolean)}
	{@const source = resolveSource(tableRow)}
	{@const cellDisabled =
		source == null ? disabled : disabled || isRowDisabled?.(source.row, source.index) === true}
	<MatrixCell
		row={tableRow}
		{column}
		disabled={cellDisabled}
		{borderless}
		onValueChange={(value) => updateCell(tableRow.__matrixRowId, column, value)}
		onRowChange={(patch) => patchRow(tableRow.__matrixRowId, patch)}
	/>
{/snippet}

{#snippet matrixRowActions({
	row,
	hovered
}: {
	row: RowAPI<TableRow, unknown>;
	table: TableAPI<TableRow, unknown>;
	hovered: boolean;
})}
	{@const source = resolveSource(row.raw)}
	{#if source}
		{@const rowDisabled = isRowDisabled?.(source.row, source.index) === true}
		{#each extraRowActions ?? [] as action, actionIndex (actionIndex)}
			{@render action({
				row: source.row,
				index: source.index,
				hovered,
				disabled,
				rowDisabled
			})}
		{/each}
		{#if rowRemovable(source.row, source.index)}
			<button
				type="button"
				aria-label={t('dataRenderer.removeRow')}
				tabindex={hovered ? 0 : -1}
				class={cn(
					'inline-flex size-8 items-center justify-center rounded-sm text-destructive outline-none hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
					hovered ? undefined : 'opacity-0'
				)}
				onclick={(event) => {
					event.preventDefault();
					event.stopPropagation();
					removeRow(row.raw.__matrixRowId);
				}}
			>
				<Icon icon="lucide:trash-2" class="size-4" />
			</button>
		{/if}
	{/if}
{/snippet}

{#snippet emptyPlaceholder()}
	<div class="p-4 text-sm text-muted-foreground">{emptyMessage}</div>
{/snippet}

<Stack
	gap="none"
	grow={bounded}
	class={cn(
		'matrix-renderer min-h-0 min-w-0 bg-card [container-type:inline-size]',
		bounded ? 'max-h-[min(70dvh,36rem)] overflow-hidden' : 'max-h-none',
		className
	)}
	data-data-matrix-surface
>
	<div class="matrix-renderer-wide flex min-h-0 min-w-0 flex-1 flex-col">
		{#if bounded}
			<Bound size="full" clip>
				<CollectionGrid
					class="min-h-0 flex-1"
					table={tableApi}
					{disabled}
					isLoading={false}
					error=""
					enableSorting={true}
					enableColumnReordering={false}
					enableRowExpansion={false}
					enableRowReordering={false}
					borderless={true}
					stickyRowActions={true}
					bounded={true}
					rowActions={gridRowActions}
					{emptyPlaceholder}
				/>
			</Bound>
		{:else}
			<CollectionGrid
				class="min-h-0"
				table={tableApi}
				{disabled}
				isLoading={false}
				error=""
				enableSorting={true}
				enableColumnReordering={false}
				enableRowExpansion={false}
				enableRowReordering={false}
				borderless={true}
				stickyRowActions={true}
				bounded={false}
				rowActions={gridRowActions}
				{emptyPlaceholder}
			/>
		{/if}
	</div>
	<div class="matrix-renderer-narrow flex min-h-0 min-w-0 flex-1 flex-col">
		{#if bounded}
			<Scroll axis="y" name={t('dataRenderer.matrixRows')} grow class="overscroll-y-contain">
				{@render narrowRows()}
			</Scroll>
		{:else}
			{@render narrowRows()}
		{/if}
	</div>
	{#if allowAddRows && createRow}
		<div class="shrink-0 border-t border-border px-2 py-1">
			<button
				type="button"
				class="h-8 rounded-sm px-2 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
				disabled={disabled || addRowDisabled}
				onclick={() => commitRows([...rows, createRow()])}
			>
				<Inline gap="xs" fill>
					<Icon icon="lucide:plus" class="size-4" />
					<span>{addRowLabel}</span>
				</Inline>
			</button>
		</div>
	{/if}
</Stack>

{#snippet narrowRows()}
	{#if displayRows.length === 0}
		{@render emptyPlaceholder()}
	{:else}
		<div class="divide-y divide-border">
			{#each displayRows as tableRow (tableRow.__matrixRowId)}
				{@const source = resolveSource(tableRow)}
				<section class="matrix-renderer-narrow-row group relative overflow-hidden">
					{#if source && showRowActionsColumn}
						{@const rowDisabled = isRowDisabled?.(source.row, source.index) === true}
						<div
							class="absolute inset-y-0 right-0 flex w-16 items-stretch bg-destructive text-destructive-foreground"
						>
							{#each extraRowActions ?? [] as action, actionIndex (actionIndex)}
								{@render action({
									row: source.row,
									index: source.index,
									hovered: true,
									disabled,
									rowDisabled
								})}
							{/each}
							{#if rowRemovable(source.row, source.index)}
								<button
									type="button"
									class="flex w-full items-center justify-center outline-none hover:bg-destructive/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
									aria-label={t('dataRenderer.removeRow')}
									onclick={() => removeRow(tableRow.__matrixRowId)}
								>
									<Icon icon="lucide:trash-2" class="size-4" />
								</button>
							{/if}
						</div>
					{/if}
					<Stack
						gap="sm"
						class="matrix-renderer-narrow-row-content relative z-10 bg-card px-3 py-3"
					>
						{#each columns as column (column.key)}
							<Stack gap="xs">
								<p class="text-overline">
									{column.label}
								</p>
								{@render matrixCellEditor(tableRow, column, false)}
							</Stack>
						{/each}
					</Stack>
				</section>
			{/each}
		</div>
	{/if}
{/snippet}

<style>
	.matrix-renderer {
		min-width: 0;
	}

	.matrix-renderer-narrow {
		display: none;
	}

	.matrix-renderer-narrow-row-content {
		transition: transform 150ms cubic-bezier(0.22, 1, 0.36, 1);
	}

	.matrix-renderer-narrow-row:hover .matrix-renderer-narrow-row-content,
	.matrix-renderer-narrow-row:focus-within .matrix-renderer-narrow-row-content {
		transform: translateX(-4rem);
	}

	@media (prefers-reduced-motion: reduce) {
		.matrix-renderer-narrow-row-content {
			transition: none;
		}
	}

	/* Matrix keeps the grid through sheet widths (~520px). Stacked cards only kick in for
	   phone-narrow containers — unlike CollectionTable's 48rem list swap. */
	@container (max-width: 23.999rem) {
		.matrix-renderer-wide {
			display: none;
		}

		.matrix-renderer-narrow {
			display: flex;
		}
	}
</style>
