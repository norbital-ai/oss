<script lang="ts">
	import { useI18n, type UiKeys } from '#lib/i18n';

	let { src, alt }: { src: string | null; alt: string } = $props();
	const { t } = useI18n<UiKeys>();
</script>

<!-- stupidity:allow UI5 -- attachment media crop -->
<div class="w-full overflow-hidden rounded bg-background p-2 shadow">
	{#if src}
		<img {src} {alt} class="max-h-96 w-full object-contain" />
	{:else}
		<div class="flex h-32 items-center justify-center text-sm text-muted-foreground">
			{t('misc.imagePreviewUnavailable')}
		</div>
	{/if}
</div>
