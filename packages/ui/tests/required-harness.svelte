<script lang="ts">
	import type { UiContext } from '../src/client/contract.js';
	// A create form whose fields are required or not by their exposed kinds, one rendered by its own `editor` snippet.
	import { Layer, ManagedRuntime } from 'effect';
	import { onDestroy } from 'svelte';
	import { mount_edge } from '../src/effect/index.js';
	import { type KindsHost } from '../src/kinds/context.js';
	import Field from '../src/form/field.svelte';
	import Form from '../src/form/form.svelte';
	import { type ViewBolt } from '../src/client/contract.js';

	let {
		bolt,
		catalog,
		record
	}: {
		bolt: ViewBolt;
		catalog: NonNullable<KindsHost['catalog']>;
		/** Given, the form views this stored record instead of creating one. */
		record?: Record<string, string | boolean> & { id: string };
	} = $props();
	onDestroy(mount_edge(ManagedRuntime.make(Layer.empty)));
	// svelte-ignore state_referenced_locally
	const ctx: UiContext = { ui: { bolt: bolt, kinds: {
		get catalog() {
			return catalog;
		},
		query: (request) => bolt.query(request),
		locale: 'en',
		zone: 'UTC',
		currency: 'SGD'
	} } };
</script>

<Form
	{ctx}
	of="jobs"
	{...record === undefined ? { mode: 'create' } : { mode: 'view', id: record.id, record }}
>
	<Field {ctx} name="title" />
	<Field {ctx} name="notes" />
	<Field {ctx} name="status" />
	<Field {ctx} name="urgent" />
	<Field {ctx} name="customer_id" />
	<Field {ctx} name="owner_id" />
	<!-- an explicit readonly={false} (a template's "not locked yet") never lifts a viewed form's readonly -->
	<Field {ctx} name="code" readonly={false}>
		{#snippet editor(field)}<input
				id={field.id}
				value={typeof field.value === 'string' ? field.value : ''}
			/>{/snippet}
	</Field>
</Form>
