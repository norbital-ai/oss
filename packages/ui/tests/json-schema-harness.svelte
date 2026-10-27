<script lang="ts">
	import { Layer, ManagedRuntime } from 'effect';
	import { onDestroy } from 'svelte';
	import { mountEdge } from '../src/effect/index.js';
	onDestroy(mountEdge(ManagedRuntime.make(Layer.empty)));
	import { provideKinds } from '../src/kinds/context.js';
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
		create = false,
		changed
	}: {
		schema?: JsonSchema;
		kind?: Kind;
		view?: boolean;
		cell?: boolean;
		initial: Value;
		host?: Parameters<typeof provideKinds>[0];
		errors?: ReadonlyMap<string, string>;
		readonly?: boolean;
		editor?: boolean;
		rawJson?: boolean;
		create?: boolean;
		changed(next: Value): void;
	} = $props();
	// Each test mount owns the initial host and draft, which subsequent edits replace locally.
	// svelte-ignore state_referenced_locally
	provideKinds(host);
	// svelte-ignore state_referenced_locally
	let value = $state(initial);
	function update(next: Value) {
		value = next;
		changed(next);
	}
</script>

{#if cell}<CellValue {kind} {value} name="input" dense />
{:else if kind !== undefined && view}<Show readonly {kind} {value} name="input" />
{:else if kind !== undefined}<Editor
		{kind}
		{value}
		onChange={update}
		name="input"
		{readonly}
		{errors}
		{rawJson}
	/>
{:else if editor}<Editor
		kind={{ kind: 'json' }}
		jsonSchema={schema}
		{value}
		onChange={update}
		name="input"
		{readonly}
		{errors}
		{rawJson}
	/>
{:else if schema !== undefined}<StructuredData
		mode="edit"
		{schema}
		{value}
		onChange={update}
		name="input"
		{readonly}
		{errors}
		{create}
	/>{/if}
