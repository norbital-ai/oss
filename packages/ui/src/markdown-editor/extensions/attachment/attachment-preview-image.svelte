<script lang="ts">
	import { Stack } from '#lib/layout';
	import { useI18n, type UiKeys } from '#lib/i18n';

	let { src, alt }: { src: string | null; alt: string } = $props();
	const { t } = useI18n<UiKeys>();
</script>

<div class="w-full overflow-clip rounded bg-background p-2 shadow">
	{#if src}
		<img {src} {alt} class="max-h-96 w-full object-contain" />
	{:else}
		<Stack align="center" justify="center" class="h-32 text-sm text-muted-foreground">
			{t('misc.imagePreviewUnavailable')}
		</Stack>
	{/if}
</div>
