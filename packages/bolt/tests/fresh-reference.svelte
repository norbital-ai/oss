<script lang="ts">
	import type { Stream } from 'effect';
	import { observe } from '@norbital-ai/ui/effect';
	let { source }: { source: Stream.Stream<{ id: string; value: number }[]> } = $props();
	const rows = observe(() => source);
</script>

<ul>
	{#each rows.current ?? [] as row (row.id)}<li>{row.value}</li>{/each}
</ul>
