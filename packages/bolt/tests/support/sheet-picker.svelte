<script lang="ts">
	import Combobox from '../../../ui/src/primitives/combobox/combobox.svelte';
	import Sheet from '../../../ui/src/primitives/sheet/sheet.svelte';
	let value = $state<string | null>(null);
	const options = [
		{ value: 'amber', label: 'Amber Quay Public Yard' },
		{ value: 'cedar', label: 'Cedar Wharf Public Slip' },
		{ value: 'flint', label: 'Flint Basin Public Works' }
	];
</script>

<Sheet open title="New job">
	<div
		data-layout="grid"
		class="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(100%,18rem),1fr))]"
	>
		<Combobox {options} {value} aria-label="Site" onChange={(next) => (value = next)} />
		<input aria-label="Job title" class="h-9 border" />
		<input aria-label="Job nature" class="h-9 border" />
		<input aria-label="Scheduled date" class="h-9 border" />
		<textarea aria-label="Scope" class="h-24 border"></textarea>
	</div>
</Sheet>
