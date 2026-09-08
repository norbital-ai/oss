<script lang="ts">
	import AgentTranscriptItem from '../../src/client/ui/agent/agent-transcript-item.svelte';
	import type { PanelMessage } from '../../src/client/ui/agent/transcript.js';
	import { untrack } from 'svelte';
	let { initial }: { initial: PanelMessage } = $props();
	let message = $state(untrack(() => initial));
	let generating = $state(true);
	export function update(next: PanelMessage, running = true) {
		message = next;
		generating = running;
	}
</script>

<ol><AgentTranscriptItem {message} {generating} /></ol>
