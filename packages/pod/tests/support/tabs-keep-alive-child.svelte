<script lang="ts">
	import { onMount } from 'svelte';

	let { name, onMounted }: { readonly name: string; readonly onMounted: (name: string) => void } =
		$props();

	onMount(() => onMounted(name));
</script>

<label>
	{name}
	<input aria-label={`${name} value`} />
</label>
