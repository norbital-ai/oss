<script lang="ts">
	import { Skeleton } from '#lib/skeleton';

	let { donut = false }: { donut?: boolean } = $props();
</script>

<div class="flex h-[250px] w-full flex-col" aria-hidden="true">
	<div
		class="flex min-h-0 flex-1 items-end gap-4 border-b border-l border-border/60 px-5 pt-4 pb-3"
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
	</div>
	<div class="flex h-10 shrink-0 items-end justify-center gap-4">
		<Skeleton class="h-3 w-20" />
		<Skeleton class="h-3 w-16" />
	</div>
</div>
