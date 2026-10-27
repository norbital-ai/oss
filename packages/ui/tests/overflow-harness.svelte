<script lang="ts">
	import Overflow from '../src/cell/Overflow.svelte';

	let { text }: { text: string } = $props();
</script>

<Overflow {text}><span>{text}</span></Overflow>
