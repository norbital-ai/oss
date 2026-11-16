<script lang="ts">
	import PinInput from '../src/pin-input/pin-input.svelte';
	let { complete }: { complete: (value: string) => void } = $props();
	let value = $state('');
	let disabled = $state(false);
</script>

<PinInput
	bind:value
	{disabled}
	on_complete={(code) => {
		if (disabled) return;
		disabled = true;
		complete(code);
	}}
/>
<button
	onclick={() => {
		disabled = false;
	}}>Retry</button
>
