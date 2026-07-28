<script lang="ts">
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
			<section
				class="flex h-full min-h-0 w-full flex-col rounded-sm bg-muted/40 p-3"
				aria-hidden="true"
			>
				<div class="mb-3 flex shrink-0 items-center justify-between">
					<Skeleton class="h-4 w-24" />
					<Skeleton class="size-4" />
				</div>
				<div class="min-h-0 flex-1 space-y-2 overflow-hidden">
					{#each Array.from({ length: 3 }) as _, card (card)}
						<div class="grid h-32 gap-2 rounded-sm border bg-card p-3">
							<Skeleton class="h-4 w-3/4" />
							<Skeleton class="h-3 w-full" />
							<Skeleton class="h-3 w-2/3" />
						</div>
					{/each}
				</div>
			</section>
		{/each}
	</div>
{/if}
