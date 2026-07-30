<script lang="ts">
	import { getWorkspaceRemoteTransport } from '$lib/authoring/workspace/remote-transport.js';

	/**
	 * A message as the panel renders it.
	 *
	 * The transcript arrives as `chat_message` rows whose `parts` hold one `AiMessage`, so the panel
	 * reads the stored message rather than a view model derived from it — there is no second shape to
	 * keep in step with the loop.
	 */
	type PanelMessage = { readonly role: string; readonly content: string };

	let messages = $state<PanelMessage[]>([]);
	let draft = $state('');
	let runId = $state<string | undefined>(undefined);
	let pending = $state(false);
	let failure = $state<string | null>(null);

	const canSend = $derived(draft.trim().length > 0 && !pending);

	async function send(): Promise<void> {
		const message = draft.trim();
		if (!message || pending) return;
		pending = true;
		failure = null;
		// Shown immediately: the round trip runs the whole agent loop, which can take seconds, and a
		// prompt that vanishes with no echo reads as a dropped message.
		messages = [...messages, { role: 'user', content: message }];
		draft = '';
		try {
			const result = await getWorkspaceRemoteTransport().agentChat({
				message,
				...(runId ? { runId } : {})
			});
			runId = result.runId;
			messages = [...messages, { role: 'assistant', content: result.text }];
		} catch (cause) {
			// The optimistic echo stays. Removing it would discard what the person typed, and they may
			// want to copy it before retrying.
			failure = cause instanceof Error ? cause.message : String(cause);
		} finally {
			pending = false;
		}
	}

	function onKeydown(event: KeyboardEvent): void {
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			void send();
		}
	}
</script>

<section class="agent-chat" aria-label="Workspace agent">
	<ol class="transcript">
		{#each messages as message, index (index)}
			<li class="message" data-role={message.role}>
				<span class="role">{message.role}</span>
				<p class="content">{message.content}</p>
			</li>
		{/each}
	</ol>

	{#if failure}
		<p class="failure" role="alert">{failure}</p>
	{/if}

	<form
		class="composer"
		onsubmit={(event) => {
			event.preventDefault();
			void send();
		}}
	>
		<label class="visually-hidden" for="agent-chat-input">Message the agent</label>
		<textarea
			id="agent-chat-input"
			bind:value={draft}
			onkeydown={onKeydown}
			placeholder="Ask about this workspace…"
			rows="2"
		></textarea>
		<button type="submit" disabled={!canSend}>{pending ? 'Thinking…' : 'Send'}</button>
	</form>
</section>

<style>
	.agent-chat {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		height: 100%;
		min-height: 0;
	}
	.transcript {
		display: flex;
		flex: 1;
		flex-direction: column;
		gap: 0.75rem;
		list-style: none;
		margin: 0;
		min-height: 0;
		overflow-y: auto;
		padding: 0;
	}
	.message {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}
	.role {
		font-size: 0.75rem;
		opacity: 0.65;
		text-transform: uppercase;
	}
	.content {
		margin: 0;
		white-space: pre-wrap;
	}
	.failure {
		margin: 0;
		font-size: 0.875rem;
	}
	.composer {
		display: flex;
		gap: 0.5rem;
	}
	.composer textarea {
		flex: 1;
		resize: vertical;
	}
	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
		white-space: nowrap;
	}
</style>
