<script lang="ts">
	import type { UiContext } from '../src/client/contract.js';
	import { Layer, ManagedRuntime } from 'effect';
	import { onDestroy } from 'svelte';
	import { mount_edge } from '../src/effect/index.js';
	onDestroy(mount_edge(ManagedRuntime.make(Layer.empty)));
	import Table from '../src/table/Table.svelte';
	import { type ViewBolt } from '../src/client/contract.js';
	import { type Row } from '../src/model/types.js';
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
		refresh: unavailable,
		sync_control: unavailable,
		query: unavailable,
		model_query: unavailable,
		source_query: unavailable,
		project_record: unavailable,
		aggregate: unavailable,
		history: unavailable,
		clock: () => ({ today: '2026-01-02', now: '2026-01-02T03:04:05.000Z' }),
		act: unavailable,
		run: unavailable,
		file_url: unavailable,
		approvals: { decide: unavailable, get: unavailable, list: unavailable },
		actor: null,
		locale: 'en',
		t: (key) => key
	};
	const ctx: UiContext = { ui: { bolt: client, kinds: {} } };
</script>

<Table {ctx}
	of={rows}
	key="local-edit"
	columns={[
		{ field: 'name', edit: true },
		{ field: 'amount', edit: true }
	]}
	toolbar={{ title: false, new: false, export: false, search, filter: false }}
	remove
	on_change={(next) => {
		rows = next;
		changed(next);
	}}
/>
