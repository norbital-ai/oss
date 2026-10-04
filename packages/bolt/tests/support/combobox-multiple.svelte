<script lang="ts">
	import Combobox from '../../../ui/src/primitives/combobox/combobox.svelte';
	let { onChange }: { onChange(value: readonly string[]): void } = $props();
	let value = $state<readonly string[]>([]);
	const options = [
		{ value: 'a', label: 'Alice' },
		{ value: 'b', label: 'Bob' },
		{ value: 'c', label: 'Carol' }
	];
</script>

<Combobox
	multiple
	{options}
	{value}
	searchable
	clearable
	aria-label="People"
	onChange={(next) => {
		value = next;
		onChange(next);
	}}
/>
