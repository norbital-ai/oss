<script lang="ts" generics="TRow extends MatrixRow">
	import { cn } from '#lib/utils';
	import { DataRenderer } from '#lib/data-renderer';
	import RelationshipRenderer from '../relationship/relationship.renderer.svelte';
	import type { MatrixColumn, MatrixRow } from './matrix.types.js';

	interface Props {
		row: Record<string, unknown> & { __matrixRowId: string };
		column: MatrixColumn<TRow>;
		disabled: boolean;
		borderless: boolean;
		onValueChange: (value: unknown) => void;
		onRowChange: (patch: Record<string, unknown>) => void;
	}

	let { row, column, disabled, borderless, onValueChange, onRowChange }: Props = $props();
	const className = $derived(
		cn('w-full min-w-0', borderless && 'border-0 bg-transparent shadow-none')
	);
	const relationTarget = $derived(
		column.relationOptions ? (column.field.relation?.target ?? null) : null
	);
	const value = $derived(row[column.key]);
	const readOnly = $derived(column.readOnly === true);
</script>

{#if column.renderer}
	{@const Renderer = column.renderer}
	<Renderer
		row={row as TRow}
		{value}
		field={column.field}
		disabled={disabled || readOnly}
		{onValueChange}
		{onRowChange}
	/>
{:else if relationTarget}
	<!-- The column supplied an option set, so it wants a record picker. Without `relationOptions`
	     the value is a uuid and renders as text like any other column. -->
	<RelationshipRenderer
		target={relationTarget}
		value={typeof value === 'string' ? value : null}
		multiple={column.field.array ?? false}
		options={column.relationOptions}
		placeholder={column.placeholder}
		disabled={disabled || readOnly}
		readonly={readOnly}
		displayOnly={readOnly}
		class={className}
		{onValueChange}
	/>
{:else}
	<DataRenderer
		id={`matrix-${row.__matrixRowId}-${column.key}`}
		field={column.field}
		{value}
		mode={readOnly ? 'display' : 'edit'}
		disabled={disabled || readOnly}
		placeholder={column.placeholder}
		{row}
		class={className}
		{onValueChange}
		{onRowChange}
	/>
{/if}
