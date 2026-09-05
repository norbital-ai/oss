<script lang="ts">
	let { content = '', value = '' }: { content?: string; value?: string } = $props();
</script>

<p>{content || value}</p>
