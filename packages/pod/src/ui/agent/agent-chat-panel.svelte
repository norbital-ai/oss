<script lang="ts">
	import Icon from '@iconify/svelte';
	import { onMount, tick } from 'svelte';
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import { Button } from '@norbital-ai/ui/button';
	import { IconWrapper } from '@norbital-ai/ui/icon-wrapper';
	import ConversationSelector from './conversation-selector.svelte';
	import ConversationScopePicker from './conversation-scope-picker.svelte';
	import { Textarea } from '@norbital-ai/ui/textarea';
	import { Bound, Center, Inline, Scroll, Stack } from '@norbital-ai/ui/layout';
	import { Spinner } from '@norbital-ai/ui/spinner';
	import { getWorkspaceRemoteTransport } from '$lib/authoring/workspace/remote-transport.js';
	import { getInitializedWorkspaceClient } from '$lib/ui/state/client.js';
	import { getPlatformStateContext } from '$lib/ui/state/platform_state.svelte.js';
	import { toPanelMessages, toPanelUsage, toSessionTotals, withPendingEcho } from './transcript.js';
	import AgentModelPicker from './agent-model-picker.svelte';
	import { getAgentModelState, loadAgentModelCatalog } from './agent-model-state.svelte.js';
	import AgentMentionMenu from './agent-mention-menu.svelte';
	import AgentTranscriptItem from './agent-transcript-item.svelte';
	import NorbitalThinkingOrb from './norbital-thinking-orb.svelte';
	import {
		buildConversationSelector,
		conversationTriggerLabel,
		scopeConversationSessions,
		sessionVisibleInScope,
		type ConversationSelectorLabels,
		type ConversationSession
	} from './conversation-selector.js';
	import { writeAgentSurface } from './agent-activity-state.svelte.js';
	import {
		AGENT_TURN_STALE_MS,
		agentOrbBusyStatusKey,
		agentOrbState,
		agentOrbStatusKey
	} from './agent-orb-state.js';
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
	import { formatFinderEntityForPrompt } from '../finder/finder-entity.js';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import type { PodUiKeys } from '$lib/i18n/index.js';
	import { resolveAgentIntent } from '$lib/shared/agent/intent.js';

	const { t } = useI18n<PodUiKeys>();

	let { headerOrb = true }: { headerOrb?: boolean } = $props();

	let draft = $state('');
	const modelState = getAgentModelState();
	let session = $state<{
		runId: string | undefined;
		chatId: string | undefined;
		pending: boolean;
		echo: string | null;
		sendFailure: string | null;
		waitedTooLong: boolean;
		composingNew: boolean;
	}>({
		runId: undefined,
		chatId: undefined,
		pending: false,
		echo: null,
		sendFailure: null,
		waitedTooLong: false,
		composingNew: false
	});
	let planMode = $state(false);
	let verifierOverride = $state<string | null>(null);
	let platformState = $state<ReturnType<ReturnType<typeof getPlatformStateContext>> | null>(null);

	// ── "@" mentions ────────────────────────────────────────────────────────────────────────────
	// The draft stays plain text; chips are tracked ranges beside it. The menu never takes focus —
	// every key is decided in the textarea's own keydown, which is what keeps the flow keyboard-only.
	let mention = $state<{
		textarea: HTMLTextAreaElement | null;
		mentions: readonly ComposerMention[];
		lastDraft: string;
		trigger: MentionTrigger | null;
		suppressedTriggerStart: number | null;
		menuItems: readonly MentionMenuItem[];
		menuLoading: boolean;
		highlightIndex: number;
		highlightIdentity: string;
		sources: MentionSources | null;
	}>({
		textarea: null,
		mentions: [],
		lastDraft: '',
		trigger: null,
		suppressedTriggerStart: null,
		menuItems: [],
		menuLoading: false,
		highlightIndex: 0,
		highlightIdentity: '',
		sources: null
	});

	const mentionSearch = createDebouncedRecordSearch({
		search: (text, collection) => {
			const sources = mention.sources;
			if (!sources) return Promise.resolve([]);
			return sources.search(text, collection);
		},
		onLoading: (loading) => {
			mention.menuLoading = loading;
		},
		onResults: (hits) => {
			mention.menuItems = hits.map((hit): MentionMenuItem => ({ kind: 'record', hit }));
		}
	});

	// Mounted bare (a component test, a host surface without platform state) there is no manifest
	// to search, and the feature is simply absent rather than half-alive.
	try {
		const getPlatformState = getPlatformStateContext();
		if (typeof getPlatformState === 'function') {
			platformState = getPlatformState();
			mention.sources = createMentionSources(() => getPlatformState().manifestContext);
		}
	} catch {
		mention.sources = null;
	}

	const menuOpen = $derived(mention.trigger !== null && mention.sources !== null);
	const menuCollections = $derived(mention.sources?.collections() ?? []);
	const menuApps = $derived(mention.sources?.apps() ?? []);
	const parsedQuery = $derived(
		mention.trigger ? parseCommandQuery(mention.trigger.query, menuCollections) : null
	);
	const menuEntries = $derived(
		parsedQuery
			? buildMentionMenuEntries(parsedQuery, menuCollections, mention.menuItems, menuApps)
			: []
	);
	const highlight = $derived(
		menuEntries.length === 0 ? 0 : Math.min(mention.highlightIndex, menuEntries.length - 1)
	);

	// Search is callback-driven: refreshTrigger is the only writer. Identity is parsed
	// collection+text, so a caret move that does not change the search does not restart it.
	/** Schedules debounced record search when the parsed mention query identity changes. */
	function scheduleMentionSearch(): void {
		const sources = mention.sources;
		const parsed = parsedQuery;
		const identity = recordSearchIdentity(parsed);
		if (identity !== mention.highlightIdentity) {
			mention.highlightIdentity = identity;
			mention.highlightIndex = 0;
		}
		mentionSearch.schedule(
			identity,
			parsed,
			sources !== null && parsed !== null && shouldSearchRecords(parsed)
		);
	}

	/** Recomputes the active @-mention trigger from caret position and draft text. */
	function refreshTrigger(): void {
		const element = mention.textarea;
		if (!element) {
			mention.trigger = null;
			scheduleMentionSearch();
			return;
		}
		const found = findMentionTrigger(
			element.value,
			element.selectionStart ?? element.value.length,
			mention.mentions
		);
		if (found && found.start === mention.suppressedTriggerStart) {
			mention.trigger = null;
			scheduleMentionSearch();
			return;
		}
		mention.suppressedTriggerStart = null;
		mention.trigger = found;
		scheduleMentionSearch();
	}

	/** Reconciles mention chip ranges after the writer edits the composer draft. */
	function onComposerInput(): void { // stupidity:allow Q3 -- event handler
		const element = mention.textarea;
		if (!element) return;
		mention.mentions = reconcileAfterEdit(mention.mentions, mention.lastDraft, element.value);
		mention.lastDraft = element.value;
		refreshTrigger();
	}

	/** Updates draft, mentions, and caret together after a mention-menu action. */
	function applyDraft(next: string, nextMentions: readonly ComposerMention[], caret: number): void {
		draft = next;
		mention.lastDraft = next;
		mention.mentions = nextMentions;
		void tick().then(() => {
			const element = mention.textarea;
			if (element) {
				element.focus();
				element.setSelectionRange(caret, caret);
			}
			refreshTrigger();
		});
	}

	/** Replaces the active mention trigger query without closing the menu. */
	function rewriteQuery(nextQuery: string): void {
		const element = mention.textarea;
		const active = mention.trigger;
		if (!element || !active) return;
		const next = rewriteTriggerQuery(element.value, mention.mentions, active, nextQuery);
		applyDraft(next.draft, next.mentions, next.caret);
	}

	/** Applies a mention-menu choice to the composer draft. */
	function selectMenuItem(item: MentionMenuItem | undefined): void {
		if (!item) return;
		const element = mention.textarea;
		const active = mention.trigger;
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
						const next = consumeTrigger(
							element.value,
							mention.mentions,
							active,
							parsedQuery?.text ?? ''
						);
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
					mention.mentions,
					active,
					`${commandPrefixChar('record')}${item.collection} `
				);
				applyDraft(next.draft, next.mentions, next.caret);
				return;
			}
			case 'collection': {
				const insert = formatFinderEntityForPrompt({
					kind: 'collection',
					collection: item.collection
				});
				const next = consumeTrigger(
					element.value,
					mention.mentions,
					active,
					insert?.text ?? `collection:${item.collection}`
				);
				applyDraft(next.draft, next.mentions, next.caret);
				return;
			}
			case 'app': {
				const insert = formatFinderEntityForPrompt({
					kind: 'app',
					key: item.key,
					label: item.label,
					href: item.href ?? `/app/${item.key}`,
					description: item.description ?? null
				});
				const next = consumeTrigger(
					element.value,
					mention.mentions,
					active,
					insert?.text ?? `${item.label}`
				);
				applyDraft(next.draft, next.mentions, next.caret);
				return;
			}
			case 'record': {
				const insert = formatFinderEntityForPrompt({
					kind: 'record',
					collection: item.hit.collection,
					recordId: item.hit.recordId,
					label: item.hit.label
				});
				const caret = element.selectionStart ?? element.value.length;
				const next = insertMention(
					element.value,
					mention.mentions,
					{ ...active, caret },
					insert?.mention ?? item.hit
				);
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
	/** Maps a replicated chat_session row into the conversation-selector session shape. */
	function toSelectorSession(session: SessionRow): ConversationSession {
		return {
			id: session.norbital_id,
			title: session.title,
			userId: session.user_id,
			visibility: session.visibility,
			platform: session.platform,
			channelKey: session.channel_key,
			externalThreadId: session.external_thread_id
		};
	}
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
	let scopeUserId = $state<string | null>(null);
	const resolvedScopeUserId = $derived(scopeUserId ?? currentUserId);
	const usersQuery = $derived.by(() => {
		if (!isAdmin) return undefined;
		try {
			return getInitializedWorkspaceClient().db.user?.findMany({
				where: { kind: 'human' },
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
	const selectorLabels = $derived.by(
		(): ConversationSelectorLabels => ({
			web: t('pod.agent.webChannel'),
			users: t('pod.agent.users'),
			groups: t('pod.agent.groups'),
			channelFallback: t('pod.agent.channelAgent')
		})
	);
	const selectorSessions = $derived(sessions.map(toSelectorSession));
	const publicChannelKeys = $derived.by(() => {
		const keys = new SvelteSet<string>();
		const channels = platformState?.manifestContext?.manifest?.channels ?? {};
		for (const [key, channel] of Object.entries(channels)) {
			if (channel.audience === 'public') keys.add(key);
		}
		return keys;
	});
	const conversationScope = $derived({
		scopeUserId: resolvedScopeUserId,
		currentUserId,
		isAdmin,
		publicChannelKeys
	});
	const scopedSelectorSessions = $derived(
		scopeConversationSessions(selectorSessions, conversationScope)
	);
	const conversationSelector = $derived(
		buildConversationSelector({
			sessions: scopedSelectorSessions,
			labels: selectorLabels
		})
	);
	const scopeOptions = $derived.by(() => {
		if (!isAdmin || currentUserId == null) return [];
		const options: { id: string; label: string }[] = [
			{ id: currentUserId, label: t('pod.agent.me') }
		];
		for (const [id, label] of userLabels) {
			if (id === currentUserId) continue;
			options.push({ id, label });
		}
		return options;
	});
	const showScopePicker = $derived(isAdmin && scopeOptions.length > 1);

	/**
	 * The live conversation: the user's explicit pick, or the newest session once any exist.
	 * `chatId` stays the user's choice (and `undefined` while composing fresh); the derivation is
	 * what defaults to the latest session, so a session arriving over sync lights up the picker
	 * without anyone having to watch for it.
	 */
	const activeChatId = $derived(
		session.chatId ??
			(session.composingNew || scopedSelectorSessions.length === 0
				? undefined
				: scopedSelectorSessions[0].id)
	);
	const activeRunId = $derived.by(() => {
		if (!activeChatId) return session.runId;
		return (
			sessions.find((row) => row.norbital_id === activeChatId)?.automation_run_id ?? session.runId
		);
	});

	/** One replicated tenant row is the complete live conversation aggregate. */
	const activeSession = $derived(sessions.find((row) => row.norbital_id === activeChatId));
	const conversationDisplayLabel = $derived(
		conversationTriggerLabel({
			session: activeSession ? toSelectorSession(activeSession) : undefined,
			model: conversationSelector,
			labels: selectorLabels
		})
	);
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
	const messages = $derived(withPendingEcho(stored, session.echo));
	const turnRows = $derived(activeSession?.turns ?? []);
	const rootTurn = $derived(
		[...turnRows].filter((turn) => turn.subagent_id == null).at(-1) as
			Record<string, unknown> | undefined
	);
	/** `agentChatStart` returns before inference; the replicated root turn owns in-flight after that. */
	const composerLocked = $derived(
		!session.sendFailure &&
			!session.waitedTooLong &&
			(session.pending || rootTurn?.status === 'running' || rootTurn?.status === 'queued')
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
	const failure = $derived(
		session.sendFailure ??
			replicaFailure ??
			(session.waitedTooLong ? t('pod.agent.couldNotFinish') : null)
	);
	const activityState = $derived(
		agentOrbState({
			pending: composerLocked,
			failed: failure != null,
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
			mentionCount: mention.mentions.length
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

	/** Pushes composer identity into the shared shell and FAB activity store. */
	function syncAgentSurface(): void {
		writeAgentSurface({
			chatId: session.chatId,
			composingNew: session.composingNew,
			pending: session.pending,
			failed: session.sendFailure != null || session.waitedTooLong
		});
	}

	/**
	 * The catalog and selected model are shared by every route/sheet panel. Cmd+K (and the FAB) ask
	 * for composer focus through a window event: the panel may live in the sheet portal or on the
	 * full-page /agent surface, and the shell must not know which.
	 */
	onMount(() => {
		void loadAgentModelCatalog(getWorkspaceRemoteTransport());

		/** Seeds and focuses the composer when the shell broadcasts a focus request. */
		function onFocusRequest(event: Event): void {
			const seed =
				event instanceof CustomEvent ? (event.detail as AgentComposerSeed | undefined) : undefined;
			if (seed?.planMode) planMode = true;
			if (seed?.message) {
				draft = seed.message;
				mention.lastDraft = seed.message;
			}
			const element = mention.textarea;
			if (!element) return;
			element.focus();
			element.setSelectionRange(element.value.length, element.value.length);
		}
		window.addEventListener(AGENT_COMPOSER_FOCUS_EVENT, onFocusRequest);
		return () => window.removeEventListener(AGENT_COMPOSER_FOCUS_EVENT, onFocusRequest);
	});

	/** Starts an agent turn with the current draft, mentions, and model selection. */
	async function send(): Promise<void> {
		const { message, references } = serializeMentions(draft, mention.mentions);
		if (!message || composerLocked || activeSessionIsReadOnly) return;
		const { verify, verifierPrompt: resolvedVerifierPrompt } = previewIntent;
		if (!activeChatId) session.composingNew = true;
		session.pending = true;
		session.sendFailure = null;
		session.waitedTooLong = false;
		session.echo = message;
		draft = '';
		mention.lastDraft = '';
		mention.mentions = [];
		mention.trigger = null;
		mention.suppressedTriggerStart = null;
		mention.highlightIdentity = '';
		mention.menuItems = [];
		mention.menuLoading = false;
		mentionSearch.invalidate();
		syncAgentSurface();
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
			session.runId = result.runId;
			session.chatId = result.chatId;
			session.composingNew = false;
			// `agentChatStart` returns before inference; the replicated root turn owns in-flight after this.
			session.pending = false;
			syncAgentSurface();
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : String(cause);
			session.sendFailure =
				!message || message === 'INTERNAL_ERROR' || message === t('pod.server.internalError')
					? t('pod.agent.couldNotStart')
					: message;
			session.pending = false;
			syncAgentSurface();
		}
	}

	/** Switches the panel to an existing replicated session. */
	function selectConversation(value: string | null): void { // stupidity:allow Q3 -- event handler
		if (!value) return;
		const row = sessions.find((candidate) => candidate.norbital_id === value);
		if (!row) return;
		session.chatId = row.norbital_id;
		session.runId = row.automation_run_id ?? undefined;
		session.composingNew = false;
		session.echo = null;
		session.sendFailure = null;
		session.waitedTooLong = false;
		syncAgentSurface();
	}

	/** Filters the conversation list to one member and drops a thread outside that scope. */
	function selectScope(userId: string): void { // stupidity:allow Q3 -- event handler
		scopeUserId = userId;
		if (session.chatId && sessions.some((row) => row.norbital_id === session.chatId)) {
			const current = sessions.find((row) => row.norbital_id === session.chatId);
			if (
				current &&
				!sessionVisibleInScope(toSelectorSession(current), {
					scopeUserId: userId,
					currentUserId,
					isAdmin,
					publicChannelKeys
				})
			) {
				session.chatId = undefined;
				session.runId = undefined;
				session.composingNew = false;
			}
		}
		syncAgentSurface();
	}

	/** Clears the active thread so the next send creates a new conversation. */
	function startConversation(): void { // stupidity:allow Q3 -- event handler
		scopeUserId = currentUserId;
		session.chatId = undefined;
		session.runId = undefined;
		session.composingNew = true;
		session.echo = null;
		session.sendFailure = null;
		session.waitedTooLong = false;
		syncAgentSurface();
	}

	/** Routes keyboard input between the mention menu and the send action. */
	function onKeydown(event: KeyboardEvent): void { // stupidity:allow Q3 -- event handler
		if (menuOpen) {
			if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
				event.preventDefault();
				if (menuEntries.length === 0) return;
				const step = event.key === 'ArrowDown' ? 1 : -1;
				mention.highlightIndex =
					(mention.highlightIndex + step + menuEntries.length) % menuEntries.length;
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
				mention.suppressedTriggerStart = mention.trigger?.start ?? null;
				mention.trigger = null;
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
					mention.suppressedTriggerStart = mention.trigger?.start ?? null;
					mention.trigger = null;
					return;
				}
			}
		}
		if (event.key === 'Backspace' || event.key === 'Delete') {
			const element = mention.textarea;
			if (element) {
				const deletion = mentionDeletion(
					element.value,
					mention.mentions,
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
	<Inline
		as="header"
		justify="between"
		gap="sm"
		shrink={false}
		class="border-b px-3 py-2.5 sm:px-4"
	>
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
		{#if showScopePicker && resolvedScopeUserId}
			<ConversationScopePicker
				value={resolvedScopeUserId}
				options={scopeOptions}
				searchPlaceholder={t('pod.agent.searchMembers')}
				ariaLabel={t('pod.agent.conversationScope')}
				onValueChange={selectScope}
			/>
		{/if}
		<div class="min-w-0 flex-1">
			<ConversationSelector
				model={conversationSelector}
				value={activeChatId}
				displayLabel={conversationDisplayLabel}
				placeholder={t('pod.agent.noConversations')}
				searchPlaceholder={t('pod.agent.searchConversations')}
				ariaLabel={t('pod.agent.conversationThread')}
				emptyLabel={t('pod.agent.noConversations')}
				onValueChange={(id) => selectConversation(id)}
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
		<Bound size="full" grow>
			<Scroll name={t('pod.agent.askAboutWorkspace')} axis="y" class="px-6 py-10">
				<Center measure="narrow" layout="stack" gap="md" align="center" class="text-center">
					<Inline
						justify="center"
						align="center"
						class="size-12 rounded-xl bg-card shadow-xs"
					>
						<IconWrapper name="product:pod" class="size-7 text-foreground" />
					</Inline>
					<h2 class="text-base font-semibold tracking-[-0.015em] text-foreground">
						{t('pod.agent.askAboutWorkspace')}
					</h2>
					<p class="text-sm leading-6 text-muted-foreground">
						{t('pod.agent.askDescription')}
					</p>
				</Center>
			</Scroll>
		</Bound>
	{:else}
		<Bound size="full" grow>
			<Scroll
				as="ol"
				axis="y"
				name="agent-transcript"
				layout="stack"
				gap="sm"
				class="list-none px-4 py-5 sm:px-5"
				aria-live="polite"
				{@attach (node) => {
					void messages.length;
					queueMicrotask(() => {
						node.scrollTop = node.scrollHeight;
					});
				}}
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
				{#if (composerLocked || session.waitedTooLong) && !agentHasSpoken}
					<Stack
						as="li"
						gap="sm"
						aria-label={session.waitedTooLong
							? t('pod.agent.failed')
							: t('pod.agent.agentIsWorking')}
						{@attach () => {
							if (!composerLocked || agentHasSpoken) return;
							const timer = window.setTimeout(() => {
								session.waitedTooLong = true;
								writeAgentSurface({
									chatId: session.chatId,
									composingNew: session.composingNew,
									pending: false,
									failed: true
								});
							}, AGENT_TURN_STALE_MS);
							return () => window.clearTimeout(timer);
						}}
					>
						<span class="px-1 text-tiny font-medium text-muted-foreground"
							>{t('pod.agent.agent')}</span
						>
						<Inline class="w-fit rounded-xl bg-muted px-3.5 py-2.5 text-sm">
							{#if session.waitedTooLong}
								<NorbitalThinkingOrb
									state="failed"
									size={20}
									label={t('pod.agent.failed')}
									class="text-destructive"
								/>
								<span class="text-destructive">{t('pod.agent.failed')}</span>
							{:else}
								<Spinner
									class="size-4 text-foreground"
									label={t(agentOrbBusyStatusKey(activityState))}
								/>
								<span class="text-muted-foreground">{t(agentOrbBusyStatusKey(activityState))}</span>
							{/if}
						</Inline>
					</Stack>
				{/if}
			</Scroll>
		</Bound>
	{/if}

	<Stack shrink={false} gap="sm" class="bg-background px-3 pb-3 sm:px-4 sm:pb-4">
		{#if failure}
			<Inline
				align="start"
				gap="sm"
				class="rounded-lg bg-destructive/10 px-3 py-2 text-xs leading-5 text-destructive"
				role="alert"
			>
				<Icon icon="lucide:circle-alert" class="mt-0.5 size-3.5 shrink-0" />
				<span>{failure}</span>
			</Inline>
		{/if}

		{#if activeSessionIsReadOnly}
			<Inline
				align="center"
				gap="sm"
				class="rounded-lg bg-muted px-3 py-2.5 text-xs leading-5 text-muted-foreground"
				role="note"
			>
				<Icon icon="lucide:lock-keyhole" class="size-3.5 shrink-0" />
				<span>
					{activeSessionIsChannel
						? t('pod.agent.channelReadOnly')
						: t('pod.agent.adminConversationReadOnly')}
				</span>
			</Inline>
		{:else}
			<div class="relative">
				{#if menuOpen}
					<AgentMentionMenu
						items={menuEntries}
						highlightIndex={highlight}
						loading={mention.menuLoading}
						query={parsedQuery?.text ?? ''}
						scope={parsedQuery?.collection ?? null}
						onselect={(index) => selectMenuItem(menuEntries[index])}
						onhighlight={(index) => (mention.highlightIndex = index)}
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
							bind:ref={mention.textarea}
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
									<Spinner class="size-4" label={t(agentOrbBusyStatusKey(activityState))} />
								{:else}
									<Icon icon="lucide:arrow-up" class="size-4" />
								{/if}
							</Button>
						</Inline>
					</div>
				</form>
			</div>
		{/if}
	</Stack>
</Stack>
