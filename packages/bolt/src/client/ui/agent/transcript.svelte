<script lang="ts">
	import type { ChatMessage } from '../state/platform.js';
	let {
		messages = [],
		loading = false,
		error
	}: {
		messages?: ReadonlyArray<ChatMessage>;
		loading?: boolean;
		error?: string;
	} = $props();
</script>

<section aria-label="Conversation transcript" aria-busy={loading} aria-live="polite">
	{#if error}
		<p role="alert">{error}</p>
	{:else if loading && messages.length === 0}
		<p>Loading conversation…</p>
	{:else if messages.length === 0}
		<div class="empty">
			<strong>Start a conversation</strong>
			<p>Ask a question or describe a task for the workspace agent.</p>
		</div>
	{:else}
		<ol>
			{#each messages as message (message.id)}
				<li data-role={message.role}>
					<strong>{message.role === 'assistant' ? 'Agent' : message.role === 'tool' ? 'Tool' : 'You'}</strong>
					<p>{message.content}</p>
				</li>
			{/each}
		</ol>
	{/if}
</section>

<style>
	ol { display: grid; gap: .75rem; margin: 0; padding: 0; list-style: none; }
	li { max-width: 48rem; padding: .75rem; border: 1px solid currentColor; border-radius: .5rem; }
	li[data-role='user'] { margin-inline-start: auto; }
	li p, .empty p { margin-block: .25rem 0; white-space: pre-wrap; }
	.empty { padding: 2rem; text-align: center; }
</style>
