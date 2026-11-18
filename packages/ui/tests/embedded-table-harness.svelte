<script lang="ts">
	import Table from '../src/table/Table.svelte';
	type Item = { id: string; name: string; paid: boolean; terms: { days: number } };
	let { changed }: { changed(next: Item[]): void } = $props();
	let rows = $state<Item[]>([
		{ id: 'a', name: 'Annual leave', paid: true, terms: { days: 14 } },
		{ id: 'b', name: 'Care leave', paid: false, terms: { days: 2 } }
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

<Table ctx={{ ui: { kinds: {} } }}
	of={rows}
	columns={[
		{ field: 'name', label: 'Name', width: 180 },
		{ field: 'paid', label: 'Paid', cell: paid },
		{ field: 'terms', label: 'Terms' }
	]}
	key="embedded-test"
	embedded
	controlled
	toolbar={false}
	row_class={(row) => (row.paid ? 'paid-row' : undefined)}
	row_trailing={trailing}
/>
