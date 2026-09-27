<script lang="ts">
	// The ui next views over a real `$bolt` (hook:ui-shell's two provides, as the shell does them): a Table, a create
	// Form and a RecordShell of one collection on one page.
	import type { KindsHost } from '../../../ui/src/kinds/context.js';
	import { provideKinds } from '../../../ui/src/kinds/context.js';
	import Form from '../../../ui/src/form/form.svelte';
	import { provideBolt, type ViewBolt } from '../../../ui/src/views/bolt.js';
	import RecordShell from '../../../ui/src/views/RecordShell.svelte';
	import Table from '../../../ui/src/views/Table.svelte';

	let { bolt, kinds, id }: { bolt: ViewBolt; kinds: KindsHost; id: string } = $props();
	// svelte-ignore state_referenced_locally
	provideBolt(bolt);
	// svelte-ignore state_referenced_locally
	provideKinds(kinds);
</script>

<section data-test="table"><Table of="tasks" columns={['title']} /></section>
<section data-test="form"><Form of="tasks" mode="create" /></section>
<section data-test="record"><RecordShell of="tasks" {id} /></section>
