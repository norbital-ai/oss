<script lang="ts">
	import type { Writable } from 'svelte/store';
	import CodeEditor from '../../../../ui/src/editors/code-editor.svelte';
	let { source, label }: { source: Writable<string>; label: string } = $props();
</script>

<span id="commission-expression-label">{label}</span>
<CodeEditor
	value={$source}
	onChange={(value) => source.set(value)}
	id="commission-expression"
	aria-labelledby="commission-expression-label"
	language="javascript"
	wrap
/>
