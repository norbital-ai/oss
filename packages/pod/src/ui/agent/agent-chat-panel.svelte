<script lang="ts">
	import Icon from '@iconify/svelte';
	import { tick } from 'svelte';
	import { Button } from '@norbital-ai/ui/button';
	import { Combobox } from '@norbital-ai/ui/combobox';
	import { IconWrapper } from '@norbital-ai/ui/icon-wrapper';
	import { Textarea } from '@norbital-ai/ui/textarea';
	import { Inline } from '@norbital-ai/ui/layout';
	import { getWorkspaceRemoteTransport } from '$lib/authoring/workspace/remote-transport.js';
	import { getInitializedWorkspaceClient } from '$lib/ui/state/client.js';
	import { getPlatformStateContext } from '$lib/ui/state/platform_state.svelte.js';
	import { toPanelMessages, toPanelUsage, toSessionTotals, withPendingEcho } from './transcript.js';
	import AgentModelPicker from './agent-model-picker.svelte';
	import AgentMentionMenu from './agent-mention-menu.svelte';
	import AgentTranscriptItem from './agent-transcript-item.svelte';
	import type { AgentModelCatalog } from './models.js';
	import {
		findMentionTrigger,
		insertMention,
		mentionDeletion,
		reconcileAfterEdit,
		serializeMentions,
		type ComposerMention,
		type MentionTrigger
	} from './composer-mentions.js';
	import {
		createMentionSources,
		type MentionMenuItem,
		type MentionSources
	} from './mention-sources.js';
	import {
		AGENT_COMPOSER_CONTROL_TEXT_CLASS,
		AGENT_COMPOSER_EDITOR_CLASS,
		AGENT_COMPOSER_SHELL_CLASS
	} from './composer-chrome.js';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import type { PodUiKeys } from '$lib/i18n/index.js';

	const { t } = useI18n<PodUiKeys>();

	let draft = $state('');
	let catalog = $state<AgentModelCatalog | null>(null);
	/** Empty until the host answers; the picker is not rendered before then. */
	let selectedModel = $state('');
	let runId = $state<string | undefined>(undefined);
	let chatId = $state<string | undefined>(undefined);
	let pending = $state(false);
	let planMode = $state(false);
	let echo = $state<string | null>(null);
	let failure = $state<string | null>(null);
	let transcriptElement = $state<HTMLOListElement | null>(null);
	let composingNew = $state(false);

	// ── "@" mentions ────────────────────────────────────────────────────────────────────────────
	// The draft stays plain text; chips are tracked ranges beside it. The menu never takes focus —
	// every key is decided in the textarea's own keydown, which is what keeps the flow keyboard-only.
	let textareaElement = $state<HTMLTextAreaElement | null>(null);
	let mentions = $state<readonly ComposerMention[]>([]);
	let lastDraft = '';
	let trigger = $state<MentionTrigger | null>(null);
	/** An `@` the writer dismissed with esc; suppressed until that trigger position is gone. */
	let suppressedTriggerStart = $state<number | null>(null);
	let menuScope = $state<string | null>(null);
	let menuItems = $state<readonly MentionMenuItem[]>([]);
	let menuLoading = $state(false);
	let highlightIndex = $state(0);
	let searchVersion = 0;

	// Mounted bare (a component test, a host surface without platform state) there is no manifest
	// to search, and the feature is simply absent rather than half-alive.
	let mentionSources: MentionSources | null = null;
	try {
		const getPlatformState = getPlatformStateContext();
		if (typeof getPlatformState === 'function') {
			mentionSources = createMentionSources(() => getPlatformState().manifestContext);
		}
	} catch {
		mentionSources = null;
	}

	const menuOpen = $derived(trigger !== null && mentionSources !== null);
	const menuCollections = $derived(mentionSources?.collections() ?? []);
	const menuEntries = $derived.by((): readonly MentionMenuItem[] => {
		if (!menuOpen || !trigger) return [];
		// A bare "@" shows the scopes a search can narrow to; typing turns the list into hits.
		if (!trigger.query.trim()) {
			if (menuScope) return [];
			return menuCollections.map((collection): MentionMenuItem => ({ kind: 'scope', collection }));
		}
		return menuItems;
	});

	$effect(() => {
		void menuEntries;
		highlightIndex = 0;
	});

	// A new trigger position is a new search; whatever scope the previous one had does not follow.
	$effect(() => {
		void (trigger?.start ?? null);
		menuScope = null;
	});

	$effect(() => {
		const active = trigger;
		const scope = menuScope;
		const sources = mentionSources;
		if (!active || !sources || !active.query.trim()) {
			menuItems = [];
			menuLoading = false;
			return;
		}
		const version = ++searchVersion;
		menuLoading = true;
		// Debounced so a fast typer pays a handful of queries, not one per keystroke.
		const timer = setTimeout(() => {
			void sources
				.search(active.query, scope)
				.then((hits) => {
					if (version !== searchVersion) return;
					menuItems = hits.map((hit): MentionMenuItem => ({ kind: 'record', hit }));
					menuLoading = false;
				})
				.catch(() => {
					if (version !== searchVersion) return;
					menuItems = [];
					menuLoading = false;
				});
		}, 150);
		return () => clearTimeout(timer);
	});

	function refreshTrigger(): void {
		const element = textareaElement;
		if (!element) {
			trigger = null;
			return;
		}
		const found = findMentionTrigger(
			element.value,
			element.selectionStart ?? element.value.length,
			mentions
		);
		if (found && found.start === suppressedTriggerStart) {
			trigger = null;
			return;
		}
		suppressedTriggerStart = null;
		trigger = found;
	}

	function onComposerInput(): void {
		const element = textareaElement;
		if (!element) return;
		mentions = reconcileAfterEdit(mentions, lastDraft, element.value);
		lastDraft = element.value;
		refreshTrigger();
	}

	function applyDraft(next: string, nextMentions: readonly ComposerMention[], caret: number): void {
		draft = next;
		lastDraft = next;
		mentions = nextMentions;
		void tick().then(() => {
			const element = textareaElement;
			if (element) {
				element.focus();
				element.setSelectionRange(caret, caret);
			}
			refreshTrigger();
		});
	}

	function selectMenuItem(item: MentionMenuItem | undefined): void {
		if (!item) return;
		if (item.kind === 'scope') {
			menuScope = item.collection;
			return;
		}
		const element = textareaElement;
		const active = trigger;
		if (!element || !active) return;
		const caret = element.selectionStart ?? element.value.length;
		const inserted = insertMention(element.value, mentions, { ...active, caret }, item.hit);
		applyDraft(inserted.draft, inserted.mentions, inserted.caret);
	}
	// ─────────────────────────────────────────────────────────────────────────────────────────────

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
					title:
						typeof row.title === 'string' && row.title.trim()
							? row.title
							: t('pod.shell.workspaceAgentTitle')
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
	const stored = $derived(toPanelMessages(transcript?.current ?? [], turns?.current ?? []));
	const messages = $derived(withPendingEcho(stored, echo));
	const turnRows = $derived(turns?.current ?? []);
	const canSend = $derived(draft.trim().length > 0 && !pending);

	/**
	 * The window the running model actually has, straight from the catalog that named it.
	 *
	 * A host that publishes no `contextLength` leaves this null and the percentage is simply not shown
	 * — an absolute token count is still true, where a percentage against a guessed window is not.
	 */
	const contextLength = $derived(
		catalog?.options.find((option) => option.id === (selectedModel || catalog?.defaultModel))
			?.contextLength ?? null
	);
	const usage = $derived(toPanelUsage(transcript?.current ?? [], contextLength));
	const contextPercent = $derived(
		usage.contextTokens !== null && usage.contextLength
			? Math.min(100, Math.round((usage.contextTokens / usage.contextLength) * 100))
			: null
	);
	/**
	 * Cumulative figures come from the session counter, never from the messages on screen.
	 *
	 * Occupancy above is genuinely a property of the current window, so summing the transcript is
	 * right for it. Spend is not: the counter is what survives someone deleting a message.
	 */
	const totals = $derived(
		toSessionTotals(
			(sessionQuery?.current ?? []).find((row) => row.norbital_id === chatId) as
				Record<string, unknown> | undefined
		)
	);
	const tokenLabel = $derived(
		totals && totals.totalTokens > 0 ? t('pod.agent.tokens', { count: totals.totalTokens.toLocaleString() }) : null
	);
	// A turn whose host reported no cost makes the total a floor. Saying so costs one character and
	// stops an unmeasured conversation reading as a cheap one.
	const costLabel = $derived(
		totals && (totals.costUsd > 0 || totals.turnsUnreported < totals.turnsCounted)
			? `${totals.turnsUnreported > 0 ? '≥' : ''}$${totals.costUsd.toFixed(4)}`
			: null
	);
	const costHint = $derived(
		totals && totals.turnsUnreported > 0
			? t('pod.agent.turnsUnreportedCost', {
					unreported: totals.turnsUnreported,
					counted: totals.turnsCounted
				})
			: t('pod.agent.costReportedByProvider')
	);

	/**
	 * The catalog and the selected model both come from the host, once.
	 *
	 * `selectedModel` starts as the host's own default rather than the first catalog entry, so the
	 * picker opens showing the model that would run if nobody touched it. A host with no `models()`
	 * leaves the catalog null and the picker unrendered — an absent control is honest about there
	 * being no choice, where an empty one looks broken.
	 */
	$effect(() => {
		const transport = getWorkspaceRemoteTransport();
		// Called through a resolved promise so a transport without the endpoint rejects rather than
		// throwing out of the effect. No catalog is a supported answer; a broken panel is not.
		void Promise.resolve()
			.then(() => transport.agentModels())
			.then((result) => {
				catalog = result;
				if (!selectedModel) selectedModel = result?.defaultModel ?? '';
			})
			.catch(() => {
				catalog = null;
			});
	});
	// A tool call is the agent doing something. Once one is on screen it carries its own progress, and
	// a second "Working…" placeholder beside it says less than the call already does.
	const agentHasSpoken = $derived(
		messages.some(
			(message) =>
				message.kind === 'tool' || message.kind === 'checkpoint' || message.role === 'assistant'
		)
	);

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
					: t('pod.agent.couldNotFinish');
		} else if (terminalMessage?.kind === 'text' && terminalMessage.role === 'system') {
			// The terminal transcript row is inserted before the turn-status update. Either can arrive
			// first through live sync, so a failed run must release the composer as soon as its durable
			// error message is visible instead of depending on a second replica event.
			pending = false;
			failure = terminalMessage.content.trim() || t('pod.agent.couldNotFinish');
		}
	});

	$effect(() => {
		void messages.length;
		queueMicrotask(() => {
			if (transcriptElement) transcriptElement.scrollTop = transcriptElement.scrollHeight;
		});
	});

	async function send(): Promise<void> {
		const { message, references } = serializeMentions(draft, mentions);
		if (!message || pending) return;
		pending = true;
		failure = null;
		echo = message;
		draft = '';
		lastDraft = '';
		mentions = [];
		trigger = null;
		suppressedTriggerStart = null;
		menuScope = null;
		try {
			const result = await getWorkspaceRemoteTransport().agentChatStart({
				message,
				// Only chips the picker created. An `@` that never matched is already in the text.
				...(references.length > 0 ? { mentions: references } : {}),
				...(runId ? { runId } : {}),
				...(planMode ? { planMode: true } : {}),
				// Only when the host offered a choice. Sending back its own default would turn a display
				// value into a caller assertion, and the host would stop being free to change it.
				...(catalog && selectedModel && selectedModel !== catalog.defaultModel
					? { model: selectedModel }
					: {})
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
		if (menuOpen) {
			if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
				event.preventDefault();
				if (menuEntries.length === 0) return;
				const step = event.key === 'ArrowDown' ? 1 : -1;
				highlightIndex = (highlightIndex + step + menuEntries.length) % menuEntries.length;
				return;
			}
			if (event.key === 'Escape') {
				event.preventDefault();
				// Esc clears a scope first; only a second esc dismisses the menu, and the text stays.
				if (menuScope) {
					menuScope = null;
					return;
				}
				suppressedTriggerStart = trigger?.start ?? null;
				trigger = null;
				return;
			}
			if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
				if (menuEntries.length > 0) {
					event.preventDefault();
					selectMenuItem(menuEntries[highlightIndex]);
					return;
				}
				// Nothing matched. Tab merely closes; Enter falls through and sends — the unmatched
				// `@` text goes as the literal prose it is.
				if (event.key === 'Tab') {
					event.preventDefault();
					suppressedTriggerStart = trigger?.start ?? null;
					trigger = null;
					return;
				}
			}
		}
		if (event.key === 'Backspace' || event.key === 'Delete') {
			const element = textareaElement;
			if (element) {
				const deletion = mentionDeletion(
					element.value,
					mentions,
					element.selectionStart ?? 0,
					element.selectionEnd ?? element.selectionStart ?? 0,
					event.key === 'Delete' ? 'forward' : 'backward'
				);
				if (deletion) {
					event.preventDefault();
					applyDraft(deletion.draft, deletion.mentions, deletion.caret);
					return;
				}
			}
		}
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			void send();
		}
	}
