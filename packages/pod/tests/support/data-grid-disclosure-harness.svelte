<script lang="ts">
	import { DataGrid, type DataGridColumn } from '@norbital-ai/ui/collection-table';

	type Row = { id: string; name: string };

	let generation = $state(0);
	let expandedRowIds = $state<string[]>([]);
	let rows = $state<Row[]>([{ id: 'deployment-1', name: 'First deployment' }]);

	const columns: readonly DataGridColumn<Row>[] = [
		{ id: 'name', label: 'Deployment', value: (row) => row.name }
	];

	function pollAndRemount(): void {
		rows = rows.map((row) => ({ ...row }));
		generation += 1;
	}
</script>

{#snippet details(row: Row)}
	<div data-testid="deployment-details">Details for {row.name}</div>
{/snippet}

<button type="button" data-testid="poll" onclick={pollAndRemount}>Poll</button>
<output data-testid="expanded-ids">{expandedRowIds.join(',')}</output>
{#key generation}
	<DataGrid
		{rows}
		rowId={(row) => row.id}
		{columns}
		view="controlled-disclosure-test"
		bind:expandedRowIds
		{details}
	/>
{/key}
