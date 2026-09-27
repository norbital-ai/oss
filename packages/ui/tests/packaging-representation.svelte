<script lang="ts">
	let { view }: { view: { mode: string; record?: { readonly [f: string]: unknown } } } = $props();
</script>

<p data-representation={view.mode}>{String(view.record?.['title'])}</p>
