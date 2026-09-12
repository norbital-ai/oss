<script lang="ts">
	import { Effect, Option, Schema } from 'effect';
	import { AgentId, FileAsset } from '@norbital-ai/bolt-protocol/facilities';
	import Icon from '@iconify/svelte';
	import { onDestroy, onMount, tick } from 'svelte';
	import { watch } from 'runed';
	import { Button } from '@norbital-ai/ui/button';
	import { Badge } from '@norbital-ai/ui/badge';
	import { Combobox } from '@norbital-ai/ui/combobox';
	import { getErrorMessage } from '@norbital-ai/std';
	import { Inline, Scroll, Stack } from '@norbital-ai/ui/layout';
	import { Spinner } from '@norbital-ai/ui/spinner';
	import { Textarea } from '@norbital-ai/ui/textarea';
	import { NorbiusStrip } from '@norbital-ai/ui/norbius-strip';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import { workspaceSession } from '#lib/client/session.js';
	import {
		encodeUserMessageWithAttachments,
		conversationAssetStorageKey
	} from '#lib/runtime/agents/image-descriptors.js';
	import { useAgentClient } from './client.svelte.js';
	import { runComposerCommand } from './composer-send.js';
	import TaskSelector from './conversation-selector.svelte';
	import AgentTranscriptItem from './agent-transcript-item.svelte';
	import AgentContextSegment from './agent-context-segment.svelte';
	import AgentMentionMenu from './agent-mention-menu.svelte';
	import { buildTaskSelector, projectConversations } from './conversation-selector.js';
	import {
		commandMenuItems,
		findCommandTrigger,
		selectComposerCommand,
		type ComposerCommand
	} from './composer-commands.js';
	import { pairToolCalls, type SubagentTranscript } from './tool-rows.js';
	import {
		compactOrigin,
		editableUserMessageText,
		projectAgentContextView
	} from './context-view.js';
	import {
		aggregateTaskCharges,
		formatTaskCharge,
		conversationTodos,
		modelChangeDividers,
		projectConversationMessages,
		projectPlans,
		projectTurns,
		turnWaitingSeconds,
		projectAgentUsage,
	} from './transcript.js';
	import { agentOrbBusyStatusKey, agentOrbState, agentOrbStatusKey } from './agent-orb-state.js';
	import { createTailFollower, transcriptTailSignature } from './transcript-follow.js';
	import { AGENT_COMPOSER_FOCUS_EVENT } from './composer-chrome.js';
	import { isAgentModeShortcut, parseTaskSlashCommand } from './intent.js';
	import {
		retryableAdmission,
		visibleUnsettledAdmission,
		type UnsettledTaskAdmission
	} from './admission-reconciliation.js';

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
	let planMode = $state(false);
	let selectedModelId = $state<string | undefined>(undefined);
	const modelQuery = $derived(
		runtime.client.system.conversations.models({ agentId: AgentId.make(runtime.agentId) })
	);
	let selectedConversationId = $state<string | undefined>(undefined);
	let composingNew = $state(false);
	let pending = $state(false);
	let sendFailure = $state<string | null>(null);
	let controlPending = $state(false);
	let unsettledAdmission = $state<UnsettledTaskAdmission | null>(null);
	let composer = $state<HTMLTextAreaElement | null>(null);
	let filePicker = $state<HTMLInputElement | null>(null);
	let revisedMessage = $state<{ readonly id: string; readonly sequence: number } | null>(null);
	/** The transcript scrollport and the B11 follower that keeps a reader at its tail. */
	let transcriptPort = $state<HTMLElement | null>(null);
	const tail = createTailFollower(() => transcriptPort);
	let pendingAttachments = $state<
		Array<{ id: string; file: File; mimeType: string; previewUrl: string | null }>
	>([]);

	const taskQuery = $derived(
		runtime.client.db.conversation.findMany({ orderBy: { updated_at: 'desc' }, limit: 500 })
	);
	const allTasks = $derived(projectConversations(taskQuery.current ?? []));
	const rootTasks = $derived(
		allTasks.filter((task) => task.parent_id === null && task.agent_id === runtime.agentId)
	);
	const defaultTask = $derived(rootTasks[0]);
	const activeConversationId = $derived(composingNew ? undefined : (selectedConversationId ?? defaultTask?.id));
	const activeTask = $derived(allTasks.find((task) => task.id === activeConversationId));

	function treeConversationIds(
		tasks: readonly { readonly id: string; readonly parent_id: string | null }[],
		rootId: string | undefined
	): string[] {
		if (rootId === undefined) return [];
		const ids = new Set<string>([rootId]);
		let changed = true;
		while (changed) {
			changed = false;
			for (const task of tasks) {
				if (task.parent_id === null || !ids.has(task.parent_id) || ids.has(task.id)) continue;
				ids.add(task.id);
				changed = true;
			}
		}
		return [...ids];
	}

	const activeConversationIds = $derived(treeConversationIds(allTasks, activeConversationId));

	const messagesQuery = $derived(
		activeConversationIds.length === 0
			? undefined
			: runtime.client.db.conversation_message.findMany({
					where: { conversation_id: { in: activeConversationIds } },
					orderBy: { sequence: 'asc' },
					limit: 2_000
				})
	);
	const panelMessages = $derived(projectConversationMessages(messagesQuery?.current ?? []));
	const rootMessages = $derived(panelMessages.filter((message) => message.conversationId === activeConversationId));
	const tools = $derived(pairToolCalls(panelMessages));

	const plansQuery = $derived(
		activeConversationIds.length === 0
			? undefined
			: runtime.client.db.plan.findMany({
					where: { conversation_id: { in: activeConversationIds } },
					orderBy: { revision: 'desc' },
					limit: 500
				})
	);
	const plans = $derived(projectPlans(plansQuery?.current ?? []));
	const activePlan = $derived(
		activeTask === undefined || activeTask.active_plan_id === null
			? undefined
			: plans.find((plan) => plan.id === activeTask.active_plan_id)
	);

	const runsQuery = $derived(
		activeConversationIds.length === 0
			? undefined
			: runtime.client.db.turn.findMany({
					where: { conversation_id: { in: activeConversationIds } },
					orderBy: { created_at: 'desc' },
					limit: 1_000
				})
	);
	const runs = $derived(projectTurns(runsQuery?.current ?? []));
	const modeByTurnId: Map<string, 'agent' | 'plan' | 'compact'> = $derived(
		new Map(runs.map((run) => [run.id, run.mode] as const))
	);
	const rootRuns = $derived(runs.filter((run) => run.conversation_id === activeConversationId));
	/** Read off stored run rows, so the seam between models is still there after a reload. */
	const modelDividers = $derived(modelChangeDividers(rootRuns, rootMessages));
	const subagentTranscript: SubagentTranscript = $derived({
		tasks: allTasks,
		messages: panelMessages,
		runs,
		plans
	});
	const modelId = $derived(
		selectedModelId ?? rootRuns[0]?.model_id ?? modelQuery.current?.defaultLanguageModelId
	);
	const modelOptions = $derived(
		(modelQuery.current?.languageModels ?? []).map(({ id }) => ({
			value: id,
			label: id.replace(/^openrouter\//, '')
		}))
	);
	const modelAvailable = $derived(
		modelId !== undefined && modelOptions.some(({ value }) => value === modelId)
	);
	const activeRun = $derived(
		activeTask === undefined || activeTask.active_turn_id === null
			? undefined
			: rootRuns.find((run) => run.id === activeTask.active_turn_id)
	);
	const contextView = $derived(
		projectAgentContextView({
			messages: rootMessages,
			runs: rootRuns,
			...(activePlan === undefined ? {} : { activePlan })
		})
	);
	const contextProjectionIncomplete = $derived(
		(messagesQuery?.current?.length ?? 0) >= 2_000 ||
			(plansQuery?.current?.length ?? 0) >= 500 ||
			(runsQuery?.current?.length ?? 0) >= 1_000
	);
	const runIds = $derived(rootRuns.map((run) => run.id));
	const usageQuery = $derived(
		runIds.length === 0
			? undefined
			: runtime.client.db.turn_usage.findMany({
					where: { turn_id: { in: runIds } },
					orderBy: { created_at: 'asc' },
					limit: 2_000
				})
	);
	const taskCharges = $derived(
		aggregateTaskCharges(projectAgentUsage(usageQuery?.current ?? []), new Set(runIds))
	);
	const costLabel = $derived(taskCharges.map(formatTaskCharge).join(' · '));
	const todo = $derived(conversationTodos(activeTask ?? null));

	const taskSelector = $derived(
		buildTaskSelector({
			tasks: rootTasks,
			labels: { personal: 'Personal', workbench: 'Workbench' }
		})
	);

	const orbState = $derived(
		agentOrbState({
			pending,
			failed: sendFailure !== null,
			...(activeTask === undefined ? {} : { status: activeTask.status })
		})
	);
	const taskWorking = $derived(activeTask?.status === 'running');
	/** A second hand for the window between `running` and the first part; it only ticks while working. */
	let now = $state(Date.now());
	$effect(() => {
		if (!taskWorking) return;
		now = Date.now();
		const timer = setInterval(() => (now = Date.now()), 1_000);
		return () => clearInterval(timer);
	});
	const waitingSeconds = $derived(
		taskWorking ? turnWaitingSeconds(activeRun, rootMessages, now) : null
	);
	const canStop = $derived(taskWorking && !controlPending);
	const canResume = $derived(
		!controlPending &&
			(activeTask?.status === 'stopped' ||
				activeTask?.status === 'attention' ||
				activeTask?.status === 'failed')
	);
	const taskAcceptsSubmission = $derived(
		activeTask === undefined ||
			activeTask.status === 'ready' ||
			activeTask.status === 'running' ||
			activeTask.status === 'done' ||
			activeTask.status === 'failed' ||
			activeTask.status === 'stopped' ||
			activeTask.status === 'attention'
	);
	const parsedDraft = $derived(parseTaskSlashCommand(draft));
	function draftSendable(parsed: ReturnType<typeof parseTaskSlashCommand>): boolean {
		if (pendingAttachments.length > 0) return true;
		switch (parsed.kind) {
			case 'message':
				return parsed.message.trim().length > 0;
			case 'submission':
				return parsed.complete;
			default: {
				const _exhaustive: never = parsed;
				return _exhaustive;
			}
		}
	}
	function planState(): string {
		if (activePlan === undefined) return '';
		if (activeRun?.phase === 'verify' && activeRun.status === 'running') return 'Verifying';
		switch (activePlan.status) {
			case 'active':
				return 'Active';
			case 'stalled':
				return 'Stalled';
			case 'verified':
				return 'Verified';
			case 'superseded':
				return 'Superseded';
			default: {
				const _exhaustive: never = activePlan.status;
				return _exhaustive;
			}
		}
	}

	function reviseMessage(message: (typeof rootMessages)[number]): void {
		const text = editableUserMessageText(message);
		if (text === null) return;
		draft = text;
		planMode = false;
		revisedMessage = { id: message.id, sequence: message.sequence };
		sendFailure = null;
		queueMicrotask(() => {
			composer?.focus();
			composer?.setSelectionRange(composer.value.length, composer.value.length);
		});
	}

	function cancelRevision(): void {
		revisedMessage = null;
		draft = '';
		queueMicrotask(() => composer?.focus());
	}

	function beginNewTask(): void {
		selectedConversationId = undefined;
		composingNew = true;
		tail.pin();
		unsettledAdmission = null;
		sendFailure = null;
		revisedMessage = null;
		queueMicrotask(() => composer?.focus());
	}

	function selectTask(conversationId: string): void {
		selectedConversationId = conversationId;
		selectedModelId = undefined;
		composingNew = false;
		tail.pin();
		unsettledAdmission = null;
		sendFailure = null;
		revisedMessage = null;
	}

	function addFiles(files: readonly File[]): void {
		const additions: typeof pendingAttachments = [];
		for (const file of files) {
			const extension = file.name.split('.').at(-1)?.toLowerCase();
			const mimeType =
				/^(image\/[\w.+-]+|text\/[\w.+-]+|application\/(pdf|json|(?:[\w.-]+\+)?xml))$/.test(
					file.type
				)
					? file.type
					: extension === 'pdf'
						? 'application/pdf'
						: ['txt', 'md', 'csv', 'tsv', 'json', 'xml', 'log', 'yaml', 'yml'].includes(
									extension ?? ''
							  )
							? 'text/plain'
							: null;
			if (mimeType === null || file.size === 0) {
				sendFailure = `${file.name}: attach a nonempty image, PDF or text document.`;
				return;
			}
			additions.push({ id: globalThis.crypto.randomUUID(), file, mimeType, previewUrl: null });
		}
		const combined = [...pendingAttachments, ...additions];
		if (
			combined.length > 8 ||
			combined.reduce((sum, item) => sum + item.file.size, 0) > 20 * 1024 * 1024
		) {
			sendFailure = 'Attach at most 8 files totaling 20 MiB.';
			return;
		}
		sendFailure = null;
		pendingAttachments = [
			...pendingAttachments,
			...additions.map((item) => ({
				...item,
				previewUrl: item.mimeType.startsWith('image/') ? URL.createObjectURL(item.file) : null
			}))
		];
	}

	function removePendingAttachment(id: string): void {
		const next: Array<{ id: string; file: File; mimeType: string; previewUrl: string | null }> = [];
		for (const image of pendingAttachments) {
			if (image.id === id) {
				if (image.previewUrl !== null) URL.revokeObjectURL(image.previewUrl);
				continue;
			}
			next.push(image);
		}
		pendingAttachments = next;
	}

	function clearPendingAttachments(): void {
		for (const image of pendingAttachments)
			if (image.previewUrl !== null) URL.revokeObjectURL(image.previewUrl);
		pendingAttachments = [];
	}

	function storePendingAttachments(conversationId: string) {
		const images = pendingAttachments;
		return Effect.tryPromise({
			try: () => {
				if (images.length === 0) return Promise.resolve([]);
				const session = workspaceSession();
				return Effect.runPromise(
					Effect.forEach(
						images,
						(image) => {
							const key = conversationAssetStorageKey(conversationId, image.id, image.file.name);
							return Effect.tryPromise(() => session.files.store(key, image.file)).pipe(
								Effect.map(() =>
									FileAsset.make({
										key,
										name: image.file.name,
										mimeType: image.mimeType,
										size: image.file.size
									})
								)
							);
						},
						{ concurrency: 1 }
					)
				);
			},
			catch: (cause) =>
				new Error(cause instanceof Error ? cause.message : 'The attachment could not be stored.', {
					cause
				})
		});
	}

	function onComposerPaste(event: ClipboardEvent): void {
		const files = [...(event.clipboardData?.files ?? [])];
		if (files.length === 0) return;
		event.preventDefault();
		addFiles(files);
	}

	function onFilePicked(event: Event): void {
		const input = event.currentTarget;
		if (!(input instanceof HTMLInputElement) || input.files === null) return;
		addFiles([...input.files]);
		input.value = '';
	}

	function editRevision() {
		return Effect.suspend(() => {
			const parsed = parseTaskSlashCommand(draft);
			const message = parsed.message.trim();
			const revision = revisedMessage;
			const revisionModelId = modelId;
			if (
				(message.length === 0 && pendingAttachments.length === 0) ||
				revision === null ||
				activeConversationId === undefined ||
				revisionModelId === undefined
			) {
				return Effect.void;
			}
			pending = true;
			sendFailure = null;
			return runComposerCommand(
				storePendingAttachments(activeConversationId).pipe(
					Effect.flatMap((assets) =>
						encodeUserMessageWithAttachments(message, assets).pipe(
							Effect.flatMap((encoded) =>
								agentClient.editMessage({
									conversationId: activeConversationId,
									messageId: revision.id,
									message: encoded,
									modelId: revisionModelId
								})
							)
						)
					)
				),
				{
					onSuccess: () => {
						draft = '';
						revisedMessage = null;
						clearPendingAttachments();
					},
					onFailure: (failure) => {
						sendFailure = failure;
					},
					onSettled: () => {
						pending = false;
					}
				}
			);
		});
	}

	function submit(priority: 'normal' | 'steer' = 'normal') {
		return Effect.suspend(() => {
			if (composer !== null && composer.value !== draft) draft = composer.value;
			const parsed = parseTaskSlashCommand(draft);
			const message = parsed.message.trim();
			const submittedModelId = modelId;
			if (
				(message.length === 0 && pendingAttachments.length === 0) ||
				submittedModelId === undefined
			)
				return Effect.void;
			const mode = activeCommand ?? (planMode ? 'plan' : 'agent');
			const retry = retryableAdmission(visibleAdmission, {
				agentId: runtime.agentId,
				message,
				mode,
				priority,
				modelId: submittedModelId
			});
			const conversationId =
				retry?.conversationId ??
				(composingNew ? undefined : activeTask?.id) ??
				globalThis.crypto.randomUUID();
			const admission = {
				conversationId,
				submissionId: retry?.submissionId ?? globalThis.crypto.randomUUID(),
				agentId: runtime.agentId,
				message,
				mode,
				priority,
				modelId: submittedModelId,
				draft
			} satisfies UnsettledTaskAdmission;
			unsettledAdmission = admission;
			pending = true;
			sendFailure = null;
			tail.pin();
			return runComposerCommand(
				storePendingAttachments(conversationId).pipe(
					Effect.flatMap((assets) =>
						encodeUserMessageWithAttachments(message, assets).pipe(
							Effect.flatMap((encoded) =>
								agentClient.submit({
									conversationId,
									submissionId: admission.submissionId,
									message: encoded,
									mode,
									priority,
									modelId: submittedModelId
								})
							)
						)
					)
				),
				{
					onSuccess: (result) => {
						selectedConversationId = result.conversationId;
						composingNew = false;
						draft = '';
						commandMode = null;
						revisedMessage = null;
						clearPendingAttachments();
					},
					onFailure: (failure) => {
						sendFailure = failure;
					},
					onSettled: () => {
						pending = false;
					}
				}
			);
		});
	}

	function control(action: 'stop' | 'resume'): void {
		if (activeConversationId === undefined || controlPending) return;
		controlPending = true;
		sendFailure = null;
		Effect.runFork(
			agentClient.control(activeConversationId, action, modelId).pipe(
				Effect.tapError((error) =>
					Effect.sync(() => {
						sendFailure = error.message;
					})
				),
				Effect.ensuring(Effect.sync(() => (controlPending = false))),
				Effect.asVoid
			)
		);
	}

	function attemptSend(priority: 'normal' | 'steer' = 'normal'): void {
		if (composer !== null && composer.value !== draft) draft = composer.value;
		const parsed = parseTaskSlashCommand(draft);
		if (
			composerLocked ||
			!modelAvailable ||
			!draftSendable(parsed)
		)
			return;
		if (revisedMessage !== null) {
			Effect.runFork(editRevision());
			return;
		}
		Effect.runFork(submit(priority));
	}

	/**
	 * The `/` command menu: open only for a `/` at the start of the draft, closed by Escape until the
	 * query changes, and driven from the textarea so keyboard ownership never leaves it.
	 */
	let caret = $state(0);
	let commandHighlight = $state(0);
	let commandMenuDismissed = $state(false);
	let commandMode = $state<ComposerCommand | null>(null);
	/** The command a send would carry: the selected badge, or one typed into the draft. */
	const activeCommand = $derived(
		commandMode ?? (parsedDraft.kind === 'submission' ? parsedDraft.mode : null)
	);
	const commandTrigger = $derived(findCommandTrigger(draft, caret));
	const commandItems = $derived(
		commandTrigger === null ? [] : commandMenuItems(commandTrigger.query)
	);
	const commandMenuOpen = $derived(!commandMenuDismissed && commandItems.length > 0);
	watch(
		() => commandTrigger?.query,
		() => {
			commandMenuDismissed = false;
			commandHighlight = 0;
		}
	);

	function syncCaret(): void {
		if (composer !== null) caret = composer.selectionStart ?? composer.value.length;
	}

	function selectCommand(index: number): void {
		const item = commandItems[index];
		const trigger = commandTrigger;
		if (item === undefined || item.kind !== 'composer-command' || trigger === null) return;
		const next = selectComposerCommand(draft, trigger, item.command);
		commandMode = next.mode;
		draft = next.message;
		caret = next.caret;
		commandMenuDismissed = true;
		queueMicrotask(() => {
			composer?.focus();
			composer?.setSelectionRange(next.caret, next.caret);
		});
	}

	function clearCommandMode(): void {
		commandMode = null;
		queueMicrotask(() => composer?.focus());
	}

	function onCommandMenuKeydown(event: KeyboardEvent): boolean {
		if (event.isComposing || commandItems.length === 0) return false;
		switch (event.key) {
			case 'ArrowDown':
				event.preventDefault();
				commandHighlight = (commandHighlight + 1) % commandItems.length;
				return true;
			case 'ArrowUp':
				event.preventDefault();
				commandHighlight = (commandHighlight - 1 + commandItems.length) % commandItems.length;
				return true;
			case 'Enter':
			case 'Tab':
				if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return false;
				event.preventDefault();
				selectCommand(commandHighlight);
				return true;
			case 'Escape':
				event.preventDefault();
				commandMenuDismissed = true;
				return true;
			default:
				return false;
		}
	}

	function onComposerKeydown(event: KeyboardEvent): void {
		if (commandMenuOpen && onCommandMenuKeydown(event)) return;
		if (isAgentModeShortcut(event)) {
			event.preventDefault();
			planMode = !planMode;
			return;
		}
		if (
			event.key === 'Enter' &&
			!event.shiftKey &&
			!event.altKey &&
			!event.ctrlKey &&
			!event.metaKey &&
			!event.isComposing
		) {
			event.preventDefault();
			attemptSend('normal');
		}
	}

	onDestroy(() => {
		clearPendingAttachments();
	});

	onMount(() => {
		function onFocusRequest(event: Event): void {
			const seed =
				event instanceof CustomEvent
					? Option.getOrUndefined(decodeComposerSeed(event.detail))
					: undefined;
			if (seed?.planMode === true) planMode = true;
			if (seed?.message !== undefined) draft = seed.message;
			composer?.focus();
			composer?.setSelectionRange(composer.value.length, composer.value.length);
		}
		window.addEventListener(AGENT_COMPOSER_FOCUS_EVENT, onFocusRequest);
		return () => window.removeEventListener(AGENT_COMPOSER_FOCUS_EVENT, onFocusRequest);
	});

	const surface = $derived({
		conversationId: activeConversationId,
		composingNew,
		pending,
		failed: sendFailure !== null
	});
	watch(
		() => surface,
		(next) => {
			agentClient.writeSurface(next);
		}
	);

	const tasksWithHumanMessage = $derived(
		new Set(
			panelMessages
				.filter((message) => message.author.kind === 'human')
				.map((message) => message.conversationId)
		)
	);
	const admissionConversationId = $derived(unsettledAdmission?.conversationId);
	const visibleAdmission = $derived(
		visibleUnsettledAdmission(
			unsettledAdmission,
			tasksWithHumanMessage,
			admissionConversationId === undefined || allTasks.some((task) => task.id === admissionConversationId),
			new Set(panelMessages.map((message) => message.id))
		)
	);
	/**
	 * The composer is closed only until the operator's own message is durable, not for the whole
	 * turn. `conversations.send` blocks until the turn settles, so `pending` spans the entire run;
	 * gating on it would stop a person from queueing a follow-up. A send while a turn runs is
	 * admitted `queued` and answered at the running turn's next boundary.
	 */
	const admissionPending = $derived(visibleAdmission !== null && sendFailure === null);
	const composerLocked = $derived(admissionPending || controlPending || !taskAcceptsSubmission);
	const canSend = $derived(!composerLocked && modelAvailable && draftSendable(parsedDraft));

	/**
	 * B11: the transcript follows its tail. The scrollport is the `Scroll` below; the reader's
	 * position is observed on its scroll event, and every change to the tail (a new row, a part
	 * arriving on the streaming row, the reader's own pending send) scrolls to the end when the
	 * reader was already there. Content that settles late, such as a code editor mounting inside a
	 * tool row, is caught by a resize observer on the transcript body.
	 */
	const transcriptSignature = $derived(
		transcriptTailSignature(contextView.focusMessages, visibleAdmission !== null)
	);
	$effect(() => {
		void transcriptSignature;
		void tick().then(() => tail.follow());
	});
	$effect(() => {
		const body = transcriptPort?.firstElementChild;
		if (!(body instanceof HTMLElement)) return;
		const observer = new ResizeObserver(() => tail.follow());
		observer.observe(body);
		return () => observer.disconnect();
	});
</script>

<Stack gap="none" fill class="min-h-0 bg-card">
	{#if headerOrb}
		<Inline align="center" gap="sm" class="shrink-0 border-b border-border px-4 py-3">
			<NorbiusStrip
				state={orbState}
				size={18}
				label={t(agentOrbStatusKey(orbState))}
			/>
			<span class="text-sm font-semibold">Norbius</span>
		</Inline>
	{/if}

	<Inline align="center" gap="sm" class="shrink-0 border-b border-border px-3 py-2">
		<div class="min-w-0 flex-1">
			<TaskSelector
				model={taskSelector}
				value={activeConversationId}
				placeholder="No conversations yet"
				searchPlaceholder="Search conversations…"
				ariaLabel="Select conversation"
				emptyLabel="Conversation is not available"
				onValueChange={selectTask}
				icon="lucide:messages-square"
			/>
		</div>
		{#if costLabel !== ''}<span class="shrink-0 text-tiny text-muted-foreground">{costLabel}</span
			>{/if}
		<Button
			variant="ghost"
			size="icon"
			class="size-8"
			aria-label="New conversation"
			onclick={beginNewTask}
		>
			<Icon icon="lucide:plus" class="size-4" />
		</Button>
	</Inline>

	<Scroll
		class="min-h-0 flex-1"
		name="Conversation transcript"
		bind:ref={transcriptPort}
		onscroll={tail.observe}
	>
		<Stack gap="md" class="mx-auto w-full max-w-3xl px-4 py-4">
			{#if activeTask === undefined && visibleAdmission === null}
				<div class="grid min-h-56 place-items-center text-center text-sm text-muted-foreground">
					<p class="max-w-sm">
						Start a conversation. Ask for help or switch to Plan to work through an approach.
					</p>
				</div>
			{:else if activeTask === undefined && visibleAdmission !== null}
				<ol class="m-0 list-none p-0" aria-label="Messages in the agent model view">
					<li class="my-1.5 min-w-0" data-role="user" data-admission="pending">
						<Stack gap="xs" align="end">
							<span class="text-tiny font-medium text-muted-foreground">You</span>
							<div
								class="max-w-[88%] rounded-[1.15rem] bg-muted px-3.5 py-2.5 text-sm leading-6 text-foreground"
							>
								<p class="m-0 break-words whitespace-pre-wrap">{visibleAdmission.message}</p>
							</div>
						</Stack>
					</li>
				</ol>
			{:else}
				<Stack gap="md">
					{#if contextProjectionIncomplete}
						<div
							class="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs"
							role="status"
						>
							The loaded query reached its safety limit. Older durable rows may not be visible; the
							active model-view boundary cannot be certified until older rows are paged.
						</div>
					{/if}
					<AgentContextSegment
						plan={activePlan}
						runs={rootRuns}
						messages={rootMessages}
						status={planState()}
						{tools}
						subagent={subagentTranscript}
					/>

					{#if todo !== null && todo.items.length > 0}
						{@const completed = todo.items.filter((item) => item.status === 'done').length}
						<details class="rounded-xl border border-border/70 bg-muted/20 px-3 py-2">
							<summary
								class="cursor-pointer list-none rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
							>
								<Stack gap="sm">
									<Inline justify="between" gap="md" class="text-xs">
										<span class="font-medium"
											>{completed === todo.items.length ? 'Goal complete' : 'Goal progress'}</span
										>
										<span class="shrink-0 text-muted-foreground"
											>{completed} / {todo.items.length} complete</span
										>
									</Inline>
									<progress
										class="h-1 w-full accent-primary"
										max={todo.items.length}
										value={completed}
										aria-label="Goal progress"
									></progress>
									<p class="m-0 text-sm">
										{todo.items.find((item) => item.status === 'doing')?.text ??
											todo.items.find((item) => item.status === 'pending')?.text ??
											'All steps completed'}
									</p>
								</Stack>
							</summary>
							<Scroll name="Goal steps" class="max-h-64">
								<Stack as="ol" gap="xs" class="pl-0" aria-label="Goal steps">
									{#each todo.items as item (item.id)}
										<li class="min-w-0 text-xs">
											<Inline align="start" gap="sm">
												{#if item.status === 'done'}
													<Icon
														icon="lucide:circle-check"
														class="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
													/>
												{:else if item.status === 'doing'}
													<Spinner class="mt-0.5 size-3.5 shrink-0" label="In progress" />
												{:else}
													<Icon
														icon="lucide:circle"
														class="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
													/>
												{/if}
												<span
													class="min-w-0 {item.status === 'done'
														? 'text-muted-foreground line-through'
														: ''}">{item.text}</span
												>
											</Inline>
										</li>
									{/each}
								</Stack>
							</Scroll>
						</details>
					{/if}

					<ol class="m-0 list-none p-0" aria-label="Conversation transcript">
						{#each contextView.focusMessages as message (message.key)}
							{@const changedModel = modelDividers.get(message.id)}
							{#if changedModel !== undefined}
								<li
									class="my-3 min-w-0"
									role="separator"
									data-divider="model"
									aria-label={t('bolt.agent.modelChanged', { model: changedModel })}
								>
									<Inline align="center" gap="sm" class="text-micro text-muted-foreground">
										<span class="h-px flex-1 bg-border"></span>
										<Icon icon="lucide:cpu" class="size-3 shrink-0" />
										<span class="shrink-0">{t('bolt.agent.modelChanged', { model: changedModel })}</span>
										<span class="h-px flex-1 bg-border"></span>
									</Inline>
								</li>
							{/if}
							<AgentTranscriptItem
								hideTodo
								{message}
								{tools}
								subagent={subagentTranscript}
								generating={runs.some(
									(run) => run.id === message.runId && run.status === 'running'
								)}
								mode={message.runId === null ? null : (modeByTurnId.get(message.runId) ?? null)}
								outsideModelView={contextView.outsideMessageIds.has(message.id)}
								checkpointOrigin={message.annotation?.tag === 'compact'
									? compactOrigin(message)
									: null}
								onedit={!taskAcceptsSubmission || editableUserMessageText(message) === null
									? undefined
									: reviseMessage}
							/>
						{/each}
						{#if waitingSeconds !== null}
							<li class="my-1.5 min-w-0" role="status" data-turn-waiting>
								<span class="text-xs text-muted-foreground"
									>{t('bolt.agent.thinkingFor', { seconds: waitingSeconds })}</span
								>
							</li>
						{/if}
						{#if visibleAdmission !== null}
							<li class="my-1.5 min-w-0" data-role="user" data-admission="pending">
								<Stack gap="xs" align="end">
									<span class="text-tiny font-medium text-muted-foreground">You</span>
									<div
										class="max-w-[88%] rounded-[1.15rem] bg-muted px-3.5 py-2.5 text-sm leading-6 text-foreground"
									>
										<p class="m-0 break-words whitespace-pre-wrap">{visibleAdmission.message}</p>
									</div>
								</Stack>
							</li>
						{/if}
					</ol>
				</Stack>
			{/if}
		</Stack>
	</Scroll>

	<Stack
		gap="sm"
		class="shrink-0 border-t border-border bg-card px-3 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
	>
		{#if revisedMessage !== null}
			<Inline
				align="center"
				gap="sm"
				class="rounded-lg border border-primary/20 bg-primary/5 px-2.5 py-2"
			>
				<Icon icon="lucide:message-square-pen" class="size-3.5 shrink-0 text-primary" />
				<p class="m-0 min-w-0 flex-1 text-tiny text-muted-foreground">
					Revising message {revisedMessage.sequence + 1}. The original remains in the durable
					transcript; this appends a revision that supersedes it.
				</p>
				<button
					type="button"
					class="rounded px-1.5 py-1 text-tiny font-medium hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					onclick={cancelRevision}
				>
					Cancel
				</button>
			</Inline>
		{/if}
		{#if activeTask?.status === 'failed'}
			<p class="text-xs text-muted-foreground">
				The last turn failed. Retry it or send a follow-up here.
			</p>
		{:else if canResume}
			<p class="text-xs text-muted-foreground">
				Resume the previous turn or send a follow-up here.
			</p>
		{/if}
		{#if modelQuery.error !== undefined}
			<p class="text-xs text-destructive" role="alert">{getErrorMessage(modelQuery.error)}</p>
		{:else if modelQuery.current !== undefined && !modelAvailable}
			<p class="text-xs text-destructive" role="alert">{t('bolt.agent.modelUnavailable')}</p>
		{/if}
		{#if sendFailure !== null}
			<p class="text-xs text-destructive" role="alert">{sendFailure}</p>
		{/if}
		{#if planMode || activeCommand !== null}
			<p class="text-tiny text-muted-foreground">
				{activeCommand === 'compact'
					? 'Summarize this conversation and keep its transcript available.'
					: 'Revise the full plan before putting it into action.'}
			</p>
		{/if}
		<Stack
			as="form"
			gap="none"
			class="relative rounded-[1.25rem] border-0 bg-transparent text-popover-foreground shadow-none"
			onsubmit={(event) => {
				event.preventDefault();
				attemptSend('normal');
			}}
		>
			{#if commandMenuOpen && commandTrigger !== null}
				<AgentMentionMenu
					items={commandItems}
					highlightIndex={commandHighlight}
					loading={false}
					query={commandTrigger.query}
					scope={null}
					onselect={selectCommand}
					onhighlight={(index) => (commandHighlight = index)}
					onclearscope={() => (commandMenuDismissed = true)}
				/>
			{/if}
			{#if commandMode !== null}
				<Inline align="center" gap="xs" class="px-2.5 pt-2">
					<Badge variant="outline" class="gap-1.5 pr-1 pl-2 font-mono">
						<Icon
							icon={commandMode === 'plan' ? 'lucide:list-todo' : 'lucide:scan-text'}
							class="size-3 shrink-0"
						/>
						<span>/{commandMode}</span>
						<button
							type="button"
							class="rounded-full opacity-70 transition-opacity hover:opacity-100"
							aria-label={`Remove /${commandMode}`}
							onclick={clearCommandMode}
						>
							<Icon icon="lucide:x" class="size-3" />
						</button>
					</Badge>
				</Inline>
			{/if}
			<label class="sr-only" for="agent-task-composer">Message</label>
			<Textarea
				id="agent-task-composer"
				bind:ref={composer}
				bind:value={draft}
				onkeydown={onComposerKeydown}
				oninput={syncCaret}
				onkeyup={syncCaret}
				onclick={syncCaret}
				aria-controls={commandMenuOpen ? 'agent-mention-menu' : undefined}
				aria-expanded={commandMenuOpen}
				onpaste={onComposerPaste}
				rows={2}
				placeholder="Ask anything, or type /plan or /compact"
				class="max-h-40 min-h-14 resize-none border-0 bg-transparent px-4 py-3 text-sm leading-relaxed shadow-none outline-none focus:border-0 focus:outline-none focus:ring-0 focus-visible:border-0 focus-visible:outline-none focus-visible:ring-0 dark:bg-transparent dark:shadow-none"
				disabled={composerLocked}
			/>
			{#if pendingAttachments.length > 0}
				<Inline gap="xs" class="px-2.5">
					{#each pendingAttachments as image (image.id)}
						<button
							type="button"
							class="relative flex h-10 max-w-48 items-center gap-2 rounded-md border border-border/70 px-2 text-xs"
							style="overflow: hidden"
							aria-label={`Remove ${image.file.name}`}
							onclick={() => removePendingAttachment(image.id)}
						>
							{#if image.previewUrl !== null}
								<img src={image.previewUrl} alt="" class="size-8 rounded object-cover" />
							{:else}
								<Icon icon="lucide:file-text" class="size-4 shrink-0" />
							{/if}
							<span class="truncate">{image.file.name}</span>
							<Icon icon="lucide:x" class="size-3 shrink-0" />
						</button>
					{/each}
				</Inline>
			{/if}
			<Inline align="center" gap="xs" class="px-2.5 pb-2">
				<input
					bind:this={filePicker}
					type="file"
					accept="image/*,text/*,application/pdf,application/json,application/xml,.md,.csv,.tsv,.log,.yaml,.yml"
					multiple
					class="sr-only"
					onchange={onFilePicked}
				/>
				<button
					type="button"
					aria-label="Attach media or files"
					disabled={composerLocked}
					onclick={() => filePicker?.click()}
					class="grid size-9 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
				>
					<Icon icon="lucide:plus" class="size-5" />
				</button>
				<span class="flex-1"></span>
				<Combobox
					options={modelOptions}
					value={modelId ?? null}
					ariaLabel={t('bolt.agent.model')}
					searchPlaceholder={t('bolt.agent.searchModels')}
					emptyPlaceholder={modelQuery.loading
						? t('bolt.agent.loadingModels')
						: t('bolt.agent.selectModel')}
					searchable
					allowClear={false}
					disabled={composerLocked || modelQuery.loading}
					onValueChange={(value) => {
						if (typeof value === 'string') selectedModelId = value;
					}}
					class="w-auto min-w-0 max-w-[45%]"
					triggerClass="h-7 border-0 bg-transparent px-1.5 text-xs font-normal shadow-none hover:bg-muted"
				/>
				<button
					type="button"
					aria-pressed={planMode}
					aria-keyshortcuts="Tab"
					title="Switch between Agent and Plan (Tab)"
					disabled={composerLocked}
					onclick={() => (planMode = !planMode)}
					class="rounded-md px-1.5 py-0.5 text-xs font-normal {planMode
						? 'bg-primary/10 text-primary'
						: 'text-muted-foreground hover:bg-muted'}"
				>
					{planMode ? 'Plan' : 'Agent'}
				</button>
				{#if taskWorking}
					<Button
						type="button"
						variant="ghost"
						size="icon"
						class="size-8 rounded-full"
						disabled={!canSend}
						aria-label="Steer current turn"
						title="Send at the next agent step"
						onclick={() => attemptSend('steer')}
					>
						<Icon icon="lucide:milestone" class="size-4" />
					</Button>
					<Button
						type="button"
						variant="ghost"
						size="icon"
						class="size-8 rounded-full"
						disabled={!canStop}
						aria-label="Stop generating"
						onclick={() => control('stop')}
					>
						<Icon icon="lucide:square" class="size-4" />
					</Button>
				{:else if canResume}
					<Button
						type="button"
						variant="ghost"
						size="icon"
						class="size-8 rounded-full"
						disabled={controlPending || !modelAvailable}
						aria-label="Resume conversation"
						onclick={() => control('resume')}
					>
						<Icon icon="lucide:play" class="size-4" />
					</Button>
				{/if}
				<Button
					type="submit"
					size="icon"
					class="size-8 rounded-full"
					disabled={!canSend}
					aria-label={revisedMessage !== null ? 'Send revised message' : 'Send message'}
				>
					{#if admissionPending}
						<Spinner class="size-4" label={t(agentOrbBusyStatusKey(orbState))} />
					{:else}
						<Icon icon="lucide:arrow-up" class="size-4" />
					{/if}
				</Button>
			</Inline>
		</Stack>
	</Stack>
</Stack>
