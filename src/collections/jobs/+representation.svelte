<script lang="ts">
	import type { RepresentationProps } from './$types.js';
	import JobForm from './job-form.svelte';

	let { record, close }: RepresentationProps = $props();
</script>

<JobForm
	{record}
	onAfterSubmit={async () => {
		close();
	}}
/>
