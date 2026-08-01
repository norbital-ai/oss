<script lang="ts">
	import { Cover, Inline, Stack } from '#lib/layout';
	import { Skeleton } from '#lib/skeleton';

	let {
		loading,
		empty,
		lanes = 3
	}: { loading: boolean; empty: boolean; lanes?: number } = $props();
</script>

{#if loading && empty}
	<div class="contents" aria-busy="true" aria-label="Loading board">
		{#each Array.from({ length: lanes }) as _, lane (lane)}
			<Cover as="section" gap="sm" class="rounded-sm bg-muted/40 p-3" aria-hidden="true">
				{#snippet top()}
					<Inline justify="between" gap="sm" shrink={false}>
						<Skeleton class="h-4 w-24" />
						<Skeleton class="size-4" />
					</Inline>
				{/snippet}
				<Stack gap="xs" fill>
					{#each Array.from({ length: 3 }) as _, card (card)}
						<Stack gap="xs" class="h-32 rounded-sm border bg-card p-3">
							<Skeleton class="h-4 w-3/4" />
							<Skeleton class="h-3 w-full" />
							<Skeleton class="h-3 w-2/3" />
						</Stack>
					{/each}
				</Stack>
			</Cover>
		{/each}
	</div>
{/if}
