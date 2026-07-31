<script lang="ts">
	import { getWorkspaceRemoteTransport } from '$lib/authoring/workspace/remote-transport.js';
	import { getInitializedWorkspaceClient } from '$lib/runtime/client.js';
	import { toPanelMessage, withPendingEcho } from './transcript.js';

	/**
	 * The transcript is read from the replica, not accumulated here.
	 *
	 * The loop writes each `AiMessage` to `chat_message` as it goes, and that collection replicates to
	 * its session's owner like any other — so the same live query the rest of the shell uses shows the
	 * conversation as it is written, including a reply that arrived from a channel or from this user's
	 * other tab. A local array could only ever show what *this* panel sent, which is what it did.
	 */
	let draft = $state('');
	let runId = $state<string | undefined>(undefined);
	let chatId = $state<string | undefined>(undefined);
	let pending = $state(false);
	/** The prompt in flight, echoed until its stored row arrives. Null once nothing is outstanding. */
	let echo = $state<string | null>(null);
	let failure = $state<string | null>(null);

	const transcript = $derived.by(() => {
		if (!chatId) return undefined;
		// A panel rendered outside a mounted workspace has no replica to read either way; it still
		// sends, and still shows the echo and the reply it gets back.
		try {
			return getInitializedWorkspaceClient().db.chat_message?.findMany({
				where: { chat_id: chatId },
				orderBy: { seq: 'asc' },
				limit: 500
			});
		} catch {
			return undefined;
		}
	});
	const stored = $derived((transcript?.current ?? []).flatMap(toPanelMessage));
	const messages = $derived(withPendingEcho(stored, echo));

	const canSend = $derived(draft.trim().length > 0 && !pending);

	async function send(): Promise<void> {
		const message = draft.trim();
		if (!message || pending) return;
		pending = true;
		failure = null;
		// Shown immediately: the round trip runs the whole agent loop, which can take seconds, and a
		// prompt that vanishes with no echo reads as a dropped message. It is replaced by the stored
		// row the moment that row replicates, so there is never a moment showing both.
		echo = message;
		draft = '';
		try {
			const result = await getWorkspaceRemoteTransport().agentChat({
				message,
				...(runId ? { runId } : {})
			});
			runId = result.runId;
			chatId = result.chatId ?? chatId;
			// No local append: the loop already stored the reply, and the replica is where this panel
			// reads it from. Appending it here is how a second tab's messages went missing.
		} catch (cause) {
			// The echo stays. Removing it would discard what the person typed, and they may want to
			// copy it before retrying.
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
		{#each messages as message (message.key)}
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
