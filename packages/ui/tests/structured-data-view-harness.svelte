<script lang="ts">
	import type { UiContext } from '../src/client/contract.js';
	import type { KindsHost } from '../src/kinds/context.js';
	import { Layer, ManagedRuntime } from 'effect';
	import { onDestroy } from 'svelte';
	import { mount_edge } from '../src/effect/index.js';
	import StructuredData, { type StructuredDataProps } from '../src/kinds/structured-data.svelte';
	import type { Value } from '../src/kinds/kind.js';
	import { is_json_schema } from '../src/kinds/json-schema.js';

	onDestroy(mount_edge(ManagedRuntime.make(Layer.empty)));
	let {
		initial,
		schema,
		author = false,
		host = {},
		changed,
		mode = 'view',
		...props
	}: Omit<StructuredDataProps, 'ctx' | 'value' | 'on_change'> & {
		initial?: Value;
		author?: boolean;
		host?: KindsHost;
		changed(next: Value): void;
	} = $props();
	// svelte-ignore state_referenced_locally -- each test owns its starting host and draft.
	const ctx: UiContext = { ui: { kinds: host } };
	// svelte-ignore state_referenced_locally -- later edits replace the local draft.
	let value = $state(initial);
	// svelte-ignore state_referenced_locally -- authoring echoes the schema independently from its data.
	let schemaDocument = $state(schema);
	function update(next: Value) {
		if (mode === 'schema') {
			if (!is_json_schema(next)) throw new Error('Schema author emitted a non-schema value');
			schemaDocument = next;
		} else value = next;
		changed(next);
	}
</script>

<StructuredData {ctx}
	{...props}
	{value}
	schema={schemaDocument}
	{mode}
	name="input"
	on_change={mode === 'edit' || author ? update : undefined}
/>
