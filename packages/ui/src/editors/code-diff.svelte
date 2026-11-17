<!--
@component
One file's change as CodeMirror's unified diff: a header with its path and added and removed line counts, then, once
opened, the text with added lines green and removed lines red and long unchanged runs folded away. CodeMirror loads with
the first diff shown, never with a page's startup.
-->
<script lang="ts" module>
	export type { CodeDiffProps } from './code-diff-view.svelte';
</script>

<script lang="ts">
	import type { CodeDiffProps } from './code-diff-view.svelte';

	let { open = $bindable(false), ...props }: CodeDiffProps = $props();
	const view = import('./code-diff-view.svelte');
</script>

{#await view then { default: View }}<View bind:open {...props} />{/await}
