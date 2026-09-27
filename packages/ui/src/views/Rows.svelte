<!--
@component
An editable list of child rows inside a parent's form: add, edit and remove rows, reported as the relation operations of the parent's one act.
-->
<script lang="ts" module>
	import type { Row } from './bolt.js';
	import type { RowsOps } from './model.js';
	import type { Col } from './Table.svelte';
	/** The props of `Rows`. */
	export type RowsProps = {
		/** The child rows as loaded (empty on create). */
		rows: readonly Row[];
		columns: readonly Col[];
		/** A new child row's initial values. */
		add: () => Row;
		min?: number;
		max?: number;
		/** Each edit: the explicit relation ops for the parent's one act, and the rows as shown. */
		onChange: (ops: RowsOps, current: readonly Row[]) => void;
	};
</script>

<script lang="ts">
	// A child relation edited inside its parent's form and sent in the same act (AM-10) as explicit `create`, `update`
	// and `delete` entries recorded from the viewer's own actions, never deletes by omission (collection-write-contract).
	import { rowsOps } from './model.js';
	import Table from './Table.svelte';

	let { rows, columns, add, min = 0, max = Infinity, onChange }: RowsProps = $props();
	let current = $state<readonly Row[]>([]);
	let removed = $state<string[]>([]);
	$effect.pre(() => { current = rows; removed = []; });
	function change(next: Row[]) {
		if (next.length < min || next.length > max) return;
		const kept = new Set(next.map((r) => r['id']));
		removed = [...removed, ...current.filter((r) => typeof r['id'] === 'string' && !kept.has(r['id'])).map((r) => String(r['id']))];
		current = next;
		onChange(rowsOps(rows, next, removed), next);
	}
	const editable = $derived(columns.map((c) => typeof c === 'string' ? { field: c, edit: true as const } : { ...c, edit: true as const }));
</script>

<Table of={current} columns={editable} onChange={change} add={current.length < max ? add : undefined} remove={current.length > min} toolbar={{ search: false, filter: false, export: false }} />
