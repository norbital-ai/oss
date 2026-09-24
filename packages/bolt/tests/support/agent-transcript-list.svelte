<script lang="ts">
	import AgentTranscriptItem from '../../src/client/ui/agent/agent-transcript-item.svelte';
	import {
		pairToolCalls,
		rendersInTranscript,
		type SubagentTranscript
	} from '../../src/client/ui/agent/tool-rows.js';
	import { type PanelMessage } from '../../src/client/ui/agent/transcript.js';

	/** The panel's root transcript list, reduced to what the row tests observe. */
	let {
		messages,
		transcript
	}: { messages: readonly PanelMessage[]; transcript: SubagentTranscript } = $props();
	const tools = $derived(pairToolCalls(transcript.messages));
</script>

<ol>
	{#each messages.filter( (message) => rendersInTranscript( message, { tools } ) ) as message (message.key)}
		<li><AgentTranscriptItem {message} {tools} subagent={transcript} /></li>
	{/each}
</ol>
