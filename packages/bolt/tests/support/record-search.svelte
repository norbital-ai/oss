<script lang="ts">
	import { MarkdownEditor, type CommandItem } from '@norbital-ai/ui';
	import type { Effect } from 'effect';
	let {
		mentions,
		commands,
		onkeydown
	}: {
		mentions(query: string): Effect.Effect<CommandItem[], Error>;
		commands?(query: string): Effect.Effect<CommandItem[], Error>;
		onkeydown?(event: KeyboardEvent): void;
	} = $props();
	let text = $state('');
</script>

<MarkdownEditor
	value={text}
	on_change={(value) => (text = value)}
	{mentions}
	commands={commands ?? []}
	command_start="word"
	aria-label="Message"
	{onkeydown}
/>
