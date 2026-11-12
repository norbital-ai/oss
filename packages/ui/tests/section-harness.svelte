<script lang="ts">
	import type { UiContext } from '../src/client/contract.js';
	// A form in sections: the core one open, a secondary one collapsed with a summary, and one that opts out holding a
	// field kept read-only while the form edits.
	import { Layer, ManagedRuntime } from 'effect';
	import { onDestroy } from 'svelte';
	import { mount_edge } from '../src/effect/index.js';
	onDestroy(mount_edge(ManagedRuntime.make(Layer.empty)));
	import { type KindsHost } from '../src/kinds/context.js';
	import Field from '../src/form/field.svelte';
	import Form from '../src/form/form.svelte';
	import Section from '../src/form/section.svelte';
	import { type ViewBolt } from '../src/client/contract.js';

	let { bolt, catalog }: { bolt: ViewBolt; catalog: NonNullable<KindsHost['catalog']> } = $props();
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

<Form {ctx} of="jobs" mode="create">
	<Section first title="Job" icon="lucide:briefcase"
		><Field {ctx} name="title" /><Field {ctx} name="code" /></Section
	>
	<Section title="Notes" default_open={false} summary="Not set" size="fill" min_height="8rem"
		><Field {ctx} name="notes" /><Field {ctx} name="remarks" /></Section
	>
	<Section title="Fixed" collapsible={false} size="fill" min_height="8rem"
		><Field {ctx} name="kind" readonly /><Field {ctx} name="tier" /></Section
	>
	<Section title="Lone"><Field {ctx} name="tags" /></Section>
	<Section title="Meta"><Field {ctx} name="meta" /></Section>
	<Section title="Rates"><Field {ctx} name="rates" label="" /></Section>
</Form>
