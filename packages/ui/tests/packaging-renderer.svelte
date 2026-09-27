<script lang="ts">
	// A custom field's `+renderer.svelte` as a template writes one: it reads the record's other fields from `view.row`.
	let { view }: { view: { mode: string; value: unknown; row?: { readonly [f: string]: unknown } } } = $props();
</script>

<p data-renderer={view.mode} data-row={JSON.stringify(view.row ?? null)}>{String(view.value)}</p>
