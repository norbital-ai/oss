<script lang="ts">
	import Combobox from '../src/primitives/combobox/combobox.svelte';
	let { onChange }: { onChange(value: string | null): void } = $props();
	let value = $state<string | null>('a');
	const options = [
		{ value: 'a', label: 'Acme' },
		{ value: 'b', label: 'Beta' }
	];
</script>

<Combobox
	{options}
	{value}
	onChange={(next) => {
		value = next;
		onChange(next);
	}}
>
	{#snippet trigger(option)}
		<span data-trigger>{option?.label}</span>
	{/snippet}
	{#snippet lead(option)}
		<span data-lead>{option?.label}</span>
	{/snippet}
</Combobox>