</script>

<section class="flex h-full min-h-0 flex-col bg-background" aria-label={t('pod.shell.workspaceAgentTitle')}>
	<Inline as="header" justify="between" gap="sm" class="shrink-0 border-b px-3 py-2.5 sm:px-4">
		<Combobox
			options={sessionOptions}
			value={chatId ?? null}
			onValueChange={selectConversation}
			ariaLabel={t('pod.agent.conversationThread')}
			searchPlaceholder={t('pod.agent.searchConversations')}
			emptyPlaceholder={t('pod.agent.noConversations')}
			class="min-w-0 flex-1"
			triggerClass="border-0 bg-transparent shadow-none"
			chevronOnHover={true}
		/>
		<Button
			variant="ghost"
			size="icon"
			hint={t('pod.agent.newConversation')}
			aria-label={t('pod.agent.newConversation')}
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
					{t('pod.agent.askAboutWorkspace')}
				</h2>
				<p class="mx-auto mt-2 max-w-[36ch] text-sm leading-6 text-muted-foreground">
					{t('pod.agent.askDescription')}
				</p>
			</div>
		</div>
	{:else}
		<ol
			bind:this={transcriptElement}
			class="flex min-h-0 flex-1 list-none flex-col gap-2 overflow-y-auto px-4 py-5 sm:px-5"
			aria-live="polite"
			aria-label={t('pod.agent.conversationAria')}
		>
			{#each messages as message (message.key)}
				<AgentTranscriptItem {message} />
			{/each}
			{#if pending && !agentHasSpoken}
				<li class="my-1.5 flex flex-col gap-1.5" aria-label={t('pod.agent.agentIsWorking')}>
					<span class="px-1 text-tiny font-medium text-muted-foreground">{t('pod.agent.agent')}</span>
					<div
						class="inline-flex w-fit items-center gap-2 rounded-xl bg-muted px-3.5 py-2.5 text-sm"
					>
						<Icon icon="lucide:loader-circle" class="size-4 animate-spin text-muted-foreground" />
						<span class="text-muted-foreground">{t('pod.agent.working')}</span>
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

		<div class="relative">
			{#if menuOpen}
				<AgentMentionMenu
					items={menuEntries}
					{highlightIndex}
					loading={menuLoading}
					query={trigger?.query ?? ''}
					scope={menuScope}
					onselect={(index) => selectMenuItem(menuEntries[index])}
					onhighlight={(index) => (highlightIndex = index)}
					onclearscope={() => (menuScope = null)}
				/>
			{/if}
			<form
				class={AGENT_COMPOSER_SHELL_CLASS}
				onsubmit={(event) => {
					event.preventDefault();
					void send();
				}}
			>
				<div class="px-3 pt-3 pb-1 sm:px-4 sm:pt-4" data-agent-composer>
					<label class="sr-only" for="agent-chat-input">{t('pod.agent.messageAgent')}</label>
					<Textarea
						id="agent-chat-input"
						bind:value={draft}
						bind:ref={textareaElement}
						onkeydown={onKeydown}
						oninput={onComposerInput}
						onkeyup={refreshTrigger}
						onclick={refreshTrigger}
						aria-autocomplete="list"
						aria-expanded={menuOpen}
						aria-controls="agent-mention-menu"
						placeholder={t('pod.agent.composerPlaceholder')}
						rows={1}
						class={AGENT_COMPOSER_EDITOR_CLASS}
						disabled={pending}
					/>
				</div>

				<!-- stupidity:allow UI6 -- Composer action bar keeps its wrapping left controls pinned beside the send cluster; Cluster would push send below the fold on narrow widths. -->
				<div
					class="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-x-1 gap-y-1 px-2.5 pt-1 pb-[max(0.625rem,env(safe-area-inset-bottom))]"
				>
					<!-- Plan mode is restored. Auto-send-after-step and attach remain deferred — turn stepping
				     and a session file store are not in this package yet. Usage figures below are the
				     provider's own; anything the provider did not report is absent rather than estimated. -->
					<div
						class={`flex min-w-0 items-center gap-2 text-muted-foreground ${AGENT_COMPOSER_CONTROL_TEXT_CLASS}`}
						data-testid="agent-usage"
					>
						<button
							type="button"
							aria-pressed={planMode}
							disabled={pending}
							onclick={() => (planMode = !planMode)}
							class={`rounded-md px-1.5 py-0.5 transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50 ${AGENT_COMPOSER_CONTROL_TEXT_CLASS} ${
								planMode
									? 'bg-primary/10 text-primary'
									: 'text-muted-foreground hover:bg-muted hover:text-foreground'
							}`}
							title={planMode ? t('pod.agent.planModeOn') : t('pod.agent.planModeOff')}
							data-testid="agent-plan-mode"
						>
							{t('pod.agent.plan')}
						</button>
						{#if contextPercent !== null}
							<span class="inline-flex items-center gap-1.5" title={t('pod.agent.contextWindowUsed')}>
								<span
									class="h-1 w-10 shrink-0 overflow-hidden rounded-full bg-muted"
									aria-hidden="true"
								>
									<span
										class="block h-full rounded-full bg-foreground/40"
										style={`width: ${contextPercent}%`}
									></span>
								</span>
								{contextPercent}%
							</span>
						{/if}
						{#if tokenLabel}
							<span class="truncate">{tokenLabel}</span>
						{/if}
						{#if costLabel}
							<span title={costHint}>{costLabel}</span>
						{/if}
					</div>
					<Inline justify="end" align="center" gap="xs" class="min-w-0">
						{#if catalog && selectedModel}
							<div class="min-w-0" title={t('pod.agent.modelAndVariant')}>
								<AgentModelPicker
									bind:value={selectedModel}
									options={catalog.options}
									compact={true}
									disabled={pending}
								/>
							</div>
						{/if}
						<Button
							type="submit"
							disabled={!canSend}
							size="icon"
							class="size-8 shrink-0 rounded-full"
							data-testid="agent-send"
							aria-label={pending ? t('pod.agent.agentIsWorking') : t('pod.agent.send')}
						>
							<Icon
								icon={pending ? 'lucide:loader-circle' : 'lucide:arrow-up'}
								class={pending ? 'size-4 animate-spin' : 'size-4'}
							/>
						</Button>
					</Inline>
				</div>
			</form>
		</div>
	</div>
</section>
