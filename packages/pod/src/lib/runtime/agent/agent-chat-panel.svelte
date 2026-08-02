<script lang="ts">
	import Icon from '@iconify/svelte';
	import { Button } from '@norbital-ai/ui/button';
	import { Combobox } from '@norbital-ai/ui/combobox';
	import { IconWrapper } from '@norbital-ai/ui/icon-wrapper';
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
	let composingNew = $state(false);

	type SessionRow = {
		readonly norbital_id: string;
		readonly automation_run_id: string;
		readonly title: string;
	};
	const sessionQuery = $derived.by(() => {
		try {
			return getInitializedWorkspaceClient().db.chat_session?.findMany({
				orderBy: { norbital_updated_at: 'desc' },
				limit: 100
			});
		} catch {
			return undefined;
		}
	});
	const sessions = $derived(
		(sessionQuery?.current ?? []).flatMap((row): SessionRow[] => {
			if (typeof row.norbital_id !== 'string' || typeof row.automation_run_id !== 'string') {
				return [];
			}
			return [
				{
					norbital_id: row.norbital_id,
					automation_run_id: row.automation_run_id,
					title: typeof row.title === 'string' && row.title.trim() ? row.title : 'Workspace agent'
				}
			];
		})
	);
	const sessionOptions = $derived(
		sessions.map((session) => ({ value: session.norbital_id, label: session.title }))
	);

	$effect(() => {
		if (chatId || composingNew || sessions.length === 0) return;
		chatId = sessions[0].norbital_id;
		runId = sessions[0].automation_run_id;
	});

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
				terminalMessage.content.trim() ||
				'The agent could not finish this response. Try sending it again.';
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
			composingNew = false;
		} catch (cause) {
			failure = cause instanceof Error ? cause.message : String(cause);
			pending = false;
		}
	}

	function selectConversation(value: string | null): void {
		if (!value) return;
		const session = sessions.find((candidate) => candidate.norbital_id === value);
		if (!session) return;
		chatId = session.norbital_id;
		runId = session.automation_run_id;
		composingNew = false;
		echo = null;
		failure = null;
	}

	function startConversation(): void {
		chatId = undefined;
		runId = undefined;
		composingNew = true;
		echo = null;
		failure = null;
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
	<Inline as="header" justify="between" gap="sm" class="shrink-0 border-b px-3 py-2.5 sm:px-4">
		<Combobox
			options={sessionOptions}
			value={chatId ?? null}
			onValueChange={selectConversation}
			ariaLabel="Conversation thread"
			searchPlaceholder="Search conversations…"
			emptyPlaceholder="No conversations yet"
			class="min-w-0 flex-1"
			triggerClass="border-0 bg-transparent shadow-none"
		/>
		<Button
			variant="ghost"
			size="icon"
			hint="New conversation"
			aria-label="New conversation"
			onclick={startConversation}
		>
			<Icon icon="lucide:square-pen" class="size-4" />
		</Button>
	</Inline>
	{#if messages.length === 0 && !pending}
		<div class="grid min-h-0 flex-1 place-items-center overflow-y-auto px-6 py-10">
			<div class="max-w-sm text-center">
				<div
					class="mx-auto mb-4 grid size-11 place-items-center rounded-xl border bg-card shadow-xs"
				>
					<IconWrapper name="product:agent" class="size-5 text-foreground" />
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
			class="flex min-h-0 flex-1 list-none flex-col gap-5 overflow-y-auto px-4 py-5 sm:px-5"
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
						class={`text-sm leading-6 sm:max-w-[88%] ${
							message.role === 'user'
								? 'max-w-[88%] rounded-[1.15rem] bg-muted px-3.5 py-2.5 text-foreground'
								: message.role === 'assistant'
									? 'w-full text-foreground'
									: 'w-full rounded-lg bg-destructive/10 px-3.5 py-2.5 text-destructive'
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

	<div class="shrink-0 bg-background px-3 pb-3 sm:px-4 sm:pb-4">
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
			class="flex min-w-0 flex-col overflow-hidden rounded-[1.25rem] border border-border/70 bg-card shadow-deep"
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
				rows={1}
				class="max-h-40 min-h-14 resize-none border-0 bg-transparent px-4 pt-3.5 pb-2 shadow-none focus-visible:ring-0"
				disabled={pending}
			/>
			<Inline justify="end" align="center" gap="sm" class="px-2.5 pb-2.5">
				<Button
					type="submit"
					disabled={!canSend}
					size="icon"
					class="size-8 shrink-0 rounded-full"
					data-testid="agent-send"
					aria-label={pending ? 'Agent is working' : 'Send message'}
				>
					<Icon
						icon={pending ? 'lucide:loader-circle' : 'lucide:arrow-up'}
						class={pending ? 'size-4 animate-spin' : 'size-4'}
					/>
				</Button>
			</Inline>
		</form>
	</div>
</section>
