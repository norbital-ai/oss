<script lang="ts">
	import Table from '../src/table/Table.svelte';
	type Item = { id: string; name: string; paid: boolean };
	let { changed }: { changed(next: Item[]): void } = $props();
	let rows = $state<Item[]>([
		{ id: 'a', name: 'Annual leave', paid: true },
		{ id: 'b', name: 'Care leave', paid: false }
	]);
	function remove(row: Item) {
		rows = rows.filter((item) => item !== row);
		changed(rows);
	}
</script>

{#snippet paid({ row }: { row: Item })}
	<input type="checkbox" checked={row.paid} aria-label={`Paid: ${row.name}`} />
{/snippet}
{#snippet trailing(row: Item)}<button onclick={() => remove(row)}>Remove {row.name}</button
	>{/snippet}

<Table
	of={rows}
	columns={[
		{ field: 'name', label: 'Name', width: 180 },
		{ field: 'paid', label: 'Paid', cell: paid }
	]}
	key="embedded-test"
	embedded
	controlled
	toolbar={false}
	rowClass={(row) => (row.paid ? 'paid-row' : undefined)}
	rowTrailing={trailing}
/>
