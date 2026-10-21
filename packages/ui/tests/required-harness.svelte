<script lang="ts">
	// A create form whose fields are required or not by their exposed kinds, one rendered by its own `editor` snippet.
	import { Layer, ManagedRuntime } from 'effect';
	import { onDestroy } from 'svelte';
	import { mountEdge } from '../src/effect/index.js';
	import { provideKinds, type KindsHost } from '../src/kinds/context.js';
	import Field from '../src/form/field.svelte';
	import Form from '../src/form/form.svelte';
	import { provideBolt } from '../src/client/context.js';
	import { type ViewBolt } from '../src/client/contract.js';
	import { type Page } from '../src/collection/types.js';

	let { bolt, catalog }: { bolt: ViewBolt; catalog: NonNullable<KindsHost['catalog']> } = $props();
	onDestroy(mountEdge(ManagedRuntime.make(Layer.empty)));
	// svelte-ignore state_referenced_locally
	provideBolt(bolt);
	provideKinds({
		get catalog() {
			return catalog;
		},
		read: (c, o) => bolt.read<Page>(c, o),
		locale: 'en',
		zone: 'UTC',
		currency: 'SGD'
	});
</script>

<Form of="jobs" mode="create">
	<Field name="title" />
	<Field name="notes" />
	<Field name="status" />
	<Field name="urgent" />
	<Field name="customer_id" />
	<Field name="owner_id" />
	<Field name="code">
		{#snippet editor(field)}<input
				id={field.id}
				value={typeof field.value === 'string' ? field.value : ''}
			/>{/snippet}
	</Field>
</Form>
