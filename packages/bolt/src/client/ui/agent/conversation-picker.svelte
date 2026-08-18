<script lang="ts">
	let {
		conversations = [],
		selected,
		loading = false,
		onselect,
		onnew
	}: {
		conversations?: ReadonlyArray<{ readonly id: string; readonly title: string }>;
		selected?: string;
		loading?: boolean;
		onselect?: (id: string) => void;
		onnew?: () => void;
	} = $props();
</script>

<section aria-labelledby="conversation-picker-title" aria-busy={loading}>
	<header>
		<h2 id="conversation-picker-title">Conversations</h2>
		{#if onnew}<button type="button" onclick={onnew}>New</button>{/if}
	</header>
	{#if loading}
		<p role="status">Loading conversations…</p>
	{:else if conversations.length === 0}
		<p class="empty">No saved conversations.</p>
	{:else}
		<div role="listbox" aria-label="Conversation">
			{#each conversations as conversation (conversation.id)}
				<button
					type="button"
					role="option"
					aria-selected={conversation.id === selected}
					onclick={() => onselect?.(conversation.id)}
				>
					{conversation.title || 'Untitled conversation'}
				</button>
			{/each}
		</div>
	{/if}
</section>

<style>
	header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
	h2 { margin: 0; font-size: 1rem; }
	[role='listbox'] { display: grid; gap: .25rem; }
	[role='option'] { text-align: start; }
	[aria-selected='true'] { font-weight: 700; }
	.empty { opacity: .7; }
</style>
