<script lang="ts">
	import { Skeleton } from '#lib/skeleton';

	let { rows = 4 }: { rows?: number } = $props();
</script>

<div class="grid gap-4" aria-hidden="true">
	{#each Array.from({ length: rows }) as _, index (index)}
		<div class="grid gap-2">
			<Skeleton class="h-4 w-28" />
			<Skeleton class="h-10 w-full rounded-md" />
		</div>
	{/each}
	<Skeleton class="h-10 w-full rounded-md sm:w-32" />
</div>
