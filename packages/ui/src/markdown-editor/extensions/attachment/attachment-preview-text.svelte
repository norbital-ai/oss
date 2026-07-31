<script lang="ts">
	let {
		variant,
		content,
		renderedHtml
	}: {
		variant: 'markdown' | 'plain';
		content?: string;
		renderedHtml?: string;
	} = $props();
</script>

{#if variant === 'markdown'}
	<div class="markdown-preview prose w-full max-w-none rounded bg-background p-4 shadow">
		{@html renderedHtml}
	</div>
{:else}
	<pre class="text-preview w-full rounded bg-background p-4 text-sm whitespace-pre-wrap shadow">
		{content}
	</pre>
{/if}
