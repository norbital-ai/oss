<script lang="ts">
	import { DataGrid, type DataGridColumn } from '@norbital-ai/ui/collection-table';

	type Row = { deploymentId: string; name: string; status: string };

	let generation = $state(0);
	let expandedRowIds = $state<string[]>([]);
	let rows = $state<Row[]>([
		{ deploymentId: 'deployment-1', name: 'First deployment', status: 'queued' }
	]);
	const disclosureProps = $derived({
		expandedRowIds,
		onExpandedRowIdsChange: (next: string[]) => (expandedRowIds = next)
	});

	const columns: readonly DataGridColumn<Row>[] = [
		{ id: 'name', label: 'Deployment', value: (row) => row.name }
	];

	function poll(): void {
		rows = rows.map((row) => ({
			...row,
			status: row.status === 'queued' ? 'running' : 'completed'
		}));
	}

	function pollAndRemount(): void {
		poll();
		generation += 1;
	}
</script>

{#snippet details(row: Row)}
	<div data-testid="deployment-details">Details for {row.name}</div>
{/snippet}

<button type="button" data-testid="poll" onclick={poll}>Poll</button>
<button type="button" data-testid="poll-and-remount" onclick={pollAndRemount}>
	Poll and remount
</button>
<output data-testid="expanded-ids">{expandedRowIds.join(',')}</output>
{#key generation}
	<DataGrid
		{rows}
		rowId={(row) => row.deploymentId}
		{columns}
		view="controlled-disclosure-test"
		{...disclosureProps}
		{details}
	/>
{/key}
