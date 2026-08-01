<script lang="ts">
	import Icon from '@iconify/svelte';
	import { Button } from '@norbital-ai/ui/button';
	import { Textarea } from '@norbital-ai/ui/textarea';
	import { Inline } from '@norbital-ai/ui/layout';
	import { getWorkspaceRemoteTransport } from '$lib/authoring/workspace/remote-transport.js';
	import { getInitializedWorkspaceClient } from '$lib/runtime/client.js';
	import { toPanelMessage, withPendingEcho } from './transcript.js';

	let draft = $state('');
	let runId = $state<string | undefined>(undefined);
	let chatId = $state<string | undefined>(undefined);
	let pending = $state(false);
	let echo = $state<string | null>(null);
	let failure = $state<string | null>(null);
	let transcriptElement = $state<HTMLOListElement | null>(null);

	/** The tenant replica is the one live channel for both transcript text and turn state. */
	const transcript = $derived.by(() => {
		if (!chatId) return undefined;
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
	const turns = $derived.by(() => {
		if (!chatId) return undefined;
		try {
			return getInitializedWorkspaceClient().db.chat_turn?.findMany({
				where: { chat_id: chatId },
				orderBy: { started_at: 'asc' },
				limit: 100
			});
		} catch {
			return undefined;
		}
	});
	const stored = $derived((transcript?.current ?? []).flatMap(toPanelMessage));
	const messages = $derived(withPendingEcho(stored, echo));
	const turnRows = $derived(turns?.current ?? []);
	const canSend = $derived(draft.trim().length > 0 && !pending);

	// `agentChatStart` returns before inference. The replicated root turn is therefore the durable
	// completion signal; subagent rows may finish while their parent is still working.
	$effect(() => {
		if (!pending) return;
		const root = [...turnRows].filter((turn) => turn.subagent_id == null).at(-1) as
			Record<string, unknown> | undefined;
		const terminalMessage = messages.at(-1);
		if (root?.status === 'succeeded') {
			pending = false;
			failure = null;
		} else if (root?.status === 'failed' || root?.status === 'aborted') {
			pending = false;
			failure =
				typeof root.error === 'string' && root.error.trim()
					? root.error
					: 'The agent could not finish this response. Try sending it again.';
		} else if (terminalMessage?.role === 'system') {
			// The terminal transcript row is inserted before the turn-status update. Either can arrive
			// first through live sync, so a failed run must release the composer as soon as its durable
			// error message is visible instead of depending on a second replica event.
			pending = false;
			failure =
				terminalMessage.content.trim() || 'The agent could not finish this response. Try sending it again.';
		}
	});

	$effect(() => {
		void messages.length;
		queueMicrotask(() => {
			if (transcriptElement) transcriptElement.scrollTop = transcriptElement.scrollHeight;
		});
	});

	async function send(): Promise<void> {
		const message = draft.trim();
		if (!message || pending) return;
		pending = true;
		failure = null;
		echo = message;
		draft = '';
		try {
			const result = await getWorkspaceRemoteTransport().agentChatStart({
				message,
				...(runId ? { runId } : {})
			});
			runId = result.runId;
			chatId = result.chatId;
		} catch (cause) {
			failure = cause instanceof Error ? cause.message : String(cause);
			pending = false;
		}
	}

	function onKeydown(event: KeyboardEvent): void {
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			void send();
		}
	}

	function roleLabel(role: string): string {
		if (role === 'user') return 'You';
		if (role === 'assistant') return 'Agent';
		return 'System';
	}
</script>

<section class="flex h-full min-h-0 flex-col bg-background" aria-label="Workspace agent">
	{#if messages.length === 0 && !pending}
		<div class="grid min-h-0 flex-1 place-items-center overflow-y-auto px-6 py-10">
			<div class="max-w-sm text-center">
				<div
					class="mx-auto mb-4 grid size-11 place-items-center rounded-xl bg-primary/10 text-primary"
				>
					<Icon icon="lucide:sparkles" class="size-5" />
				</div>
				<h2 class="text-base font-semibold tracking-[-0.015em] text-foreground">
					Ask about this workspace
				</h2>
				<p class="mx-auto mt-2 max-w-[36ch] text-sm leading-6 text-muted-foreground">
					The agent can use the tools this workspace has approved and keeps its conversation here.
				</p>
			</div>
		</div>
	{:else}
		<ol
			bind:this={transcriptElement}
			class="flex min-h-0 flex-1 list-none flex-col gap-4 overflow-y-auto px-4 py-5 sm:px-5"
			aria-live="polite"
			aria-label="Agent conversation"
		>
			{#each messages as message (message.key)}
				<li
					class="message flex flex-col gap-1.5"
					class:items-end={message.role === 'user'}
					data-role={message.role}
				>
					<span class="px-1 text-tiny font-medium text-muted-foreground">
						{roleLabel(message.role)}
					</span>
					<div
						class={`max-w-[88%] rounded-xl px-3.5 py-2.5 text-sm leading-6 shadow-xs sm:max-w-[80%] ${
							message.role === 'user'
								? 'bg-primary text-primary-foreground'
								: message.role === 'assistant'
									? 'bg-muted text-foreground'
									: 'bg-destructive/10 text-destructive'
						}`}
					>
						<p class="content m-0 whitespace-pre-wrap break-words">{message.content}</p>
						{#if message.status === 'streaming'}
							<span class="mt-1.5 inline-flex items-center gap-1.5 text-tiny text-muted-foreground">
								<span class="size-1.5 animate-pulse rounded-full bg-current"></span>
								Streaming
							</span>
						{/if}
					</div>
				</li>
			{/each}
			{#if pending && messages.every((message) => message.role !== 'assistant')}
				<li class="flex flex-col gap-1.5" aria-label="Agent is working">
					<span class="px-1 text-tiny font-medium text-muted-foreground">Agent</span>
					<div
						class="inline-flex w-fit items-center gap-2 rounded-xl bg-muted px-3.5 py-2.5 text-sm"
					>
						<Icon icon="lucide:loader-circle" class="size-4 animate-spin text-muted-foreground" />
						<span class="text-muted-foreground">Working…</span>
					</div>
				</li>
			{/if}
		</ol>
	{/if}

	<div class="shrink-0 border-t bg-background px-3 py-3 sm:px-4">
		{#if failure}
			<div
				class="mb-3 flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs leading-5 text-destructive"
				role="alert"
			>
				<Icon icon="lucide:circle-alert" class="mt-0.5 size-3.5 shrink-0" />
				<span>{failure}</span>
			</div>
		{/if}

		<form
			class="space-y-2"
			onsubmit={(event) => {
				event.preventDefault();
				void send();
			}}
		>
			<label class="sr-only" for="agent-chat-input">Message the agent</label>
			<Textarea
				id="agent-chat-input"
				bind:value={draft}
				onkeydown={onKeydown}
				placeholder="Ask about records, documents, or this workspace…"
				rows={2}
				class="max-h-40 min-h-20 resize-none"
				disabled={pending}
			/>
			<Inline justify="between" align="center" gap="sm">
				<p class="text-tiny text-muted-foreground">Enter to send · Shift + Enter for a new line</p>
				<Button
					type="submit"
					disabled={!canSend}
					class="h-9 shrink-0 gap-2 rounded-md px-3"
					data-testid="agent-send"
				>
					<Icon
						icon={pending ? 'lucide:loader-circle' : 'lucide:arrow-up'}
						class={pending ? 'size-4 animate-spin' : 'size-4'}
					/>
					{pending ? 'Working…' : 'Send'}
				</Button>
			</Inline>
		</form>
	</div>
</section>
