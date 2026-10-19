<script lang="ts">
	import RecordShell from '../src/record/RecordShell.svelte';
	import Form from '../src/form/form.svelte';
	import ChildGrid from '../src/relations/ChildGrid.svelte';
</script>

<RecordShell of="jobs" id="j1">
	{#snippet children(view)}
		<Form
			of="jobs"
			id="j1"
			mode={view.mode}
			{...view.mode === 'create' ? { values: view.values } : { record: view.record }}
		/>
		<ChildGrid of="jobs" relation="lines" id="j1" save="parent" />
	{/snippet}
</RecordShell>
