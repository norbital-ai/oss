<script lang="ts">
	import { humanize } from '@norbital-ai/std/string';
	import type { RendererProps } from './$types.js';
	import { photoSourceSchema } from './+definition.js';

	let props: RendererProps = $props();
	const parsed = $derived(photoSourceSchema.safeParse(props.value));
	const source = $derived(parsed.success ? parsed.data : null);
</script>

{#if source?.kind === 'channel'}
	<div class="min-w-0">
		<p class="truncate text-sm font-medium">{humanize(source.provider)} channel</p>
		<p class="truncate text-xs text-muted-foreground">
			Conversation {source.conversation_id} · Message {source.message_id}
		</p>
	</div>
{:else if source?.kind === 'workspace_upload'}
	<span class="text-sm">Workspace upload</span>
{:else}
	<span class="text-sm text-destructive">Invalid photo source</span>
{/if}
