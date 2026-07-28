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
	<div class="markdown-preview w-full rounded bg-background p-4 shadow">
		<div class="prose max-w-none">
			{@html renderedHtml}
		</div>
	</div>
{:else}
	<div class="text-preview w-full rounded bg-background p-4 shadow">
		<pre class="text-sm whitespace-pre-wrap">{content}</pre>
	</div>
{/if}
