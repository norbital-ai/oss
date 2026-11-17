<!--
@component
A CodeMirror code editor for JavaScript (also CEL and TypeScript expressions), JSON or plain text. CodeMirror and its
language packs load with the first editor shown, never with a page's startup.
-->
<script lang="ts" module>
	export type { CodeEditorLanguage, CodeEditorProps } from './code-editor-view.svelte';
</script>

<script lang="ts">
	import type { CodeEditorProps } from './code-editor-view.svelte';

	const props: CodeEditorProps = $props();
	const view = import('./code-editor-view.svelte');
</script>

{#await view then { default: View }}<View {...props} />{/await}
