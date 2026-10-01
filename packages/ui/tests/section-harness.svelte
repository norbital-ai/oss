<script lang="ts">
	// A form in sections: the core one open, a secondary one collapsed with a summary, an untitled one, and one that opts out.
	import { provideKinds } from '../src/kinds/context.js';
	import Field from '../src/form/field.svelte';
	import Form from '../src/form/form.svelte';
	import Section from '../src/form/section.svelte';
	import { provideBolt, type ViewBolt } from '../src/views/bolt.js';

	let { bolt, catalog }: { bolt: ViewBolt; catalog: never } = $props();
	// svelte-ignore state_referenced_locally
	provideBolt(bolt);
	provideKinds({ get catalog() { return catalog; }, read: (c, o) => bolt.read(c, o) as never, locale: 'en', zone: 'UTC', currency: 'SGD' });
</script>

<Form of="jobs" mode="create">
	<Section first title="Job"><Field name="title" /></Section>
	<Section title="Notes" defaultOpen={false} summary="Not set"><Field name="notes" /></Section>
	<Section title="Fixed" collapsible={false}><Field name="kind" /></Section>
</Form>
