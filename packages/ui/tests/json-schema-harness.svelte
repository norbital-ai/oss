<script lang="ts">
	import { provideKinds } from '../src/kinds/context.js';
	import JsonSchemaForm from '../src/kinds/json-schema-form.svelte';
	import Editor from '../src/kinds/editor.svelte';
	import type { JsonSchema } from '../src/kinds/json-schema.js';
	import type { Json } from '../src/kinds/kind.js';
	let { schema, initial, host = {}, errors, readonly = false, editor = false, changed }: {
		schema: JsonSchema; initial: Json; host?: Parameters<typeof provideKinds>[0]; errors?: ReadonlyMap<string, string>; readonly?: boolean; editor?: boolean; changed(next: Json): void;
	} = $props();
	provideKinds(host);
	let value = $state(initial);
	function update(next: Json) { value = next; changed(next); }
</script>
{#if editor}<Editor kind={{kind:'json'}} jsonSchema={schema} {value} onChange={update} name="input" {readonly} {errors} />
{:else}<JsonSchemaForm {schema} {value} onChange={update} name="input" {readonly} {errors} />{/if}
