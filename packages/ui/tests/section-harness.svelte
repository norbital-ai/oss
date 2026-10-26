<script lang="ts">
	// A form in sections: the core one open, a secondary one collapsed with a summary, an untitled one, and one that opts out.
	import { Layer, ManagedRuntime } from 'effect';
	import { onDestroy } from 'svelte';
	import { mountEdge } from '../src/effect/index.js';
	onDestroy(mountEdge(ManagedRuntime.make(Layer.empty)));
	import { provideKinds, type KindsHost } from '../src/kinds/context.js';
	import Field from '../src/form/field.svelte';
	import Form from '../src/form/form.svelte';
	import Section from '../src/form/section.svelte';
	import { provideBolt } from '../src/client/context.js';
	import { type ViewBolt } from '../src/client/contract.js';
	import { type Page } from '../src/collection/types.js';

	let { bolt, catalog }: { bolt: ViewBolt; catalog: NonNullable<KindsHost['catalog']> } = $props();
	// svelte-ignore state_referenced_locally
	provideBolt(bolt);
	provideKinds({
		get catalog() {
			return catalog;
		},
		query: (c, o) => bolt.query<Page>(c, o),
		locale: 'en',
		zone: 'UTC',
		currency: 'SGD'
	});
</script>

<Form of="jobs" mode="create">
	<Section first title="Job"><Field name="title" /></Section>
	<Section title="Notes" defaultOpen={false} summary="Not set"><Field name="notes" /></Section>
	<Section title="Fixed" collapsible={false}><Field name="kind" /></Section>
</Form>
