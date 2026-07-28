<script lang="ts">
	let { src, alt }: { src: string | null; alt: string } = $props();
</script>

<div class="w-full overflow-hidden rounded bg-background p-2 shadow">
	{#if src}
		<img {src} {alt} class="max-h-96 w-full object-contain" />
	{:else}
		<div class="flex h-32 items-center justify-center text-sm text-muted-foreground">
			Image preview not available.
		</div>
	{/if}
</div>
