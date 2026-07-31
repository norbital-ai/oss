<script lang="ts">
	import { Bound, Stack } from '@norbital-ai/ui/layout';
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

	let status = $state<'loading' | 'ready' | 'failed'>('loading');
</script>

<Bound size="full" clip class="relative flex-1">
	<iframe
		src={`${entry}${search}`}
		title={label}
		data-host-plugin={pluginKey}
		class="h-full min-h-0 w-full flex-1 border-0 bg-background"
		onload={() => {
			status = 'ready';
		}}
		onerror={() => {
			status = 'failed';
		}}
	></iframe>

	{#if status === 'loading'}
		<Stack
			gap="xs"
			class="absolute inset-0 z-10 items-center justify-center bg-background/95 text-muted-foreground"
			role="status"
		>
			<Spinner class="size-5" />
			<span class="text-xs font-medium">Loading {label}…</span>
		</Stack>
	{:else if status === 'failed'}
		<div class="absolute inset-0 z-10 grid place-items-center bg-background p-4">
			<p class="text-xs font-medium text-destructive">Failed to load {label}</p>
		</div>
	{/if}
</Bound>
