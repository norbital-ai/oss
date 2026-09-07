<script lang="ts">
	let {
		content = '',
		value = '',
		allowHtml = undefined
	}: { content?: string; value?: string; allowHtml?: boolean | undefined } = $props();
</script>

<!-- The markdown/editor double prints the value verbatim and exposes the HTML gate it was given. -->
<p data-allow-html={allowHtml === undefined ? undefined : String(allowHtml)}>{content || value}</p>
