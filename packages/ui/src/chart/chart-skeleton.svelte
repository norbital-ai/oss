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
			<div class="flex size-full items-center justify-center">
				<Skeleton class="size-36 rounded-full ring-[2rem] ring-background" />
			</div>
		{:else}
			<Skeleton class="h-[52%] flex-1 rounded-t-md" />
			<Skeleton class="h-[82%] flex-1 rounded-t-md" />
			<Skeleton class="h-[64%] flex-1 rounded-t-md" />
			<Skeleton class="h-[38%] flex-1 rounded-t-md" />
		{/if}
	</Inline>
	<Inline align="end" justify="center" gap="md" shrink={false} class="h-10">
		<Skeleton class="h-3 w-20" />
		<Skeleton class="h-3 w-16" />
	</Inline>
</Stack>
