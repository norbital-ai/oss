<script lang="ts">
	import { Effect, Option, Result, Schema } from 'effect';
	import Icon from '@iconify/svelte';
	import { onMount, tick } from 'svelte';
	import { SvelteMap } from 'svelte/reactivity';
	import { Button } from '@norbital-ai/ui/button';
	import { IconWrapper } from '@norbital-ai/ui/icon-wrapper';
	import ConversationSelector from './conversation-selector.svelte';
	import ConversationScopePicker from './conversation-scope-picker.svelte';
	import { Textarea } from '@norbital-ai/ui/textarea';
	import { Bound, Center, Grid, Inline, Scroll, Stack } from '@norbital-ai/ui/layout';
	import { Spinner } from '@norbital-ai/ui/spinner';
	import { useAgentClient } from './client.svelte.js';
	import { getPlatformStateContext } from '#lib/client/ui/state/platform.js';
	import {
		formatSessionCost,
		projectStoredChatMessages,
		toPanelMessages,
		toPanelUsage,
		toSessionTotals,
		withPendingEcho
	} from '#lib/client/ui/agent/transcript.js';
	import AgentModelPicker from './agent-model-picker.svelte';
	import AgentMentionMenu from './agent-mention-menu.svelte';
	import AgentTranscriptItem from './agent-transcript-item.svelte';
	import { ThinkingOrb as NorbitalThinkingOrb } from '@norbital-ai/ui/thinking-orb';
	import {
		WEB_AGENT_ID,
		buildConversationSelector,
		listAccessibleEnvoys,
		publicEnvoyNames,
		sessionEnvoyId,
		sessionVisibleInScope
	} from '#lib/client/ui/agent/conversation-selector.js';
	import {
		agentOrbBusyStatusKey,
		agentOrbState,
		agentOrbStatusKey
	} from '#lib/client/ui/agent/agent-orb-state.js';
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
	} from '#lib/client/ui/agent/composer-mentions.js';
	import {
		AGENT_COMPOSER_CONTROL_TEXT_CLASS,
		AGENT_COMPOSER_EDITOR_CLASS,
		AGENT_COMPOSER_FOCUS_EVENT,
		AGENT_COMPOSER_SHELL_CLASS
	} from '#lib/client/ui/agent/composer-chrome.js';
	import {
		buildMentionMenuEntries,
		commandPrefixChar,
		createMentionSources,
		parseCommandQuery,
		recordSearchIdentity,
		shouldSearchRecords,
		type MentionMenuItem,
		type MentionSources
	} from '#lib/client/ui/agent/mention-sources.js';
	import { createDebouncedRecordSearch } from '#lib/client/ui/agent/debounced-record-search.js';
	import { formatFinderEntityForPrompt } from '#lib/client/ui/finder/finder-entity.js';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import { resolveAgentIntent } from '#lib/client/ui/agent/intent.js';
	import { workspaceSession } from '#lib/client/session.js';
	import {
		chatDocumentStorageKey,
		parseStoredChatInput,
		type ChatDocumentRef
	} from '#lib/runtime/agents/chat-messages.js';
	import { parseAgentMessage } from '#lib/runtime/agents/agent-message.js';
	import {
		retryableAdmission,
		withoutAdmittedDocuments,
		type UnsettledAgentAdmission
	} from '#lib/client/ui/agent/admission-reconciliation.js';

	const { t } = useI18n();
	const agentClient = useAgentClient();
	const runtime = $derived(agentClient.runtime);
	const decodeComposerSeed = Schema.decodeUnknownOption(
		Schema.Struct({
			message: Schema.optionalKey(Schema.String),
			planMode: Schema.optionalKey(Schema.Boolean)
		})
	);

	let { headerOrb = true }: { headerOrb?: boolean } = $props();

	let draft = $state('');
	let documents = $state<ChatDocumentRef[]>([]);
	let uploadingDocument = $state(false);
	let documentInput = $state<HTMLInputElement | null>(null);
	const modelState = $derived(agentClient.models.state);
	let session = $state<{
		runId: string | undefined;
		chatId: string | undefined;
		pending: boolean;
		echo: string | null;
		sendFailure: string | null;
		composingNew: boolean;
	}>({
		runId: undefined,
		chatId: undefined,
		pending: false,
		echo: null,
		sendFailure: null,
		composingNew: false
	});
	let planMode = $state(false);
	let verifierOverride = $state<string | null>(null);
	let queueActionPending = $state<string | null>(null);
	let unsettledAdmission = $state<UnsettledAgentAdmission | null>(null);
	/**
	 * The shell's live platform state, or nothing when the panel is mounted bare.
	 *
	 * Read as a getter rather than snapshotted: the shell fills its envoy list from
	 * `workspace.manifest` after mount, and a snapshot taken here would be the empty list forever.
	 * A component test or a host surface that never provided the context throws on the read, and the
	 * envoy-derived features are then simply absent rather than half-alive.
	 */
	const readPlatformState = Result.getOrElse(Result.try(getPlatformStateContext), () => null);
	const declaredEnvoys = $derived(readPlatformState?.().envoys ?? []);

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
			if (!sources) return Effect.succeed([]);
			return sources.search(text, collection);
		},
		onLoading: (loading) => {
			mention.menuLoading = loading;
		},
		onResults: (hits) => {
			mention.menuItems = hits.map((hit): MentionMenuItem => ({ kind: 'record', hit }));
		}
	});

	function refreshMentionSources(): void {
		mention.sources = createMentionSources({
			getCollections: () => agentClient.catalog.collections,
			getApps: () => agentClient.catalog.apps,
			findRecords: runtime.client.records.findMany
		});
	}

	refreshMentionSources();

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
	function onComposerInput(): void {
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

	const sessionQuery = $derived(
		runtime.client.db.chat_session.findMany({
			orderBy: { updated_at: 'desc' },
			limit: 5_000
		})
	);
	const allSessions = $derived(sessionQuery.current ?? []);
	/** Delegated sessions render beneath their parent call, never as conversations somebody opened. */
	const sessions = $derived(allSessions.filter((row) => row.parent_id === null));
	// The status the host reports, not a role. `roles.includes('admin')` was the old spelling and it
	// never matched anything: `admin` is not a role any workspace declares, so the agent's cross-user
	// scope picker was invisible to the administrators it exists for.
	const isAdmin = $derived(readPlatformState?.().user.admin === true);
	const currentUserId = $derived(readPlatformState?.().user.id ?? null);
	let scopeUserId = $state<string | null>(null);
	let selectedEnvoy = $state<string | null>(null);
	const resolvedScopeUserId = $derived(scopeUserId ?? currentUserId);
	// The system read policy masks this collection to the two fields the picker needs.
	const usersQuery = $derived(
		runtime.client.db.user.findMany({
			orderBy: { name: 'asc' },
			limit: 500
		})
	);
	const userLabels = $derived.by(() => {
		const labels = new SvelteMap<string, string>();
		if (!isAdmin) return labels;
		for (const row of usersQuery.current ?? []) {
			// Name or nothing: the read grant's field mask is `['id', 'name']`, so an address
			// is not merely unselected here — it cannot be read through this grant at all.
			const label = row.name.trim() ? row.name : t('bolt.agent.unknownMember');
			labels.set(row.id, label);
		}
		return labels;
	});
	const selectorLabels = $derived.by(
		(): Parameters<typeof buildConversationSelector>[0]['labels'] => ({
			web: t('bolt.agent.webAgent'),
			users: t('bolt.agent.users'),
			groups: t('bolt.agent.groups'),
			envoyFallback: t('bolt.agent.envoy')
		})
	);
	const publicEnvoyKeys = $derived(publicEnvoyNames(declaredEnvoys));
	const conversationScope = $derived({
		scopeUserId: resolvedScopeUserId,
		currentUserId,
		isAdmin,
		publicEnvoyKeys
	});
	const scopedSelectorSessions = $derived(
		sessions.filter((row) => sessionVisibleInScope(row, conversationScope))
	);
	const accessibleEnvoys = $derived(
		listAccessibleEnvoys({
			sessions: scopedSelectorSessions,
			labels: selectorLabels,
			declaredEnvoys,
			scope: conversationScope
		})
	);
	const resolvedEnvoy = $derived.by(() => {
		if (selectedEnvoy && accessibleEnvoys.some((envoy) => envoy.id === selectedEnvoy)) {
			return selectedEnvoy;
		}
		const open = session.chatId
			? sessions.find((row) => row.conversation_id === session.chatId)
			: undefined;
		if (open) return sessionEnvoyId(open, selectorLabels);
		return accessibleEnvoys[0]?.id ?? WEB_AGENT_ID;
	});
	const envoySelectorSessions = $derived(
		scopedSelectorSessions.filter((row) => sessionEnvoyId(row, selectorLabels) === resolvedEnvoy)
	);
	const showEnvoyPicker = $derived(accessibleEnvoys.length > 1);
	const envoyOptions = $derived(
		accessibleEnvoys.map((envoy) => ({
			id: envoy.id,
			label: envoy.label,
			icon: envoy.icon
		}))
	);
	const conversationSelector = $derived(
		buildConversationSelector({
			sessions: envoySelectorSessions,
			labels: selectorLabels
		})
	);
	const scopeOptions = $derived.by(() => {
		if (!isAdmin || currentUserId == null) return [];
		const options: { id: string; label: string }[] = [
			{ id: currentUserId, label: t('bolt.agent.me') }
		];
		for (const [id, label] of userLabels) {
			if (id === currentUserId) continue;
			options.push({ id, label });
		}
		return options;
	});
	const showScopePicker = $derived(isAdmin && currentUserId != null);
	const unsettledRunQuery = $derived(
		unsettledAdmission
			? runtime.client.db.agent_run.findMany({
					where: { task_id: { eq: unsettledAdmission.turnId } },
					limit: 1
				})
			: undefined
	);
	const replicatedAdmission = $derived.by(() => {
		const admission = unsettledAdmission;
		if (
			admission === null ||
			!sessions.some(({ conversation_id }) => conversation_id === admission.conversationId) ||
			!unsettledRunQuery?.current?.some(({ task_id }) => task_id === admission.turnId)
		) {
			return null;
		}
		return admission;
	});

	/**
	 * The live conversation: the user's explicit pick, or the newest session once any exist.
	 * `chatId` stays the user's choice (and `undefined` while composing fresh); the derivation is
	 * what defaults to the latest session, so a session arriving over sync lights up the picker
	 * without anyone having to watch for it.
	 */
	const activeChatId = $derived(
		session.chatId ??
			(session.composingNew || envoySelectorSessions.length === 0
				? undefined
				: envoySelectorSessions[0]?.conversation_id)
	);
	const activeRunId = $derived(activeChatId ?? session.runId);

	const activeSession = $derived(sessions.find((row) => row.conversation_id === activeChatId));
	const activeConversationIds = $derived.by(() => {
		if (activeChatId === undefined) return [];
		const ids = new Set([activeChatId]);
		let added = true;
		while (added) {
			added = false;
			for (const candidate of allSessions) {
				if (
					candidate.parent_id !== null &&
					ids.has(candidate.parent_id) &&
					!ids.has(candidate.conversation_id)
				) {
					ids.add(candidate.conversation_id);
					added = true;
				}
			}
		}
		return [...ids];
	});
	/**
	 * The selected conversation's messages are another standard live collection query. Sync refreshes
	 * it when `chat_message` advances; selecting a different conversation creates the corresponding
	 * keyed query rather than fetching history through an agent command.
	 *
	 * Keyed on a string, not on `activeConversationIds` itself: the id array gets a fresh identity
	 * every time any session row syncs (the agent writes `chat_session` usage totals throughout a
	 * turn), and a query rebuilt on each of those ticks starts over at `current === undefined` and
	 * never lives long enough to deliver rows — the transcript stays blank while the cost counter
	 * ticks. A string key invalidates only when the conversation set genuinely changes.
	 */
	const activeConversationKey = $derived(activeConversationIds.join('\u0000'));
	const messageQuery = $derived.by(() => {
		if (activeConversationKey.length === 0) return undefined;
		return runtime.client.db.chat_message.findMany({
			where: { conversation_id: { in: activeConversationKey.split('\u0000') } },
			orderBy: { sequence: 'asc' },
			limit: 5_000
		});
	});
	const activeConversation = $derived(projectStoredChatMessages(messageQuery?.current ?? []));
	const activeMessages = $derived(activeConversation.messages);
	const activeTurns = $derived(activeConversation.turns);
	const runQuery = $derived(
		activeChatId
			? runtime.client.db.agent_run.findMany({
					where: { conversation_id: { eq: activeChatId } },
					orderBy: { position: 'asc' },
					limit: 500
				})
			: undefined
	);
	const mailboxQuery = $derived(
		activeChatId
			? runtime.client.db.agent_mailbox.findMany({
					where: { conversation_id: { eq: activeChatId } },
					limit: 1
				})
			: undefined
	);
	const agentRuns = $derived(runQuery?.current ?? []);
	const mutableRuns = $derived(
		agentRuns.filter((run) => ['queued', 'paused', 'resuming'].includes(run.status))
	);
	const runningRun = $derived(agentRuns.find((run) => run.status === 'running') ?? null);
	const mailboxPaused = $derived(mailboxQuery?.current?.[0]?.status === 'paused');
	const activeSessionIsEnvoy = $derived(activeSession?.visibility.startsWith('envoy_') ?? false);
	const activeSessionIsOtherUsersPersonal = $derived(
		isAdmin &&
			activeSession?.visibility === 'personal' &&
			currentUserId !== null &&
			resolvedScopeUserId !== currentUserId
	);
	const activeSessionIsReadOnly = $derived(
		activeSessionIsEnvoy || activeSessionIsOtherUsersPersonal
	);
	const stored = $derived(toPanelMessages(activeMessages, activeTurns));
	const messages = $derived(withPendingEcho(stored, session.echo));
	const rootTurn = $derived([...activeTurns].filter((turn) => turn.parent_agent_id == null).at(-1));
	/** Admission is the only brief composer lock. The durable lane may accept more work while running. */
	const composerLocked = $derived(session.pending);
	const agentWorking = $derived(
		runningRun !== null || mutableRuns.length > 0 || rootTurn?.status === 'running'
	);
	const terminalMessage = $derived(messages.at(-1));
	const replicaFailure = $derived.by(() => {
		const root = rootTurn;
		if (root?.status === 'failed') {
			return typeof root.error === 'string' && root.error.trim()
				? root.error
				: t('bolt.agent.couldNotFinish');
		}
		const terminal = terminalMessage;
		if (terminal?.kind === 'text' && terminal.role === 'system') {
			return terminal.content.trim() || t('bolt.agent.couldNotFinish');
		}
		return null;
	});
	const failure = $derived(session.sendFailure ?? replicaFailure);
	const activityState = $derived(
		agentOrbState({
			pending: agentWorking,
			failed: failure != null,
			messages: activeMessages,
			turns: activeTurns
		})
	);
	const canSend = $derived(
		(draft.trim().length > 0 || documents.length > 0) &&
			!session.pending &&
			!uploadingDocument &&
			!activeSessionIsReadOnly
	);
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
	const usage = $derived(toPanelUsage(activeMessages, contextLength));
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
	const totals = $derived(toSessionTotals(activeSession));
	const tokenLabel = $derived(
		totals && totals.totalTokens > 0
			? t('bolt.agent.tokens', { count: totals.totalTokens.toLocaleString() })
			: null
	);
	const costLabel = $derived(formatSessionCost(totals));
	const costHint = $derived(
		totals && totals.turnsUnreported > 0
			? t('bolt.agent.turnsUnreportedCost', {
					unreported: totals.turnsUnreported,
					counted: totals.turnsCounted
				})
			: t('bolt.agent.costReportedByProvider')
	);

	// A tool call is the agent doing something. Once one is on screen it carries its own progress, and
	// a second "Working…" placeholder beside it says less than the call already does.
	//
	// Scoped to the turn in flight, not the whole thread. Scanning every message meant the first
	// reply in a conversation permanently satisfied this, so every later question sat with no
	// indicator at all between asking and answering — the panel looked frozen.
	const agentHasSpoken = $derived.by(() => {
		const lastAsk = messages.findLastIndex(
			(message) => message.kind === 'text' && message.role === 'user'
		);
		return messages.slice(lastAsk + 1).some(
			(message) =>
				message.kind === 'tool' ||
				message.kind === 'checkpoint' ||
				message.kind === 'reasoning' ||
				message.kind === 'goal' ||
				message.kind === 'verifier' ||
				// A message it sent is the agent doing something; one it received is not.
				(message.kind === 'agent-message' && message.direction === 'out') ||
				(message.kind === 'text' && message.role === 'assistant')
		);
	});

	// A command response can be lost after the atomic admission committed. The sync replica is the
	// authority for that unknown outcome: when its conversation and exact run arrive, adopt them and
	// publish the shared FAB from the same durable projection. Until then the restored draft is plainly
	// unsent and no durable run exists from which queue controls could render.
	$effect(() => {
		const admission = replicatedAdmission;
		if (admission !== null) {
			session.runId = admission.conversationId;
			session.chatId = admission.conversationId;
			session.composingNew = false;
			session.pending = false;
			session.echo = admission.message;
			session.sendFailure = null;
			if (draft === admission.draft) {
				draft = '';
				mention.lastDraft = '';
			}
			documents = withoutAdmittedDocuments(documents, admission);
			unsettledAdmission = null;
		}
		agentClient.writeSurface({
			chatId: admission?.conversationId ?? activeChatId,
			composingNew: admission === null && session.composingNew,
			pending: agentWorking,
			failed: admission === null && failure != null
		});
	});

	function queueLabel(turnId: string): string {
		const row = messageQuery?.current?.find(
			(message) => message.turn_id === turnId && message.role === 'user'
		);
		const input = parseStoredChatInput(row?.content);
		if (input?.kind === 'user_message') return input.text || t('bolt.agent.queuedMessage');
		if (input?.kind === 'inbound_batch') {
			return input.messages.at(-1)?.text || t('bolt.agent.queuedMessage');
		}
		const relayed = parseAgentMessage(row?.content);
		return relayed?.text || t('bolt.agent.queuedMessage');
	}

	function performQueueAction(key: string, request: Effect.Effect<unknown, unknown>): void {
		if (queueActionPending !== null) return;
		queueActionPending = key;
		session.sendFailure = null;
		void Effect.runPromise(request)
			.catch((cause) => {
				session.sendFailure = cause instanceof Error ? cause.message : String(cause);
			})
			.finally(() => {
				queueActionPending = null;
			});
	}

	function moveQueuedTask(taskId: string, offset: -1 | 1): void {
		if (!activeChatId) return;
		const taskIds = mutableRuns.map((run) => run.task_id);
		const index = taskIds.indexOf(taskId);
		const target = index + offset;
		if (index < 0 || target < 0 || target >= taskIds.length) return;
		[taskIds[index], taskIds[target]] = [taskIds[target]!, taskIds[index]!];
		performQueueAction(
			`reorder:${taskId}`,
			runtime.client.system.agents.reorder({ conversationId: activeChatId, taskIds })
		);
	}

	function dequeueTask(taskId: string): void {
		if (!activeChatId) return;
		performQueueAction(
			`dequeue:${taskId}`,
			runtime.client.system.agents.dequeue({ conversationId: activeChatId, taskId })
		);
	}

	function controlAgent(action: 'interrupt' | 'stop' | 'resume'): void {
		if (!activeChatId) return;
		performQueueAction(
			action,
			runtime.client.system.agents[action]({ conversationId: activeChatId })
		);
	}

	/**
	 * The catalog and selected model are shared by every route/sheet panel. Cmd+K (and the FAB) ask
	 * for composer focus through a window event: the panel may live in the sheet portal or on the
	 * full-page /agent surface, and the shell must not know which.
	 */
	onMount(() => {
		refreshMentionSources();

		/** Seeds and focuses the composer when the shell broadcasts a focus request. */
		function onFocusRequest(event: Event): void {
			const seed =
				event instanceof CustomEvent
					? Option.getOrUndefined(decodeComposerSeed(event.detail))
					: undefined;
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
	function send(): Effect.Effect<void> {
		let admission: UnsettledAgentAdmission | null = null;
		return Effect.suspend(() => {
			const originalDraft = draft;
			const { message, references } = serializeMentions(draft, mention.mentions);
			if (
				(message.length === 0 && documents.length === 0) ||
				composerLocked ||
				uploadingDocument ||
				activeSessionIsReadOnly
			)
				return Effect.void;
			const createdConversation = activeRunId === undefined;
			const conversationId = activeRunId ?? globalThis.crypto.randomUUID();
			const sentDocuments = [...documents];
			const retried = retryableAdmission(unsettledAdmission, {
				conversationId,
				message,
				documents: sentDocuments
			});
			admission = {
				conversationId,
				turnId: retried?.turnId ?? globalThis.crypto.randomUUID(),
				message,
				draft: originalDraft,
				createdConversation,
				documentKeys: sentDocuments.map(({ storage_key }) => storage_key)
			};
			const { verify, verifierPrompt: resolvedVerifierPrompt } = previewIntent;
			if (!activeChatId) {
				session.composingNew = true;
				session.runId = conversationId;
			}
			session.pending = true;
			session.sendFailure = null;
			// The transcript starts only after a commit receipt or the same rows arrive through sync.
			session.echo = null;
			draft = '';
			mention.lastDraft = '';
			mention.mentions = [];
			mention.trigger = null;
			mention.suppressedTriggerStart = null;
			mention.highlightIdentity = '';
			mention.menuItems = [];
			mention.menuLoading = false;
			mentionSearch.invalidate();
			const started = agentClient.start({
				message,
				turnId: admission.turnId,
				runId: conversationId,
				documents: sentDocuments,
				// Only chips the picker created. An `@` that never matched is already in the text.
				...(references.length > 0 ? { mentions: references } : {}),
				intent: planMode ? 'plan' : 'do',
				...(planMode ? { planMode: true } : {}),
				...(verify ? { verifierPrompt: resolvedVerifierPrompt } : {}),
				// Only when the host offered a choice. Sending back its own default would turn a display
				// value into a caller assertion, and the host would stop being free to change it.
				...(modelState.catalog &&
				modelState.selectedModel &&
				modelState.selectedModel !== modelState.catalog.defaultModel
					? { model: modelState.selectedModel }
					: {})
			});
			return Effect.map(started, (result) => {
				session.runId = result.runId;
				session.chatId = result.chatId;
				session.composingNew = false;
				// Interactive start returns before inference; the replicated root turn owns in-flight after this.
				session.pending = false;
				session.echo = admission?.message ?? null;
				if (admission !== null) documents = withoutAdmittedDocuments(documents, admission);
				unsettledAdmission = null;
			});
		}).pipe(
			Effect.catch((cause) => {
				const reason = cause instanceof Error ? cause.message : String(cause);
				session.sendFailure =
					!reason || reason === 'INTERNAL_ERROR' || reason === t('bolt.server.internalError')
						? t('bolt.agent.couldNotStart')
						: reason;
				session.pending = false;
				session.composingNew = admission?.createdConversation ?? false;
				session.echo = null;
				if (admission?.createdConversation) {
					session.chatId = undefined;
					session.runId = admission.conversationId;
				}
				if (admission !== null) {
					draft = admission.draft;
					mention.lastDraft = admission.draft;
				}
				unsettledAdmission = admission;
				return Effect.void;
			})
		);
	}

	/** Opens a chat before writing bytes, then stores a document through the session-bound route. */
	function uploadDocument(file: File): Effect.Effect<void> {
		return Effect.gen(function* () {
			if (composerLocked || uploadingDocument || activeSessionIsReadOnly) return;
			uploadingDocument = true;
			let conversationId = activeRunId;
			if (conversationId === undefined) {
				conversationId = globalThis.crypto.randomUUID();
				yield* runtime.client.system.agents.open({
					agent: runtime.agentName,
					conversationId
				});
				session.runId = conversationId;
				session.chatId = conversationId;
				session.composingNew = false;
			}
			const storageKey = chatDocumentStorageKey(
				conversationId,
				globalThis.crypto.randomUUID(),
				file.name
			);
			const stored = yield* Effect.tryPromise({
				try: () => workspaceSession().chatDocuments.store(conversationId, storageKey, file),
				catch: (cause) => cause
			});
			documents = [...documents, stored];
		}).pipe(
			Effect.catch((cause) => {
				session.sendFailure = cause instanceof Error ? cause.message : String(cause);
				return Effect.void;
			}),
			Effect.ensuring(
				Effect.sync(() => {
					uploadingDocument = false;
					if (documentInput) documentInput.value = '';
				})
			)
		);
	}

	function removeDocument(document: ChatDocumentRef): void {
		const conversationId = activeRunId;
		if (conversationId === undefined) return;
		void workspaceSession()
			.chatDocuments.remove(conversationId, document.storage_key)
			.then(() => {
				documents = documents.filter((candidate) => candidate.storage_key !== document.storage_key);
			})
			.catch((cause) => {
				session.sendFailure = cause instanceof Error ? cause.message : String(cause);
			});
	}

	function abandonDraftDocuments(): void {
		const conversationId = activeRunId;
		const abandoned = [...documents];
		documents = [];
		if (conversationId === undefined) return;
		for (const document of abandoned) {
			void workspaceSession().chatDocuments.remove(conversationId, document.storage_key);
		}
	}

	/** Switches the panel to an existing replicated session. */
	function selectConversation(value: string | null): void {
		if (!value) return;
		const row = sessions.find((candidate) => candidate.conversation_id === value);
		if (!row) return;
		if (row.conversation_id !== activeRunId) abandonDraftDocuments();
		session.chatId = row.conversation_id;
		session.runId = row.conversation_id;
		session.composingNew = false;
		session.echo = null;
		session.sendFailure = null;
		unsettledAdmission = null;
		selectedEnvoy = sessionEnvoyId(row, selectorLabels);
	}

	/** Filters the conversation list to one member and drops a thread outside that scope. */
	function selectScope(userId: string): void {
		scopeUserId = userId;
		if (session.chatId && sessions.some((row) => row.conversation_id === session.chatId)) {
			const current = sessions.find((row) => row.conversation_id === session.chatId);
			if (
				current &&
				!sessionVisibleInScope(current, {
					scopeUserId: userId,
					currentUserId,
					isAdmin,
					publicEnvoyKeys
				})
			) {
				abandonDraftDocuments();
				session.chatId = undefined;
				session.runId = undefined;
				session.composingNew = false;
				selectedEnvoy = null;
			}
		}
	}

	/** Switches the header tab and clears a thread outside that envoy. */
	function selectEnvoy(envoyId: string): void {
		selectedEnvoy = envoyId;
		if (session.chatId) {
			const current = sessions.find((row) => row.conversation_id === session.chatId);
			if (current && sessionEnvoyId(current, selectorLabels) !== envoyId) {
				abandonDraftDocuments();
				session.chatId = undefined;
				session.runId = undefined;
				session.composingNew = false;
				session.echo = null;
				session.sendFailure = null;
			}
		}
	}

	/** Clears the active thread so the next send creates a new conversation. */
	function startConversation(): void {
		abandonDraftDocuments();
		scopeUserId = currentUserId;
		selectedEnvoy = WEB_AGENT_ID;
		session.chatId = undefined;
		session.runId = undefined;
		session.composingNew = true;
		session.echo = null;
		session.sendFailure = null;
		unsettledAdmission = null;
	}

	/** Routes keyboard input between the mention menu and the send action. */
	function onKeydown(event: KeyboardEvent): void {
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
			Effect.runFork(send());
		}
	}
</script>

<Stack
	as="section"
	gap="none"
	fill
	class="bg-background"
	aria-label={t('bolt.shell.workspaceAgentTitle')}
>
	<!--
		`justify="between"` spread three controls of unequal width across the whole header, so the
		person picker sat at the far left, the thread picker floated somewhere in the middle, and the
		space between them changed with whatever the labels happened to say. The row packs from the
		left instead: person at a fixed width, thread taking whatever remains, new-conversation last.
		The left inset also matched the title's text rather than the panel, which indented the whole
		row under the orb for no reason.
	-->
	<Inline
		as="header"
		justify="start"
		gap="sm"
		shrink={false}
		class={`border-b bg-card ${headerOrb ? 'px-3 py-2.5 sm:px-4' : 'pt-1 pr-3 pb-3 pl-4 sm:pr-5 sm:pl-5'}`}
	>
		{#if headerOrb}
			<div
				class="grid size-4 shrink-0 place-items-center text-foreground"
				data-testid="agent-activity-orb"
			>
				<NorbitalThinkingOrb
					state={activityState}
					size={16}
					label={activityState === 'ready'
						? t('bolt.shell.workspaceAgentTitle')
						: t(agentOrbStatusKey(activityState))}
				/>
			</div>
		{/if}
		{#if showScopePicker && resolvedScopeUserId}
			<ConversationScopePicker
				value={resolvedScopeUserId}
				options={scopeOptions}
				searchPlaceholder={t('bolt.agent.searchMembers')}
				ariaLabel={t('bolt.agent.conversationScope')}
				onValueChange={selectScope}
				icon="lucide:user-round"
				class="w-44"
			/>
		{/if}
		{#if showEnvoyPicker}
			<ConversationScopePicker
				value={resolvedEnvoy}
				options={envoyOptions}
				searchPlaceholder={t('bolt.agent.searchEnvoys')}
				ariaLabel={t('bolt.agent.conversationEnvoy')}
				onValueChange={selectEnvoy}
				icon="lucide:hash"
				class="w-36"
			/>
		{/if}
		<!-- The thread name is the variable-length one, so it gets the leftover width rather than a
			cap: capped at 16rem it truncated while empty header sat beside it. -->
		<div class="min-w-0 flex-1">
			<ConversationSelector
				model={conversationSelector}
				value={activeChatId}
				placeholder={t('bolt.agent.noConversations')}
				searchPlaceholder={t('bolt.agent.searchConversations')}
				ariaLabel={t('bolt.agent.conversationThread')}
				emptyLabel={t('bolt.agent.noConversations')}
				onValueChange={(id) => selectConversation(id)}
				icon="lucide:message-square"
			/>
		</div>
		<Button
			variant="ghost"
			size="icon"
			class="shrink-0"
			hint={t('bolt.agent.newConversation')}
			aria-label={t('bolt.agent.newConversation')}
			onclick={startConversation}
		>
			<Icon icon="lucide:square-pen" class="size-4" />
		</Button>
	</Inline>
	{#if messages.length === 0 && !composerLocked}
		<Bound size="full" grow>
			<Scroll name={t('bolt.agent.askAboutWorkspace')} axis="y" class="px-6 py-10">
				<Center measure="narrow" layout="stack" gap="md" align="center" class="text-center">
					<Inline justify="center" align="center" class="size-12 rounded-xl bg-card shadow-xs">
						<IconWrapper name="product:bolt" class="size-7 text-foreground" />
					</Inline>
					<h2 class="text-base font-semibold tracking-[-0.015em] text-foreground">
						{t('bolt.agent.askAboutWorkspace')}
					</h2>
					<p class="text-sm leading-6 text-muted-foreground">
						{t('bolt.agent.askDescription')}
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
						onVerifierPrompt={(prompt) => {
							const id = activeRunId;
							if (!id) return;
							void Effect.runPromise(agentClient.updateVerifier({ runId: id, prompt }));
						}}
					/>
				{/each}
				{#if agentWorking && !agentHasSpoken}
					<Stack as="li" gap="sm" aria-label={t('bolt.agent.agentIsWorking')}>
						<span class="px-1 text-tiny font-medium text-muted-foreground"
							>{t('bolt.agent.agent')}</span
						>
						<Inline class="w-fit rounded-xl bg-muted px-3.5 py-2.5 text-sm">
							<Spinner
								class="size-4 text-foreground"
								label={t(agentOrbBusyStatusKey(activityState))}
							/>
							<span class="text-muted-foreground">{t(agentOrbBusyStatusKey(activityState))}</span>
						</Inline>
					</Stack>
				{/if}
			</Scroll>
		</Bound>
	{/if}

	<!-- Queue chrome earns its row only when something is actually waiting: a lone in-flight turn
	     shows nothing here (its interrupt control lives on the composer instead). -->
	{#if activeChatId && (mutableRuns.length > 0 || mailboxPaused)}
		<Stack
			as="section"
			gap="sm"
			class="border-t bg-card/55 px-3 py-2.5 sm:px-4"
			aria-label={t('bolt.agent.queue')}
		>
			<Inline justify="between" align="center" gap="sm">
				<Inline align="center" gap="xs" class="min-w-0 text-xs text-muted-foreground">
					<Icon
						icon={mailboxPaused
							? 'lucide:pause'
							: runningRun
								? 'lucide:loader-circle'
								: 'lucide:list-ordered'}
						class={`size-3.5 shrink-0 ${runningRun ? 'animate-spin' : ''}`}
					/>
					<span class="font-medium text-foreground">
						{mailboxPaused
							? t('bolt.agent.queuePaused')
							: runningRun
								? t('bolt.agent.queueRunning')
								: t('bolt.agent.queue')}
					</span>
					{#if mutableRuns.length > 0}
						<span>{t('bolt.agent.queuedCount', { count: mutableRuns.length })}</span>
					{/if}
				</Inline>
				<Inline justify="end" align="center" gap="xs">
					{#if mailboxPaused}
						<Button
							variant="ghost"
							size="sm"
							disabled={queueActionPending !== null}
							onclick={() => controlAgent('resume')}
						>
							<Icon icon="lucide:play" class="size-3.5" />
							{t('bolt.agent.resume')}
						</Button>
					{:else}
						{#if runningRun}
							<Button
								variant="ghost"
								size="sm"
								disabled={queueActionPending !== null}
								onclick={() => controlAgent('interrupt')}
							>
								<Icon icon="lucide:octagon-x" class="size-3.5" />
								{t('bolt.agent.interrupt')}
							</Button>
						{/if}
						<Button
							variant="ghost"
							size="sm"
							disabled={queueActionPending !== null}
							onclick={() => controlAgent('stop')}
						>
							<Icon icon="lucide:pause" class="size-3.5" />
							{t('bolt.agent.pause')}
						</Button>
					{/if}
				</Inline>
			</Inline>

			{#if mutableRuns.length > 0}
				<ol class="divide-y divide-border/60 border-t border-border/60" aria-live="polite">
					{#each mutableRuns as run, index (run.task_id)}
						<Inline as="li" align="center" gap="sm" class="min-w-0 py-1.5 text-xs">
							<span class="w-5 shrink-0 text-center tabular-nums text-muted-foreground"
								>{index + 1}</span
							>
							<span class="min-w-0 flex-1 truncate text-foreground" title={queueLabel(run.turn_id)}>
								{queueLabel(run.turn_id)}
							</span>
							<span class="shrink-0 text-tiny text-muted-foreground">
								{run.status === 'paused' ? t('bolt.agent.paused') : t('bolt.agent.queued')}
							</span>
							<Inline gap="none" class="shrink-0">
								<Button
									variant="ghost"
									size="icon"
									class="size-7"
									disabled={index === 0 || queueActionPending !== null}
									hint={t('bolt.agent.moveEarlier')}
									aria-label={t('bolt.agent.moveEarlier')}
									onclick={() => moveQueuedTask(run.task_id, -1)}
								>
									<Icon icon="lucide:chevron-up" class="size-3.5" />
								</Button>
								<Button
									variant="ghost"
									size="icon"
									class="size-7"
									disabled={index === mutableRuns.length - 1 || queueActionPending !== null}
									hint={t('bolt.agent.moveLater')}
									aria-label={t('bolt.agent.moveLater')}
									onclick={() => moveQueuedTask(run.task_id, 1)}
								>
									<Icon icon="lucide:chevron-down" class="size-3.5" />
								</Button>
								<Button
									variant="ghost"
									size="icon"
									class="size-7 text-muted-foreground hover:text-destructive"
									disabled={queueActionPending !== null}
									hint={t('bolt.agent.removeQueued')}
									aria-label={t('bolt.agent.removeQueued')}
									onclick={() => dequeueTask(run.task_id)}
								>
									<Icon icon="lucide:x" class="size-3.5" />
								</Button>
							</Inline>
						</Inline>
					{/each}
				</ol>
			{/if}
		</Stack>
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
					{activeSessionIsEnvoy
						? t('bolt.agent.envoyReadOnly')
						: t('bolt.agent.adminConversationReadOnly')}
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
						void Effect.runPromise(send());
					}}
				>
					<div class="px-3 pt-3 pb-1 sm:px-4 sm:pt-4" data-agent-composer>
						<Stack gap="sm">
							{#if documents.length > 0}
								<Inline gap="xs" class="flex-wrap">
									{#each documents as document (document.storage_key)}
										<Inline
											as="span"
											gap="xs"
											class="max-w-full rounded-md bg-muted px-2 py-1 text-tiny text-foreground"
										>
											<Icon icon="lucide:paperclip" class="size-3 shrink-0" />
											<span class="truncate">{document.file_name}</span>
											<button
												type="button"
												class="rounded-sm text-muted-foreground hover:text-foreground"
												aria-label={`${t('common.remove')} ${document.file_name}`}
												onclick={() => removeDocument(document)}
											>
												<Icon icon="lucide:x" class="size-3" />
											</button>
										</Inline>
									{/each}
								</Inline>
							{/if}
							<div>
								<label class="sr-only" for="agent-chat-input">{t('bolt.agent.messageAgent')}</label>
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
									placeholder={t('bolt.agent.composerPlaceholder')}
									rows={1}
									class={AGENT_COMPOSER_EDITOR_CLASS}
									disabled={composerLocked}
								/>
							</div>
						</Stack>
					</div>

					{#if previewIntent.verify}
						<details class="group/verifier px-2.5 sm:px-3" data-testid="agent-verifier">
							<summary
								class={`flex min-w-0 cursor-pointer list-none items-center gap-2 rounded-md px-1.5 py-1 text-muted-foreground transition-colors duration-150 hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-ring ${AGENT_COMPOSER_CONTROL_TEXT_CLASS}`}
							>
								<Icon icon="lucide:shield-check" class="size-3.5 shrink-0" />
								<span class="shrink-0">{t('bolt.agent.verifierWillCheck')}</span>
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
									{t('bolt.agent.verifierPromptHint')}
								</p>
								<label class="sr-only" for="agent-verifier-prompt"
									>{t('bolt.agent.verifierPrompt')}</label
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

					<Grid
						tracks="minmax(0,1fr) auto"
						gap="xs"
						class="items-end px-2.5 pt-1 pb-[max(0.625rem,env(safe-area-inset-bottom))]"
					>
						<!-- Usage figures are the provider's own; anything it did not report is absent. -->
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
								title={planMode ? t('bolt.agent.planModeOn') : t('bolt.agent.planModeOff')}
								data-testid="agent-plan-mode"
							>
								{t('bolt.agent.plan')}
							</button>
							{#if contextPercent !== null}
								<Inline as="span" gap="xs" title={t('bolt.agent.contextWindowUsed')}>
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
							<input
								type="file"
								class="sr-only"
								bind:this={documentInput}
								onchange={(event) => {
									const file = event.currentTarget.files?.[0];
									if (file) void Effect.runPromise(uploadDocument(file));
								}}
							/>
							<Button
								type="button"
								variant="ghost"
								size="icon"
								class="size-8 shrink-0"
								disabled={composerLocked || uploadingDocument}
								aria-label={t('common.upload')}
								onclick={() => documentInput?.click()}
							>
								{#if uploadingDocument}
									<Spinner class="size-4" label={t('common.upload')} />
								{:else}
									<Icon icon="lucide:paperclip" class="size-4" />
								{/if}
							</Button>
							<div class="min-w-0" title={t('bolt.agent.modelAndVariant')}>
								<AgentModelPicker
									bind:value={modelState.selectedModel}
									options={modelState.catalog?.options ?? []}
									status={modelState.status}
									compact={true}
									disabled={composerLocked || modelState.status !== 'ready'}
								/>
							</div>
							{#if runningRun && mutableRuns.length === 0 && !mailboxPaused}
								<Button
									variant="ghost"
									size="icon"
									class="size-8 shrink-0 rounded-full"
									disabled={queueActionPending !== null}
									hint={t('bolt.agent.interrupt')}
									aria-label={t('bolt.agent.interrupt')}
									onclick={() => controlAgent('interrupt')}
								>
									<Icon icon="lucide:octagon-x" class="size-4" />
								</Button>
							{/if}
							<Button
								type="submit"
								disabled={!canSend}
								size="icon"
								class="size-8 shrink-0 rounded-full"
								data-testid="agent-send"
								aria-label={composerLocked ? t('common.loading') : t('bolt.agent.send')}
							>
								{#if composerLocked}
									<Spinner class="size-4" label={t('common.loading')} />
								{:else}
									<Icon icon="lucide:arrow-up" class="size-4" />
								{/if}
							</Button>
						</Inline>
					</Grid>
				</form>
			</div>
		{/if}
	</Stack>
</Stack>
