<script lang="ts" generics="TRow extends MatrixRow">
	import { cn } from '#lib/utils';
	import { DataRenderer, type FieldRendererComponent } from '#lib/data-renderer';
	import type { MatrixColumn, MatrixRow } from './matrix.types.js';

	interface Props {
		row: Record<string, unknown> & { __matrixRowId: string };
		column: MatrixColumn<TRow>;
		disabled: boolean;
		readonly?: boolean;
		borderless: boolean;
		onValueChange: (value: unknown) => void;
		onRowChange: (patch: Record<string, unknown>) => void;
	}

	let {
		row,
		column,
		disabled,
		readonly = false,
		borderless,
		onValueChange,
		onRowChange
	}: Props = $props();
	const value = $derived(row[column.key]);
	const readOnly = $derived(column.readOnly === true);
</script>

<DataRenderer
	id={`matrix-${row.__matrixRowId}-${column.key}`}
	field={column.field}
	{value}
	mode={readonly || readOnly ? 'display' : 'edit'}
	disabled={disabled || readOnly}
	placeholder={column.placeholder}
	{row}
	class={cn('w-full min-w-0', borderless && 'border-0 bg-transparent shadow-none')}
	renderer={column.renderer as FieldRendererComponent | undefined}
	relationOptions={column.relationOptions}
	{onValueChange}
	{onRowChange}
/>
