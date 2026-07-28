<script lang="ts">
	import { Spinner } from '@norbital-ai/ui/spinner';

	let {
		entry,
		label,
		pluginKey,
		search = ''
	}: {
		entry: string;
		label: string;
		pluginKey: string;
		search?: string;
	} = $props();

	let loading = $state(true);
	let failed = $state(false);
</script>

<div class="relative flex h-full min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden">
	<iframe
		src={`${entry}${search}`}
		title={label}
		data-host-plugin={pluginKey}
		class="h-full min-h-0 w-full flex-1 border-0 bg-background"
		onload={() => {
			loading = false;
			failed = false;
		}}
		onerror={() => {
			loading = false;
			failed = true;
		}}
	></iframe>

	{#if loading && !failed}
		<div
			class="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-background/95 text-muted-foreground"
			role="status"
		>
			<Spinner class="size-5" />
			<span class="text-xs font-medium">Loading {label}…</span>
		</div>
	{:else if failed}
		<div class="absolute inset-0 z-10 grid place-items-center bg-background p-4">
			<p class="text-xs font-medium text-destructive">Failed to load {label}</p>
		</div>
	{/if}
</div>
