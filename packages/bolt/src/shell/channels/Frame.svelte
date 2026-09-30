<!--
	The frame both views sit in: one state line, the host's own error and detail, then the view. The state wording lives in
	`connect.ts` so two providers never word one state differently.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { Badge } from '@norbital-ai/ui';
	import { Inline, Stack } from '@norbital-ai/ui/layout';
	import { connectionLabel, transportLabel, type ConnectProps } from './connect.ts';

	let { connection, error, t, children }: Pick<ConnectProps, 'connection' | 'error' | 't'> & { children: Snippet } = $props();
	const c = $derived(connection);
</script>

<Stack gap="md">
	<Inline align="center" justify="between" gap="md">
		<p class="text-sm font-medium" data-connection-state={c?.state ?? 'loading'}>{connectionLabel(c, t)}</p>
		{#if c !== null && c.transport !== ''}<Badge variant="outline">{transportLabel(c.transport)}</Badge>{/if}
	</Inline>
	{#if error !== null}<p role="alert" class="text-sm text-destructive" data-connection-error>{error}</p>{/if}
	{#if c?.detail !== undefined}<p class="text-meta" aria-live="polite">{c.detail}</p>{/if}
	{#if c?.state === 'error' && c.error !== undefined}<p role="alert" class="text-sm text-destructive">{c.error}</p>{/if}
	{@render children()}
</Stack>
