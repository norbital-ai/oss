<script lang="ts">
	import type { UiContext } from '../src/client/contract.js';
	import type { KindsHost } from '../src/kinds/context.js';
	import { Layer, ManagedRuntime } from 'effect';
	import { onDestroy } from 'svelte';
	import { mount_edge } from '../src/effect/index.js';
	onDestroy(mount_edge(ManagedRuntime.make(Layer.empty)));
	import StructuredData from '../src/kinds/structured-data.svelte';
	import Editor from '../src/kinds/editor.svelte';
	import type { JsonSchema } from '../src/kinds/json-schema.js';
	import type { Value, Kind } from '../src/kinds/kind.js';
	import Show from '../src/kinds/show.svelte';
	import CellValue from '../src/cell/Value.svelte';
	let {
		schema,
		kind,
		initial,
		host = {},
		errors,
		readonly = false,
		editor = false,
		rawJson = false,
		view = false,
		cell = false,
		link = true,
		create = false,
		changed
	}: {
		schema?: JsonSchema;
		kind?: Kind;
		view?: boolean;
		cell?: boolean;
		link?: boolean;
		initial: Value;
		host?: KindsHost;
		errors?: ReadonlyMap<string, string>;
		readonly?: boolean;
		editor?: boolean;
		rawJson?: boolean;
		create?: boolean;
		changed(next: Value): void;
	} = $props();
	// Each test mount owns the initial host and draft, which subsequent edits replace locally.
	// svelte-ignore state_referenced_locally
	const ctx: UiContext = { ui: { kinds: host } };
	// svelte-ignore state_referenced_locally
	let value = $state(initial);
	function update(next: Value) {
		value = next;
		changed(next);
	}
</script>

{#if cell}<CellValue {ctx} {kind} {value} name="input" dense {link} />
{:else if kind !== undefined && view}<Show {ctx} readonly {kind} {value} name="input" />
{:else if kind !== undefined}<Editor {ctx}
		{kind}
		{value}
		on_change={update}
		name="input"
		{readonly}
		{errors}
		raw_json={rawJson}
	/>
{:else if editor}<Editor {ctx}
		kind={{ kind: 'json' }}
		json_schema={schema}
		{value}
		on_change={update}
		name="input"
		{readonly}
		{errors}
		raw_json={rawJson}
	/>
{:else if schema !== undefined}<StructuredData {ctx}
		mode="edit"
		{schema}
		{value}
		on_change={update}
		name="input"
		{readonly}
		{errors}
		{create}
	/>{/if}
