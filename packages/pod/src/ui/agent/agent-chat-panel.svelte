<script lang="ts">
	import Icon from '@iconify/svelte';
	import { onMount, tick } from 'svelte';
	import { Button } from '@norbital-ai/ui/button';
	import { IconWrapper } from '@norbital-ai/ui/icon-wrapper';
	import { TreeCombobox } from '@norbital-ai/ui/tree-combobox';
	import { Textarea } from '@norbital-ai/ui/textarea';
	import { Inline, Stack } from '@norbital-ai/ui/layout';
	import { getWorkspaceRemoteTransport } from '$lib/authoring/workspace/remote-transport.js';
	import { getInitializedWorkspaceClient } from '$lib/ui/state/client.js';
	import { getPlatformStateContext } from '$lib/ui/state/platform_state.svelte.js';
	import { toPanelMessages, toPanelUsage, toSessionTotals, withPendingEcho } from './transcript.js';
	import AgentModelPicker from './agent-model-picker.svelte';
	import { getAgentModelState, loadAgentModelCatalog } from './agent-model-state.svelte.js';
	import AgentMentionMenu from './agent-mention-menu.svelte';
	import AgentTranscriptItem from './agent-transcript-item.svelte';
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
	import { AGENT_COMPOSER_FOCUS_EVENT } from './agent-composer-focus.js';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import type { PodUiKeys } from '$lib/i18n/index.js';

	const { t } = useI18n<PodUiKeys>();

	let draft = $state('');
	const modelState = getAgentModelState();
	let runId = $state<string | undefined>(undefined);
	let chatId = $state<string | undefined>(undefined);
	let pending = $state(false);
	let planMode = $state(false);
	let echo = $state<string | null>(null);
	let failure = $state<string | null>(null);
	let transcriptElement = $state<HTMLOListElement | null>(null);
	let composingNew = $state(false);
	let platformState: ReturnType<ReturnType<typeof getPlatformStateContext>> | null = null;

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
			platformState = getPlatformState();
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

	// The search and its highlight are callback-driven, not effects: the trigger only ever moves
	// through refreshTrigger, and the scope only through the menu's own callbacks, so those are
	// the only places a search can start, restart, or die. Results depend on query + scope alone,
	// so a trigger that moved to a new position with the same query is not a new search.
	let mentionSearchTimer: ReturnType<typeof setTimeout> | undefined;
	let lastSearchedQuery = '';
	let lastSearchedScope: string | null = null;

	function scheduleMentionSearch(): void {
		clearTimeout(mentionSearchTimer);
		const active = trigger;
		const sources = mentionSources;
		const scope = menuScope;
		if (!active || !sources || !active.query.trim()) {
			searchVersion++;
			lastSearchedQuery = '';
			lastSearchedScope = null;
			menuItems = [];
			menuLoading = false;
			highlightIndex = 0;
			return;
		}
		if (active.query === lastSearchedQuery && scope === lastSearchedScope) return;
		lastSearchedQuery = active.query;
		lastSearchedScope = scope;
		const version = ++searchVersion;
		menuLoading = true;
		// Debounced so a fast typer pays a handful of queries, not one per keystroke.
		mentionSearchTimer = setTimeout(() => {
			void sources
				.search(active.query, scope)
				.then((hits) => {
					if (version !== searchVersion) return;
					menuItems = hits.map((hit): MentionMenuItem => ({ kind: 'record', hit }));
					menuLoading = false;
					highlightIndex = 0;
				})
				.catch(() => {
					if (version !== searchVersion) return;
					menuItems = [];
					menuLoading = false;
					highlightIndex = 0;
				});
		}, 150);
	}

	function refreshTrigger(): void {
		const element = textareaElement;
		if (!element) {
			trigger = null;
			scheduleMentionSearch();
			return;
		}
		const found = findMentionTrigger(
			element.value,
			element.selectionStart ?? element.value.length,
			mentions
		);
		if (found && found.start === suppressedTriggerStart) {
			trigger = null;
			scheduleMentionSearch();
			return;
		}
		suppressedTriggerStart = null;
		// A new trigger position is a new search; whatever scope the previous one had does not follow.
		if (found?.start !== trigger?.start) menuScope = null;
		trigger = found;
		scheduleMentionSearch();
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
			highlightIndex = 0;
			scheduleMentionSearch();
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
		readonly automation_run_id: string | null;
		readonly user_id: string;
		readonly title: string;
		readonly visibility: string;
		readonly platform: string | null;
		readonly channel_key: string | null;
		readonly external_thread_id: string | null;
		readonly messages: readonly Readonly<Record<string, unknown>>[];
		readonly turns: readonly Readonly<Record<string, unknown>>[];
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
			if (typeof row.norbital_id !== 'string') {
				return [];
			}
			return [
				{
					norbital_id: row.norbital_id,
					automation_run_id:
						typeof row.automation_run_id === 'string' ? row.automation_run_id : null,
					user_id: typeof row.user_id === 'string' ? row.user_id : 'unknown-user',
					visibility: typeof row.visibility === 'string' ? row.visibility : 'personal',
					platform: typeof row.platform === 'string' ? row.platform : null,
					channel_key: typeof row.channel_key === 'string' ? row.channel_key : null,
					external_thread_id:
						typeof row.external_thread_id === 'string' ? row.external_thread_id : null,
					messages: Array.isArray(row.messages)
						? (row.messages as readonly Readonly<Record<string, unknown>>[])
						: [],
					turns: Array.isArray(row.turns)
						? (row.turns as readonly Readonly<Record<string, unknown>>[])
						: [],
					title:
						typeof row.title === 'string' && row.title.trim()
							? row.title
							: t('pod.shell.workspaceAgentTitle')
				}
			];
		})
	);
	const isAdmin = $derived(platformState?.user?.role === 'admin');
	const currentUserId = $derived(platformState?.user?.norbital_id ?? null);
	const usersQuery = $derived.by(() => {
		if (!isAdmin) return undefined;
		try {
			return getInitializedWorkspaceClient().db.user?.findMany({
				orderBy: { name: 'asc' },
				limit: 500
			});
		} catch {
			return undefined;
		}
	});
	const userLabels = $derived.by(() => {
		const labels = new Map<string, string>();
		for (const row of usersQuery?.current ?? []) {
			if (typeof row.norbital_id !== 'string') continue;
			const label =
				typeof row.name === 'string' && row.name.trim()
					? row.name
					: typeof row.email === 'string'
						? row.email
						: t('pod.agent.unknownMember');
			labels.set(row.norbital_id, label);
		}
		return labels;
	});

	type ConversationTreeItem = {
		id: string;
		title: string;
		searchText?: string;
		icon: string;
		children?: ConversationTreeItem[];
		metadata: { readonly kind: 'group' | 'conversation' };
	};
	const conversationTree = $derived.by(() => {
		const disabledIds: string[] = [];
		const personal = sessions.filter((session) => session.visibility === 'personal');
		const workspaceChildren: ConversationTreeItem[] = [];
		if (isAdmin) {
			const byUser = new Map<string, SessionRow[]>();
			for (const session of personal) {
				const rows = byUser.get(session.user_id) ?? [];
				rows.push(session);
				byUser.set(session.user_id, rows);
			}
			for (const [userId, rows] of [...byUser].sort((a, b) =>
				(userLabels.get(a[0]) ?? '').localeCompare(userLabels.get(b[0]) ?? '')
			)) {
				const id = `workspace-user:${userId}`;
				disabledIds.push(id);
				workspaceChildren.push({
					id,
					title: userLabels.get(userId) ?? t('pod.agent.unknownMember'),
					icon: 'lucide:user-round',
					metadata: { kind: 'group' },
					children: rows.map((session) => ({
						id: session.norbital_id,
						title: session.title,
						icon: 'lucide:message-square',
						metadata: { kind: 'conversation' }
					}))
				});
			}
		} else {
			workspaceChildren.push(
				...personal.map((session) => ({
					id: session.norbital_id,
					title: session.title,
					icon: 'lucide:message-square',
					metadata: { kind: 'conversation' } as const
				}))
			);
		}

		const channelProfiles = new Map<string, SessionRow[]>();
		for (const session of sessions) {
			if (!session.visibility.startsWith('channel_')) continue;
			const key = session.channel_key ?? t('pod.agent.channelAgent');
			const rows = channelProfiles.get(key) ?? [];
			rows.push(session);
			channelProfiles.set(key, rows);
		}
		const channelChildren: ConversationTreeItem[] = [];
		for (const [channelKey, rows] of [...channelProfiles].sort((a, b) =>
			a[0].localeCompare(b[0])
		)) {
			const profileId = `channel:${channelKey}`;
			disabledIds.push(profileId);
			const profileChildren: ConversationTreeItem[] = [];
			for (const [visibility, label, icon] of [
				['channel_group', t('pod.agent.groups'), 'lucide:users-round'],
				['channel_dm', t('pod.agent.directMessages'), 'lucide:message-circle']
			] as const) {
				const matches = rows.filter((session) => session.visibility === visibility);
				if (matches.length === 0) continue;
				const categoryId = `${profileId}:${visibility}`;
				disabledIds.push(categoryId);
				profileChildren.push({
					id: categoryId,
					title: label,
					icon,
					metadata: { kind: 'group' },
					children: matches.map((session) => ({
						id: session.norbital_id,
						title: session.title,
						searchText: `${channelKey} ${session.external_thread_id ?? ''}`,
						icon: visibility === 'channel_group' ? 'lucide:hash' : 'lucide:user-round',
						metadata: { kind: 'conversation' }
					}))
				});
			}
			channelChildren.push({
				id: profileId,
				title: channelKey,
				icon: 'lucide:bot',
				metadata: { kind: 'group' },
				children: profileChildren
			});
		}

		const roots: ConversationTreeItem[] = [];
		if (workspaceChildren.length > 0) {
			roots.push({
				id: 'workspace-agent',
				title: t('pod.shell.workspaceAgentTitle'),
				icon: 'product:agent',
				metadata: { kind: 'group' },
				children: workspaceChildren
			});
			disabledIds.push('workspace-agent');
		}
		if (channelChildren.length > 0) {
			roots.push({
				id: 'channel-agents',
				title: t('pod.agent.channelAgents'),
				icon: 'lucide:messages-square',
				metadata: { kind: 'group' },
				children: channelChildren
			});
			disabledIds.push('channel-agents');
		}
		return { roots, disabledIds };
	});

	/**
	 * The live conversation: the user's explicit pick, or the newest session once any exist.
	 * `chatId` stays the user's choice (and `undefined` while composing fresh); the derivation is
	 * what defaults to the latest session, so a session arriving over sync lights up the picker
	 * without anyone having to watch for it.
	 */
	const activeChatId = $derived(
		chatId ?? (composingNew || sessions.length === 0 ? undefined : sessions[0].norbital_id)
	);
	const activeRunId = $derived.by(() => {
		if (!activeChatId) return runId;
		return sessions.find((row) => row.norbital_id === activeChatId)?.automation_run_id ?? runId;
	});

	/** One replicated tenant row is the complete live conversation aggregate. */
	const activeSession = $derived(sessions.find((row) => row.norbital_id === activeChatId));
	const activeSessionIsChannel = $derived(
		activeSession?.visibility.startsWith('channel_') ?? false
	);
	const activeSessionIsOtherUsersPersonal = $derived(
		isAdmin &&
			activeSession?.visibility === 'personal' &&
			currentUserId !== null &&
			activeSession.user_id !== currentUserId
	);
	const activeSessionIsReadOnly = $derived(
		activeSessionIsChannel || activeSessionIsOtherUsersPersonal
	);
	const stored = $derived(
		toPanelMessages(activeSession?.messages ?? [], activeSession?.turns ?? [])
	);
	const messages = $derived(withPendingEcho(stored, echo));
	const turnRows = $derived(activeSession?.turns ?? []);
	const canSend = $derived(draft.trim().length > 0 && !pending && !activeSessionIsReadOnly);

	/**
	 * The window the running model actually has, straight from the catalog that named it.
	 *
	 * A host that publishes no `contextLength` leaves this null and the percentage is simply not shown
	 * — an absolute token count is still true, where a percentage against a guessed window is not.
	 */
	const contextLength = $derived(
		modelState.catalog?.options.find(
			(option) => option.id === (modelState.selectedModel || modelState.catalog?.defaultModel)
		)?.contextLength ?? null
	);
	const usage = $derived(toPanelUsage(activeSession?.messages ?? [], contextLength));
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
			(sessionQuery?.current ?? []).find((row) => row.norbital_id === activeChatId) as
				Record<string, unknown> | undefined
		)
	);
	const tokenLabel = $derived(
		totals && totals.totalTokens > 0
			? t('pod.agent.tokens', { count: totals.totalTokens.toLocaleString() })
			: null
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
	 * The catalog and selected model are shared by every route/sheet panel.
	 *
	 * The picker itself never disappears: while this request is pending or unavailable it remains a
	 * disabled, named control, and a second mounted panel reuses the last valid selection.
	 */
	onMount(() => {
		void loadAgentModelCatalog(getWorkspaceRemoteTransport());
	});
	// A tool call is the agent doing something. Once one is on screen it carries its own progress, and
	// a second "Working…" placeholder beside it says less than the call already does.
	const agentHasSpoken = $derived(
		messages.some(
			(message) =>
				message.kind === 'tool' ||
				message.kind === 'checkpoint' ||
				message.kind === 'reasoning' ||
				message.role === 'assistant'
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
		} else if (
			terminalMessage?.kind === 'text' &&
			terminalMessage.role === 'assistant' &&
			terminalMessage.status === 'complete'
		) {
			// The message and turn terminal writes can arrive through sync in either render frame.
			pending = false;
			failure = null;
		}
	});

	$effect(() => {
		void messages.length;
		queueMicrotask(() => {
			if (transcriptElement) transcriptElement.scrollTop = transcriptElement.scrollHeight;
		});
	});

	/**
	 * Cmd+K (and the FAB) ask for composer focus through a window event: the panel may live in the
	 * sheet portal or on the full-page /agent surface, and the shell must not know which. The caret
	 * goes to the end so an invocation lands ready to type, never in the middle of existing text.
	 */
	onMount(() => {
		function onFocusRequest(): void {
			const element = textareaElement;
			if (!element) return;
			element.focus();
			element.setSelectionRange(element.value.length, element.value.length);
		}
		window.addEventListener(AGENT_COMPOSER_FOCUS_EVENT, onFocusRequest);
		return () => window.removeEventListener(AGENT_COMPOSER_FOCUS_EVENT, onFocusRequest);
	});

	async function send(): Promise<void> {
		const { message, references } = serializeMentions(draft, mentions);
		if (!message || pending || activeSessionIsReadOnly) return;
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
				...(activeRunId ? { runId: activeRunId } : {}),
				...(planMode ? { planMode: true } : {}),
				// Only when the host offered a choice. Sending back its own default would turn a display
				// value into a caller assertion, and the host would stop being free to change it.
				...(modelState.catalog &&
				modelState.selectedModel &&
				modelState.selectedModel !== modelState.catalog.defaultModel
					? { model: modelState.selectedModel }
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
		runId = session.automation_run_id ?? undefined;
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

<Stack
	as="section"
	gap="none"
	fill
	class="bg-background"
	aria-label={t('pod.shell.workspaceAgentTitle')}
>
	<Inline as="header" justify="between" gap="sm" class="shrink-0 border-b px-3 py-2.5 sm:px-4">
		<TreeCombobox
			rootItems={conversationTree.roots}
			disabledIds={conversationTree.disabledIds}
			value={activeChatId}
			onValueChange={(value) => selectConversation(value ?? null)}
			ariaLabel={t('pod.agent.conversationThread')}
			searchPlaceholder={t('pod.agent.searchConversations')}
			placeholder={t('pod.agent.noConversations')}
			allowCleared={false}
			triggerClass="border-0 bg-transparent shadow-none"
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
					<span class="px-1 text-tiny font-medium text-muted-foreground"
						>{t('pod.agent.agent')}</span
					>
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

		{#if activeSessionIsReadOnly}
			<div
				class="flex items-center gap-2 rounded-lg bg-muted px-3 py-2.5 text-xs leading-5 text-muted-foreground"
				role="note"
			>
				<Icon icon="lucide:lock-keyhole" class="size-3.5 shrink-0" />
				<span>
					{activeSessionIsChannel
						? t('pod.agent.channelReadOnly')
						: t('pod.agent.adminConversationReadOnly')}
				</span>
			</div>
		{:else}
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
						onclearscope={() => {
							menuScope = null;
							highlightIndex = 0;
							scheduleMentionSearch();
						}}
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
						<Inline
							gap="sm"
							class={`min-w-0 text-muted-foreground ${AGENT_COMPOSER_CONTROL_TEXT_CLASS}`}
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
								<Inline as="span" gap="xs" title={t('pod.agent.contextWindowUsed')}>
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
								</Inline>
							{/if}
							{#if tokenLabel}
								<span class="truncate">{tokenLabel}</span>
							{/if}
							{#if costLabel}
								<span title={costHint}>{costLabel}</span>
							{/if}
						</Inline>
						<Inline justify="end" align="center" gap="xs" class="min-w-0">
							<div class="min-w-0" title={t('pod.agent.modelAndVariant')}>
								<AgentModelPicker
									bind:value={modelState.selectedModel}
									options={modelState.catalog?.options ?? []}
									status={modelState.status}
									compact={true}
									disabled={pending || modelState.status !== 'ready'}
								/>
							</div>
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
		{/if}
	</div>
</Stack>
