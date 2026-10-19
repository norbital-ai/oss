<script lang="ts">
	import type { Stream } from 'effect';
	import { live } from '@norbital-ai/ui/effect';
	let { source }: { source: Stream.Stream<{ id: string; value: number }[]> } = $props();
	const rows = live(() => source);
</script>

<ul>
	{#each $rows ?? [] as row (row.id)}<li>{row.value}</li>{/each}
</ul>
