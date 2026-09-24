<script lang="ts">
	import { Skeleton } from '#lib/skeleton';
	import { Inline, Stack } from '#lib/layout';

	let { donut = false }: { donut?: boolean } = $props();
</script>

<Stack gap="none" fill aria-hidden="true">
	<Inline
		align="end"
		gap="md"
		grow
		class="min-h-0 border-b border-l border-border/60 px-5 pt-4 pb-3"
	>
		{#if donut}
			<Stack fill align="center" justify="center" class="w-full">
				<Skeleton class="size-36 rounded-full ring-[2rem] ring-background" />
			</Stack>
		{:else}
			{#each [52, 82, 64, 38] as height (height)}
				<Skeleton class="flex-1 rounded-t-md" style="height: {height}%" />
			{/each}
		{/if}
	</Inline>
	<Inline align="end" justify="center" gap="md" shrink={false} class="h-10">
		<Skeleton class="h-3 w-20" />
		<Skeleton class="h-3 w-16" />
	</Inline>
</Stack>
