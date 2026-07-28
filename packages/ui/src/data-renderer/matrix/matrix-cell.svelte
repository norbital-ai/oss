<script lang="ts" generics="TRow extends MatrixRow">
	import { cn } from '#lib/utils';
	import { DataRenderer } from '../index.js';
	import RelationshipRenderer from '../relationship/relationship.renderer.svelte';
	import type { MatrixColumn, MatrixRow } from './matrix.renderer.svelte';

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
	const relationTarget = $derived(column.relationOptions ? (column.field.relation?.target ?? null) : null);
	const value = $derived(row[column.key]);
</script>

{#if relationTarget}
	<!-- The column supplied an option set, so it wants a record picker. Without `relationOptions`
	     the value is a uuid and renders as text like any other column. -->
	<RelationshipRenderer
		target={relationTarget}
		value={typeof value === 'string' ? value : null}
		multiple={column.field.array ?? false}
		options={column.relationOptions}
		placeholder={column.placeholder}
		{disabled}
		class={className}
		{onValueChange}
	/>
{:else}
	<DataRenderer
		id={`matrix-${row.__matrixRowId}-${column.key}`}
		field={column.field}
		{value}
		mode="edit"
		{disabled}
		placeholder={column.placeholder}
		{row}
		class={className}
		{onValueChange}
		{onRowChange}
	/>
{/if}
