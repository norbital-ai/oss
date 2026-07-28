<script lang="ts">
	import Icon from '@iconify/svelte';
	import { Button } from '../../../button/index.js';

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

<div class="h-full overflow-hidden rounded shadow">
	<div class="flex items-center justify-between bg-muted px-3 py-2">
		<span class="text-sm font-medium">PDF Preview</span>
		<Button
			variant="ghost"
			size="sm"
			class="text-brand"
			onclick={openInNewTab}
			title="Open in new tab"
		>
			<Icon icon="lucide:external-link" width="14" height="14" class="mr-1" />
			Open in new tab
		</Button>
	</div>

	{#if dataUrl}
		<iframe src={dataUrl} title={fileName} class="h-96 w-full border-0" allow="fullscreen"></iframe>
	{:else}
		<div class="flex h-64 items-center justify-center">
			<p>PDF preview not available. Please open in a new tab.</p>
		</div>
	{/if}
</div>
