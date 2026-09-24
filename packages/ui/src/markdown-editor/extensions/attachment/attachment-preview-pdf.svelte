<script lang="ts">
	import Icon from '@iconify/svelte';
	import { Button } from '#lib/button';
	import { Inline, Stack } from '#lib/layout';
	import { useI18n, type UiKeys } from '#lib/i18n';

	const { t } = useI18n<UiKeys>();

	let {
		dataUrl,
		fileName,
		fileUrl
	}: {
		dataUrl: string | null;
		fileName: string;
		fileUrl: string | null;
	} = $props();

	function openInNewTab() {
		if (dataUrl) {
			window.open(dataUrl, '_blank');
		} else if (fileUrl) {
			window.open(fileUrl, '_blank');
		}
	}
</script>

<div class="h-full overflow-clip rounded shadow">
	<Inline gap="none" justify="between" class="bg-muted px-3 py-2">
		<span class="text-sm font-medium">{t('misc.pdfPreview')}</span>
		<Button
			variant="ghost"
			size="sm"
			class="text-brand"
			onclick={openInNewTab}
			title={t('dataRenderer.openInNewTab')}
		>
			<Icon icon="lucide:external-link" width="14" height="14" class="mr-1" />
			{t('dataRenderer.openInNewTab')}
		</Button>
	</Inline>

	{#if dataUrl}
		<iframe src={dataUrl} title={fileName} class="h-96 w-full border-0" allow="fullscreen"></iframe>
	{:else}
		<Stack align="center" justify="center" class="h-64">
			<p>{t('misc.pdfPreviewUnavailable')}</p>
		</Stack>
	{/if}
</div>
