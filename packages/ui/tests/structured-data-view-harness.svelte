<script lang="ts">
	import { Layer, ManagedRuntime } from 'effect';
	import { onDestroy } from 'svelte';
	import { mountEdge } from '../src/effect/index.js';
	import StructuredData, { type StructuredDataProps } from '../src/kinds/structured-data.svelte';
	import { provideKinds } from '../src/kinds/context.js';
	import type { Value } from '../src/kinds/kind.js';
	import { isJsonSchema } from '../src/kinds/json-schema.js';

	onDestroy(mountEdge(ManagedRuntime.make(Layer.empty)));
	let {
		initial,
		schema,
		author = false,
		host = {},
		changed,
		mode = 'view',
		...props
	}: Omit<StructuredDataProps, 'value' | 'onChange'> & {
		initial?: Value;
		author?: boolean;
		host?: Parameters<typeof provideKinds>[0];
		changed(next: Value): void;
	} = $props();
	// svelte-ignore state_referenced_locally -- each test owns its starting host and draft.
	provideKinds(host);
	// svelte-ignore state_referenced_locally -- later edits replace the local draft.
	let value = $state(initial);
	// svelte-ignore state_referenced_locally -- authoring echoes the schema independently from its data.
	let schemaDocument = $state(schema);
	function update(next: Value) {
		if (mode === 'schema') {
			if (!isJsonSchema(next)) throw new Error('Schema author emitted a non-schema value');
			schemaDocument = next;
		} else value = next;
		changed(next);
	}
</script>

<StructuredData
	{...props}
	{value}
	schema={schemaDocument}
	{mode}
	name="input"
	onChange={mode === 'edit' || author ? update : undefined}
/>
