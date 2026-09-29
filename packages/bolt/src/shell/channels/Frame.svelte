<!--
	The frame every provider's pairing sits in: one state line, the provider's own error and detail, then whatever the
	component wants to draw. The state wording lives in `connect.ts` so two providers never word one state differently.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { Inline, Stack } from '@norbital-ai/ui/layout';
	import { connectionLabel, type ConnectProps } from './connect.ts';

	let { connection, error, t, children }: Pick<ConnectProps, 'connection' | 'error' | 't'> & { children: Snippet } = $props();
	const c = $derived(connection);
</script>

<Stack gap="sm">
	<Inline align="center" justify="between" gap="md">
		<p class="text-sm font-medium">{connectionLabel(c, t)}</p>
		{#if c !== null}
			<span class="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-meta">
				{c.state}{c.transport === '' ? '' : ` · ${c.transport}`}
			</span>
		{/if}
	</Inline>
	{#if error !== null}<p role="alert" class="text-sm text-destructive">{error}</p>{/if}
	{#if c?.detail !== undefined}<p class="text-meta" aria-live="polite">{c.detail}</p>{/if}
	{#if c?.state === 'error' && c.error !== undefined}<p role="alert" class="text-sm text-destructive">{c.error}</p>{/if}
	{@render children()}
</Stack>
