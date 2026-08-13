<script lang="ts">
	import Icon from '@iconify/svelte';
	import { onMount, tick } from 'svelte';
	import { SvelteMap } from 'svelte/reactivity';
	import { Button } from '@norbital-ai/ui/button';
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
	import NorbitalThinkingOrb from './norbital-thinking-orb.svelte';
	import { agentOrbState, agentOrbStatusKey } from './agent-orb-state.js';
	import {
		consumeTrigger,
		findMentionTrigger,
		insertMention,
		mentionDeletion,
		reconcileAfterEdit,
		rewriteTriggerQuery,
		serializeMentions,
		type ComposerMention,
		type MentionTrigger
	} from './composer-mentions.js';
	import {
		AGENT_COMPOSER_CONTROL_TEXT_CLASS,
		AGENT_COMPOSER_EDITOR_CLASS,
		AGENT_COMPOSER_FOCUS_EVENT,
		AGENT_COMPOSER_SHELL_CLASS,
		type AgentComposerSeed
	} from './composer-chrome.js';
	import {
		buildMentionMenuEntries,
		commandPrefixChar,
		createMentionSources,
		parseCommandQuery,
		recordSearchIdentity,
		shouldSearchRecords,
		type MentionMenuItem,
		type MentionSources
	} from './mention-sources.js';
	import { createDebouncedRecordSearch } from './debounced-record-search.js';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import type { PodUiKeys } from '$lib/i18n/index.js';
	import { resolveAgentIntent } from '$lib/shared/agent/intent.js';

	const { t } = useI18n<PodUiKeys>();

	let { headerOrb = true }: { headerOrb?: boolean } = $props();

	let draft = $state('');
	const modelState = getAgentModelState();
	let runId = $state<string | undefined>(undefined);
	let chatId = $state<string | undefined>(undefined);
	let pending = $state(false);
	let planMode = $state(false);
	let verifierOverride = $state<string | null>(null);
	let echo = $state<string | null>(null);
	let sendFailure = $state<string | null>(null);
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
	let menuItems = $state<readonly MentionMenuItem[]>([]);
	let menuLoading = $state(false);
	let highlightIndex = $state(0);
	let mentionHighlightIdentity = '';

	const mentionSearch = createDebouncedRecordSearch({
		search: (text, collection) => {
			const sources = mentionSources;
			if (!sources) return Promise.resolve([]);
			return sources.search(text, collection);
		},
		onLoading: (loading) => {
			menuLoading = loading;
		},
		onResults: (hits) => {
			menuItems = hits.map((hit): MentionMenuItem => ({ kind: 'record', hit }));
		}
	});

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
	const menuApps = $derived(mentionSources?.apps() ?? []);
	const parsedQuery = $derived(trigger ? parseCommandQuery(trigger.query, menuCollections) : null);
	const menuEntries = $derived(
		parsedQuery ? buildMentionMenuEntries(parsedQuery, menuCollections, menuItems, menuApps) : []
	);
	const highlight = $derived(
		menuEntries.length === 0 ? 0 : Math.min(highlightIndex, menuEntries.length - 1)
	);

	// Search is callback-driven: refreshTrigger is the only writer. Identity is parsed
	// collection+text, so a caret move that does not change the search does not restart it.
	function scheduleMentionSearch(): void {
		const sources = mentionSources;
		const parsed = parsedQuery;
		const identity = recordSearchIdentity(parsed);
		if (identity !== mentionHighlightIdentity) {
			mentionHighlightIdentity = identity;
			highlightIndex = 0;
		}
		mentionSearch.schedule(
			identity,
			parsed,
			sources !== null && parsed !== null && shouldSearchRecords(parsed)
		);
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

	function rewriteQuery(nextQuery: string): void {
		const element = textareaElement;
		const active = trigger;
		if (!element || !active) return;
		const next = rewriteTriggerQuery(element.value, mentions, active, nextQuery);
		applyDraft(next.draft, next.mentions, next.caret);
	}

	function selectMenuItem(item: MentionMenuItem | undefined): void {
		if (!item) return;
		const element = textareaElement;
		const active = trigger;
		if (!element || !active) return;
		switch (item.kind) {
			case 'command': {
				switch (item.command) {
					case 'record':
						rewriteQuery(commandPrefixChar('record'));
						return;
					case 'app':
						rewriteQuery(commandPrefixChar('app'));
						return;
					case 'plan': {
						planMode = true;
						const next = consumeTrigger(element.value, mentions, active, parsedQuery?.text ?? '');
						applyDraft(next.draft, next.mentions, next.caret);
						return;
					}
					default: {
						const _exhaustive: never = item.command;
						return _exhaustive;
					}
				}
			}
			case 'scope': {
				const next = rewriteTriggerQuery(
					element.value,
					mentions,
					active,
					`${commandPrefixChar('record')}${item.collection} `
				);
				applyDraft(next.draft, next.mentions, next.caret);
				return;
			}
			case 'collection': {
				const next = consumeTrigger(
					element.value,
					mentions,
					active,
					`collection:${item.collection}`
				);
				applyDraft(next.draft, next.mentions, next.caret);
				return;
			}
			case 'app': {
				const next = consumeTrigger(element.value, mentions, active, `app:${item.key}`);
				applyDraft(next.draft, next.mentions, next.caret);
				return;
			}
			case 'record': {
				const caret = element.selectionStart ?? element.value.length;
				const next = insertMention(element.value, mentions, { ...active, caret }, item.hit);
				applyDraft(next.draft, next.mentions, next.caret);
				return;
			}
			default: {
				const _exhaustive: never = item;
				return _exhaustive;
			}
		}
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
		const labels = new SvelteMap<string, string>();
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
	function webAgentLabel(userId: string): string {
		if (currentUserId === userId) return t('pod.agent.webAgentMe');
		return t('pod.agent.webAgentMember', {
			name: userLabels.get(userId) ?? t('pod.agent.unknownMember')
		});
	}

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
		const byUser = new SvelteMap<string, SessionRow[]>();
		for (const session of personal) {
			const rows = byUser.get(session.user_id) ?? [];
			rows.push(session);
			byUser.set(session.user_id, rows);
		}
		for (const [userId, rows] of [...byUser].sort((a, b) =>
			webAgentLabel(a[0]).localeCompare(webAgentLabel(b[0]))
		)) {
			const id = `workspace-user:${userId}`;
			disabledIds.push(id);
			workspaceChildren.push({
				id,
				title: webAgentLabel(userId),
				icon: 'lucide:monitor-user',
				metadata: { kind: 'group' },
				children: rows.map((session) => ({
					id: session.norbital_id,
					title: session.title,
					icon: 'lucide:message-square',
					metadata: { kind: 'conversation' }
				}))
			});
		}

		const channelProfiles = new SvelteMap<string, SessionRow[]>();
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
				icon: 'product:agent',
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
	const rootTurn = $derived(
		[...turnRows].filter((turn) => turn.subagent_id == null).at(-1) as
			Record<string, unknown> | undefined
	);
	/** `agentChatStart` returns before inference; the replicated root turn owns in-flight after that. */
	const composerLocked = $derived(
		pending || rootTurn?.status === 'running' || rootTurn?.status === 'queued'
	);
	const terminalMessage = $derived(messages.at(-1));
	const replicaFailure = $derived.by(() => {
		const root = rootTurn;
		if (root?.status === 'failed' || root?.status === 'aborted') {
			return typeof root.error === 'string' && root.error.trim()
				? root.error
				: t('pod.agent.couldNotFinish');
		}
		const terminal = terminalMessage;
		if (terminal?.kind === 'text' && terminal.role === 'system') {
			return terminal.content.trim() || t('pod.agent.couldNotFinish');
		}
		return null;
	});
	const failure = $derived(sendFailure ?? replicaFailure);
	const activityState = $derived(
		agentOrbState({
			pending: composerLocked,
			messages: activeSession?.messages,
			turns: activeSession?.turns
		})
	);
	const canSend = $derived(draft.trim().length > 0 && !composerLocked && !activeSessionIsReadOnly);
	const previewIntent = $derived(
		resolveAgentIntent({
			message: draft,
			planMode,
			verifierPrompt: verifierOverride,
			mentionCount: mentions.length
		})
	);
	const verifierPrompt = $derived(previewIntent.verifierPrompt);
	const verifierPreview = $derived(verifierPrompt.split('\n')[0] ?? '');

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

	// A tool call is the agent doing something. Once one is on screen it carries its own progress, and
	// a second "Working…" placeholder beside it says less than the call already does.
	const agentHasSpoken = $derived(
		messages.some(
			(message) =>
				message.kind === 'tool' ||
				message.kind === 'checkpoint' ||
				message.kind === 'reasoning' ||
				message.kind === 'goal' ||
				message.kind === 'verifier' ||
				(message.kind === 'text' && message.role === 'assistant')
		)
	);

	/**
	 * The catalog and selected model are shared by every route/sheet panel. Cmd+K (and the FAB) ask
	 * for composer focus through a window event: the panel may live in the sheet portal or on the
	 * full-page /agent surface, and the shell must not know which.
	 */
	onMount(() => {
		void loadAgentModelCatalog(getWorkspaceRemoteTransport());

		function onFocusRequest(event: Event): void {
			const seed =
				event instanceof CustomEvent ? (event.detail as AgentComposerSeed | undefined) : undefined;
			if (seed?.planMode) planMode = true;
			if (seed?.message) {
				draft = seed.message;
				lastDraft = seed.message;
			}
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
		if (!message || composerLocked || activeSessionIsReadOnly) return;
		const { verify, verifierPrompt: resolvedVerifierPrompt } = previewIntent;
		pending = true;
		sendFailure = null;
		echo = message;
		draft = '';
		lastDraft = '';
		mentions = [];
		trigger = null;
		suppressedTriggerStart = null;
		mentionHighlightIdentity = '';
		menuItems = [];
		menuLoading = false;
		mentionSearch.invalidate();
		try {
			const result = await getWorkspaceRemoteTransport().agentChatStart({
				message,
				// Only chips the picker created. An `@` that never matched is already in the text.
				...(references.length > 0 ? { mentions: references } : {}),
				...(activeRunId ? { runId: activeRunId } : {}),
				...(planMode ? { planMode: true, intent: 'plan' as const } : { intent: 'do' as const }),
				...(verify ? { verifierPrompt: resolvedVerifierPrompt } : {}),
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
			// `agentChatStart` returns before inference; the replicated root turn owns in-flight after this.
			pending = false;
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : String(cause);
			sendFailure =
				!message || message === 'INTERNAL_ERROR' || message === t('pod.server.internalError')
					? t('pod.agent.couldNotStart')
					: message;
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
		sendFailure = null;
	}

	function startConversation(): void {
		chatId = undefined;
		runId = undefined;
		composingNew = true;
		echo = null;
		sendFailure = null;
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
				if (parsedQuery?.collection) {
					rewriteQuery(commandPrefixChar('record'));
					return;
				}
				if (parsedQuery?.scope) {
					rewriteQuery('');
					return;
				}
				suppressedTriggerStart = trigger?.start ?? null;
				trigger = null;
				return;
			}
			if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
				if (menuEntries.length > 0) {
					event.preventDefault();
					selectMenuItem(menuEntries[highlight]);
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
		{#if headerOrb}
			<div
				class="grid size-8 shrink-0 place-items-center text-foreground"
				data-testid="agent-activity-orb"
			>
				<NorbitalThinkingOrb
					state={activityState}
					size={22}
					label={activityState === 'idle'
						? t('pod.shell.workspaceAgentTitle')
						: t(agentOrbStatusKey(activityState))}
				/>
			</div>
		{/if}
		<div class="min-w-0 flex-1">
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
		</div>
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
	{#if messages.length === 0 && !composerLocked}
		<div class="grid min-h-0 flex-1 place-items-center overflow-y-auto px-6 py-10">
			<div class="max-w-sm text-center">
				<div class="mx-auto mb-4 grid size-12 place-items-center rounded-xl bg-card shadow-xs">
					<NorbitalThinkingOrb state="idle" size={34} class="text-foreground" />
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
			{@attach (node) => {
				void messages.length;
				queueMicrotask(() => {
					node.scrollTop = node.scrollHeight;
				});
			}}
			class="flex min-h-0 flex-1 list-none flex-col gap-2 overflow-y-auto px-4 py-5 sm:px-5"
			aria-live="polite"
			aria-label={t('pod.agent.conversationAria')}
		>
			{#each messages as message (message.key)}
				<AgentTranscriptItem
					{message}
					onVerifierPrompt={async (prompt) => {
						const id = activeRunId;
						if (!id) return;
						const update = getWorkspaceRemoteTransport().agentChatUpdateVerifier;
						if (update) await update({ runId: id, prompt });
					}}
				/>
			{/each}
			{#if composerLocked && !agentHasSpoken}
				<li class="my-1.5 flex flex-col gap-1.5" aria-label={t('pod.agent.agentIsWorking')}>
					<span class="px-1 text-tiny font-medium text-muted-foreground"
						>{t('pod.agent.agent')}</span
					>
					<div
						class="inline-flex w-fit items-center gap-2.5 rounded-xl bg-muted px-3.5 py-2.5 text-sm"
					>
						<NorbitalThinkingOrb state={activityState} size={20} class="text-foreground" />
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
						highlightIndex={highlight}
						loading={menuLoading}
						query={parsedQuery?.text ?? ''}
						scope={parsedQuery?.collection ?? null}
						onselect={(index) => selectMenuItem(menuEntries[index])}
						onhighlight={(index) => (highlightIndex = index)}
						onclearscope={() => rewriteQuery(commandPrefixChar('record'))}
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
							onkeyup={(event) => {
								if (
									menuOpen &&
									(event.key === 'ArrowDown' ||
										event.key === 'ArrowUp' ||
										event.key === 'Escape' ||
										event.key === 'Tab' ||
										(event.key === 'Enter' && !event.shiftKey))
								) {
									return;
								}
								refreshTrigger();
							}}
							onclick={refreshTrigger}
							aria-autocomplete="list"
							aria-expanded={menuOpen}
							aria-controls="agent-mention-menu"
							placeholder={t('pod.agent.composerPlaceholder')}
							rows={1}
							class={AGENT_COMPOSER_EDITOR_CLASS}
							disabled={composerLocked}
						/>
					</div>

					{#if previewIntent.verify}
						<details class="group/verifier px-2.5 sm:px-3" data-testid="agent-verifier">
							<!-- stupidity:allow UI6 -- verifier disclosure is a clickable control row. -->
							<summary
								class={`flex min-w-0 cursor-pointer list-none items-center gap-2 rounded-md px-1.5 py-1 text-muted-foreground transition-colors duration-150 hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-ring ${AGENT_COMPOSER_CONTROL_TEXT_CLASS}`}
							>
								<Icon icon="lucide:shield-check" class="size-3.5 shrink-0" />
								<span class="shrink-0">{t('pod.agent.verifierWillCheck')}</span>
								<span class="min-w-0 flex-1 truncate text-tiny text-muted-foreground/70"
									>{verifierPreview}</span
								>
								<Icon
									icon="lucide:chevron-right"
									class="ml-auto size-3 shrink-0 text-muted-foreground/45 transition-transform duration-150 group-open/verifier:rotate-90"
								/>
							</summary>
							<Stack gap="xs" class="px-1.5 pb-1.5">
								<p class="m-0 text-tiny text-muted-foreground">
									{t('pod.agent.verifierPromptHint')}
								</p>
								<label class="sr-only" for="agent-verifier-prompt"
									>{t('pod.agent.verifierPrompt')}</label
								>
								<Textarea
									id="agent-verifier-prompt"
									data-testid="agent-verifier-prompt"
									value={verifierPrompt}
									oninput={(event) => {
										verifierOverride = event.currentTarget.value;
									}}
									rows={3}
									disabled={composerLocked}
									class="min-h-16 max-h-32 resize-none border-border/60 bg-muted/30 px-2.5 py-2 text-xs shadow-none focus-visible:ring-1"
								/>
							</Stack>
						</details>
					{/if}

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
								disabled={composerLocked}
								onclick={() => {
									planMode = !planMode;
									verifierOverride = null;
								}}
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
									disabled={composerLocked || modelState.status !== 'ready'}
								/>
							</div>
							<Button
								type="submit"
								disabled={!canSend}
								size="icon"
								class="size-8 shrink-0 rounded-full"
								data-testid="agent-send"
								aria-label={composerLocked ? t('pod.agent.agentIsWorking') : t('pod.agent.send')}
							>
								{#if composerLocked}
									<NorbitalThinkingOrb state={activityState} size={18} />
								{:else}
									<Icon icon="lucide:arrow-up" class="size-4" />
								{/if}
							</Button>
						</Inline>
					</div>
				</form>
			</div>
		{/if}
	</div>
</Stack>
