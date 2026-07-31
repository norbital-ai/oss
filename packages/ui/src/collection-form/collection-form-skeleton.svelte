<script lang="ts">
	import { Skeleton } from '#lib/skeleton';
	import { Stack } from '#lib/layout';

	let { rows = 4 }: { rows?: number } = $props();
</script>

<Stack gap="md" aria-hidden="true">
	{#each Array.from({ length: rows }) as _, index (index)}
		<Stack gap="sm">
			<Skeleton class="h-4 w-28" />
			<Skeleton class="h-10 w-full rounded-md" />
		</Stack>
	{/each}
	<Skeleton class="h-10 w-full rounded-md sm:w-32" />
</Stack>
