<script lang="ts">
	/**
	 * Stands in for `@iconify/svelte`, which fetches its glyphs from api.iconify.design.
	 *
	 * A test suite that reaches the network is a test suite that fails when the network does, and the
	 * request is aborted at teardown anyway. The icon name is kept in an attribute so a test can still
	 * assert which icon a surface chose — the drawing is what is missing, and this environment could
	 * not have told anyone whether it drew correctly regardless.
	 */
	let { icon, class: className }: { icon?: string; class?: string } = $props();
</script>

<span data-icon={icon} class={className}></span>
