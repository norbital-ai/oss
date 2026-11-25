<script lang="ts">
	import Sheet from '../src/primitives/sheet/sheet.svelte';
	let { memory }: { memory: string } = $props();
</script>

<Sheet open {memory} title="A record">body</Sheet>
