<script lang="ts">
	// A swept page: a live Table over the shell's `$bolt`, as a built page chunk renders one.
	import { provideBolt, type ViewBolt } from '../../../ui/src/views/bolt.js';
	import Table from '../../../ui/src/views/Table.svelte';
	import { currentBolt } from '../../src/shell/runtime.ts';

	provideBolt(currentBolt() as unknown as ViewBolt);
</script>

<Table of="quotes" columns={['title']} />
