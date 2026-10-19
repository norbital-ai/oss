<script lang="ts">
	import { Layer, ManagedRuntime } from 'effect';
	import { onDestroy } from 'svelte';
	import { mountEdge } from '../src/effect/index.js';
	onDestroy(mountEdge(ManagedRuntime.make(Layer.empty)));
	import Table from '../src/table/Table.svelte';
	import { provideBolt } from '../src/client/context.js';
	import { type ViewBolt } from '../src/client/contract.js';
	import { type Row } from '../src/collection/types.js';
	import { provideKinds } from '../src/kinds/context.js';
	type LocalRow = Row & { name: string; amount: number };
	let {
		initial,
		changed,
		search = false
	}: { initial: LocalRow[]; changed(next: LocalRow[]): void; search?: boolean } = $props();
	// svelte-ignore state_referenced_locally -- initializes this fixture's parent draft once.
	let rows = $state(initial);
	const unavailable = (): never => {
		throw new Error('Unexpected remote call in local table test');
	};
	const client: ViewBolt = {
		read: unavailable,
		get: unavailable,
		aggregate: unavailable,
		history: unavailable,
		query: unavailable,
		live: unavailable,
		act: unavailable,
		start: unavailable,
		fileUrl: unavailable,
		approvals: { process: unavailable },
		actor: null,
		locale: 'en',
		t: (key) => key
	};
	provideBolt(client);
	provideKinds({});
</script>

<Table
	of={rows}
	key="local-edit"
	columns={[
		{ field: 'name', edit: true },
		{ field: 'amount', edit: true }
	]}
	toolbar={{ title: false, new: false, export: false, search, filter: false }}
	remove
	onChange={(next) => {
		rows = next;
		changed(next);
	}}
/>
