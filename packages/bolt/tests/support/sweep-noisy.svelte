<script lang="ts">
	// A swept page that logs a console error: the sweep reports it.
	import { onMount } from 'svelte';

	onMount(() => console.error('the page could not render its chart'));
</script>

<p>noisy</p>
