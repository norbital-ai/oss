<script lang="ts">
	import { provideKinds } from '../src/kinds/context.js';
	import JsonSchemaForm from '../src/kinds/json-schema-form.svelte';
	import Editor from '../src/kinds/editor.svelte';
	import type { JsonSchema } from '../src/kinds/json-schema.js';
	import type { Json, Kind } from '../src/kinds/kind.js';
	import ReadValue from '../src/kinds/read-value.svelte';
	let { schema, kind, initial, host = {}, errors, readonly = false, editor = false, view = false, changed }: {
		schema?: JsonSchema; kind?: Kind; view?: boolean; initial: Json; host?: Parameters<typeof provideKinds>[0]; errors?: ReadonlyMap<string, string>; readonly?: boolean; editor?: boolean; changed(next: Json): void;
	} = $props();
	provideKinds(host);
	let value = $state(initial);
	function update(next: Json) { value = next; changed(next); }
</script>
{#if kind !== undefined && view}<ReadValue {kind} {value} name="input" />
{:else if kind !== undefined}<Editor {kind} {value} onChange={update} name="input" {readonly} {errors} />
{:else if editor}<Editor kind={{kind:'json'}} jsonSchema={schema} {value} onChange={update} name="input" {readonly} {errors} />
{:else if schema !== undefined}<JsonSchemaForm {schema} {value} onChange={update} name="input" {readonly} {errors} />{/if}
