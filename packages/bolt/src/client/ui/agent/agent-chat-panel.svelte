<script lang="ts">
	import { Effect, Option, Schema } from 'effect';
	import type { Prompt } from 'effect/unstable/ai';
	import Icon from '@iconify/svelte';
	import { onMount } from 'svelte';
	import { Button } from '@norbital-ai/ui/button';
	import { Inline, Scroll, Stack } from '@norbital-ai/ui/layout';
	import { Spinner } from '@norbital-ai/ui/spinner';
	import { ThinkingOrb as NorbitalThinkingOrb } from '@norbital-ai/ui/thinking-orb';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import { useAgentClient } from './client.svelte.js';
	import TaskSelector from './conversation-selector.svelte';
	import AgentTranscriptItem from './agent-transcript-item.svelte';
	import {
		buildTaskSelector,
		projectAgentTasks,
		type AgentTask
	} from './conversation-selector.js';
	import {
		compactOrigin,
		editableUserMessageText,
		plainMessageText,
		projectAgentContextView,
		type CompactOrigin
	} from './context-view.js';
	import {
		aggregateTaskCharges,
		formatTaskCharge,
		latestTodo,
		projectAgentMessages,
		projectAgentPlans,
		projectAgentRuns,
		projectAgentUsage,
		type AgentPlanRow,
		type TodoResult
	} from './transcript.js';
	import {
		agentOrbBusyStatusKey,
		agentOrbState,
		agentOrbStatusKey
	} from './agent-orb-state.js';
	import {
		AGENT_COMPOSER_CONTROL_TEXT_CLASS,
		AGENT_COMPOSER_EDITOR_CLASS,
		AGENT_COMPOSER_FOCUS_EVENT,
		AGENT_COMPOSER_SHELL_CLASS
	} from './composer-chrome.js';
	import { isAgentModeShortcut, parseTaskSlashCommand } from './intent.js';
	import {
		retryableAdmission,
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
	let selectedTaskId = $state<string | undefined>(undefined);
	let composingNew = $state(false);
	let pending = $state(false);
	let sendFailure = $state<string | null>(null);
	let controlPending = $state(false);
	let unsettledAdmission = $state<UnsettledTaskAdmission | null>(null);
	let composer = $state<HTMLTextAreaElement | null>(null);
	let transcriptTab = $state<'focus' | 'history'>('focus');
	let revisedMessage = $state<{ readonly id: string; readonly sequence: number } | null>(null);

	const taskQuery = $derived(
		runtime.client.db.agent_task.findMany({ orderBy: { updated_at: 'desc' }, limit: 500 })
	);
	const allTasks = $derived(projectAgentTasks(taskQuery.current ?? []));
	const rootTasks = $derived(
		allTasks.filter(
			(task) => task.parent_id === null && task.agent_id === runtime.agentId
		)
	);
	const defaultTask = $derived(rootTasks[0]);
	const activeTaskId = $derived(
		composingNew ? undefined : (selectedTaskId ?? defaultTask?.id)
	);
	const activeTask = $derived(allTasks.find((task) => task.id === activeTaskId));

	function treeTaskIds(
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

	const activeTaskIds = $derived(treeTaskIds(allTasks, activeTaskId));

	const messagesQuery = $derived(
		activeTaskIds.length === 0
			? undefined
			: runtime.client.db.agent_message.findMany({
					where: { task_id: { in: activeTaskIds } },
					orderBy: { sequence: 'asc' },
					limit: 2_000
				})
	);
	const panelMessages = $derived(projectAgentMessages(messagesQuery?.current ?? []));
	const rootMessages = $derived(
		panelMessages.filter((message) => message.taskId === activeTaskId)
	);

	const plansQuery = $derived(
		activeTaskIds.length === 0
			? undefined
			: runtime.client.db.agent_plan.findMany({
					where: { task_id: { in: activeTaskIds } },
					orderBy: { revision: 'desc' },
					limit: 500
				})
	);
	const plans = $derived(projectAgentPlans(plansQuery?.current ?? []));
	const activePlan = $derived(
		activeTask === undefined || activeTask.active_plan_id === null
			? undefined
			: plans.find((plan) => plan.id === activeTask.active_plan_id)
	);

	const runsQuery = $derived(
		activeTaskIds.length === 0
			? undefined
			: runtime.client.db.agent_run.findMany({
					where: { task_id: { in: activeTaskIds } },
					orderBy: { created_at: 'desc' },
					limit: 1_000
				})
	);
	const runs = $derived(projectAgentRuns(runsQuery?.current ?? []));
	const rootRuns = $derived(runs.filter((run) => run.task_id === activeTaskId));
	const activeRun = $derived(
		activeTask === undefined || activeTask.active_run_id === null
			? undefined
			: rootRuns.find((run) => run.id === activeTask.active_run_id)
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
			: runtime.client.db.agent_usage.findMany({
					where: { run_id: { in: runIds } },
					orderBy: { created_at: 'asc' },
					limit: 2_000
				})
	);
	const taskCharges = $derived(
		aggregateTaskCharges(projectAgentUsage(usageQuery?.current ?? []), new Set(runIds))
	);
	const costLabel = $derived(taskCharges.map(formatTaskCharge).join(' · '));
	const todo = $derived(latestTodo(rootMessages, activeRun?.id ?? null));

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
	const taskWorking = $derived(
		activeTask?.status === 'running' || activeTask?.status === 'waiting'
	);
	const canStop = $derived(taskWorking && !controlPending);
	const canResume = $derived(
		!controlPending &&
			(activeTask?.status === 'stopped' ||
				activeTask?.status === 'failed' ||
				activeTask?.status === 'attention')
	);
	const taskAcceptsSubmission = $derived(
		activeTask === undefined ||
		activeTask.status === 'ready' ||
		activeTask.status === 'running' ||
		activeTask.status === 'waiting'
	);
	const parsedDraft = $derived(parseTaskSlashCommand(draft));
	function draftSendable(parsed: ReturnType<typeof parseTaskSlashCommand>): boolean {
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
	const canSend = $derived(
		!pending &&
			!controlPending &&
			taskAcceptsSubmission &&
			draftSendable(parsedDraft)
	);

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
		}
	}

	function elapsedSince(value: unknown): string {
		const instant =
			value instanceof Date
				? value.getTime()
				: typeof value === 'string' || typeof value === 'number'
					? new Date(value).getTime()
					: Number.NaN;
		if (!Number.isFinite(instant)) return 'Invalid timestamp';
		const seconds = Math.max(0, Math.floor((Date.now() - instant) / 1_000));
		if (seconds < 60) return `${seconds}s`;
		const minutes = Math.floor(seconds / 60);
		if (minutes < 60) return `${minutes}m`;
		return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
	}

	function todoPosition(current: TodoResult): number {
		const doing = current.items.findIndex((item) => item.status === 'doing');
		if (doing >= 0) return doing + 1;
		return Math.min(
			current.items.filter((item) => item.status === 'done').length + 1,
			current.items.length
		);
	}

	function directChildren(taskId: string): AgentTask[] {
		return allTasks.filter((task) => task.parent_id === taskId);
	}

	function taskPlan(task: AgentTask): AgentPlanRow | undefined {
		return task.active_plan_id === null
			? undefined
			: plans.find((plan) => plan.id === task.active_plan_id);
	}

	function compactTitle(origin: CompactOrigin | null): string {
		switch (origin) {
			case 'automatic':
				return 'Automatic compact summary';
			case 'manual':
				return 'Manual compact summary';
			case 'unresolved':
				return 'Compact summary · origin unavailable';
			case null:
				return 'Compact summary';
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
		selectedTaskId = undefined;
		composingNew = true;
		unsettledAdmission = null;
		sendFailure = null;
		revisedMessage = null;
		transcriptTab = 'focus';
		queueMicrotask(() => composer?.focus());
	}

	function selectTask(taskId: string): void {
		selectedTaskId = taskId;
		composingNew = false;
		unsettledAdmission = null;
		sendFailure = null;
		revisedMessage = null;
		transcriptTab = 'focus';
	}

	function canonicalUserMessage(message: string): Prompt.UserMessageEncoded {
		return { role: 'user', content: message };
	}

	function editRevision() {
		return Effect.suspend(() => {
			const parsed = parseTaskSlashCommand(draft);
			const message = parsed.message.trim();
			if (message.length === 0 || revisedMessage === null || activeTaskId === undefined) {
				return Effect.void;
			}
			pending = true;
			sendFailure = null;
			return agentClient
				.editMessage({
					taskId: activeTaskId,
					messageId: revisedMessage.id,
					message: canonicalUserMessage(message)
				})
				.pipe(
					Effect.tap(() =>
						Effect.sync(() => {
							draft = '';
							revisedMessage = null;
						})
					),
					Effect.tapError((error) =>
						Effect.sync(() => {
							sendFailure = error.message;
						})
					),
					Effect.ensuring(Effect.sync(() => (pending = false))),
					Effect.asVoid
				);
		});
	}

	function submit(priority: 'normal' | 'steer' = 'normal') {
		return Effect.suspend(() => {
			const parsed = parseTaskSlashCommand(draft);
			const message = parsed.message.trim();
			if (message.length === 0) return Effect.void;
			const mode = parsed.kind === 'submission' ? parsed.mode : planMode ? 'plan' : 'agent';
			const retry = retryableAdmission(visibleAdmission, {
				agentId: runtime.agentId,
				message,
				mode,
				priority
			});
			const taskId =
				retry?.taskId ??
				(composingNew || activeTask?.status === 'done' ? undefined : activeTask?.id) ??
				globalThis.crypto.randomUUID();
			const admission: UnsettledTaskAdmission = {
				taskId,
				agentId: runtime.agentId,
				message,
				mode,
				priority,
				draft
			};
			unsettledAdmission = admission;
			pending = true;
			sendFailure = null;
			return agentClient
				.submit({ taskId, message: canonicalUserMessage(message), mode, priority })
				.pipe(
					Effect.tap((result) =>
						Effect.sync(() => {
							selectedTaskId = result.taskId;
							composingNew = false;
							unsettledAdmission = null;
							draft = '';
							revisedMessage = null;
						})
					),
					Effect.tapError((error) =>
						Effect.sync(() => {
							sendFailure = error.message;
						})
					),
					Effect.ensuring(Effect.sync(() => (pending = false))),
					Effect.asVoid
				);
		});
	}

	function control(action: 'stop' | 'resume'): void {
		if (activeTaskId === undefined || controlPending) return;
		controlPending = true;
		sendFailure = null;
		Effect.runFork(
			agentClient.control(activeTaskId, action).pipe(
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
		if (!canSend) return;
		if (revisedMessage !== null) {
			Effect.runFork(editRevision());
			return;
		}
		Effect.runFork(submit(priority));
	}

	function onComposerKeydown(event: KeyboardEvent): void {
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

	$effect(() => {
		agentClient.writeSurface({
			taskId: activeTaskId,
			composingNew,
			pending,
			failed: sendFailure !== null
		});
	});

	const visibleAdmission = $derived(
		unsettledAdmission !== null &&
			// `?.` for the checker only: `unsettledAdmission` is `$state`, so its narrowing does not
			// survive into the callback, and the guard above already proved it non-null.
			allTasks.some((task) => task.id === unsettledAdmission?.taskId)
			? null
			: unsettledAdmission
	);
</script>

{#snippet childConversation(task: AgentTask)}
	{@const childMessages = panelMessages.filter((message) => message.taskId === task.id)}
	{@const childRuns = runs.filter((run) => run.task_id === task.id)}
	{@const childPlan = taskPlan(task)}
	{@const childView = projectAgentContextView({
		messages: childMessages,
		runs: childRuns,
		...(childPlan === undefined ? {} : { activePlan: childPlan })
	})}
	<details
		class="rounded-xl border border-border/70 bg-muted/15 px-3 py-2"
		open={task.status === 'running' || task.status === 'waiting'}
	>
		<summary class="cursor-pointer list-none rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
			<Inline align="center" gap="sm">
				<Icon icon="lucide:bot" class="size-4 shrink-0" />
				<div class="min-w-0 flex-1">
					<p class="m-0 truncate text-xs font-medium">{task.agent_id}</p>
					<p class="m-0 text-micro text-muted-foreground">
						{task.status === 'done'
							? 'Required result ready'
							: task.status === 'running' || task.status === 'waiting'
								? 'Required child in progress'
								: `Required child · ${task.status}`}
					</p>
				</div>
				<span class="rounded-full bg-background px-2 py-0.5 text-tiny text-muted-foreground">
					{task.status}
				</span>
			</Inline>
		</summary>

		<Stack gap="sm" class="border-l border-border/60 pl-3">
			{#if childPlan !== undefined}
				<div class="rounded-lg border border-border/60 bg-background/70 px-3 py-2">
					<p class="m-0 text-tiny font-semibold">Plan r{childPlan.revision}</p>
					<p class="mt-1 mb-0 whitespace-pre-wrap text-xs leading-5">{childPlan.body}</p>
				</div>
			{/if}
			{#if childView.checkpoint !== null}
				<div class="rounded-lg border border-primary/20 bg-primary/5 px-3 py-2">
					<p class="m-0 text-tiny font-semibold">{compactTitle(childView.checkpointOrigin)}</p>
					<p class="mt-1 mb-0 line-clamp-5 whitespace-pre-wrap text-xs leading-5 text-muted-foreground">
						{plainMessageText(childView.checkpoint)}
					</p>
				</div>
			{/if}

			<ol class="m-0 list-none p-0" aria-label={`Child Task ${task.agent_id} active conversation`}>
				{#each childView.focusMessages as message (message.key)}
					<AgentTranscriptItem {message} parentAttribution={true} />
				{/each}
			</ol>

			<details class="rounded-lg border border-border/60 px-2.5 py-2">
				<summary class="cursor-pointer text-tiny font-medium text-muted-foreground">
					Full child transcript · {childMessages.length} messages
				</summary>
				<ol class="list-none p-0" aria-label={`Child Task ${task.agent_id} full transcript`}>
					{#each childMessages as message (message.key)}
						<AgentTranscriptItem
							{message}
							parentAttribution={true}
							outsideModelView={childView.outsideMessageIds.has(message.id)}
							checkpointOrigin={message.annotation?.tag === 'compact'
								? compactOrigin(message, childRuns)
								: null}
						/>
					{/each}
				</ol>
			</details>

			{#each directChildren(task.id) as child (child.id)}
				{@render childConversation(child)}
			{/each}
		</Stack>
	</details>
{/snippet}

<Stack gap="none" fill class="min-h-0 bg-card">
	{#if headerOrb}
		<Inline align="center" gap="sm" class="shrink-0 border-b border-border px-4 py-3">
			<NorbitalThinkingOrb
				state={orbState}
				size={18}
				label={t(agentOrbStatusKey(orbState))}
			/>
			<span class="text-sm font-semibold">Agent</span>
		</Inline>
	{/if}

	<Inline align="center" gap="sm" class="shrink-0 border-b border-border px-3 py-2">
		<div class="min-w-0 flex-1">
			<TaskSelector
				model={taskSelector}
				value={activeTaskId}
				placeholder="No Tasks yet"
				searchPlaceholder="Search Tasks…"
				ariaLabel="Select Task"
				emptyLabel="Task is not available"
				onValueChange={selectTask}
				icon="lucide:messages-square"
			/>
		</div>
		<Button variant="ghost" size="icon" class="size-8" aria-label="New Task" onclick={beginNewTask}>
			<Icon icon="lucide:plus" class="size-4" />
		</Button>
	</Inline>

	<Scroll class="min-h-0 flex-1" name="Task transcript">
		<Stack gap="md" class="mx-auto w-full max-w-3xl px-4 py-4">
			{#if activeTask === undefined}
				<div class="grid min-h-56 place-items-center text-center text-sm text-muted-foreground">
					<p class="max-w-sm">Start a Task. Agent and Plan submissions share one durable transcript.</p>
				</div>
			{:else}
				<Inline
					align="center"
					gap="xs"
					class="rounded-lg bg-muted/50 p-1"
					role="tablist"
					aria-label="Conversation view"
				>
					<button
						type="button"
						role="tab"
						aria-selected={transcriptTab === 'focus'}
						aria-controls="agent-focus-view"
						id="agent-focus-tab"
						onclick={() => (transcriptTab = 'focus')}
						class={`min-h-8 flex-1 rounded-md px-3 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
							transcriptTab === 'focus'
								? 'bg-background text-foreground shadow-sm'
								: 'text-muted-foreground hover:text-foreground'
						}`}
					>
						Focus
					</button>
					<button
						type="button"
						role="tab"
						aria-selected={transcriptTab === 'history'}
						aria-controls="agent-history-view"
						id="agent-history-tab"
						onclick={() => (transcriptTab = 'history')}
						class={`min-h-8 flex-1 rounded-md px-3 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
							transcriptTab === 'history'
								? 'bg-background text-foreground shadow-sm'
								: 'text-muted-foreground hover:text-foreground'
						}`}
					>
						Full transcript
						{#if contextView.outsideMessageIds.size > 0}
							<span class="ml-1 text-micro">({contextView.outsideMessageIds.size} outside view)</span>
						{/if}
					</button>
				</Inline>

				{#if transcriptTab === 'focus'}
					<Stack
						gap="md"
						id="agent-focus-view"
						role="tabpanel"
						aria-labelledby="agent-focus-tab"
					>
						{#if contextProjectionIncomplete}
							<div class="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs" role="status">
								The loaded query reached its safety limit. Open Full transcript for the visible history; the active model-view boundary cannot be certified until older rows are paged.
							</div>
						{/if}
						{#if activePlan !== undefined}
							<details class="rounded-xl border border-border/70 bg-muted/20 px-3 py-2" open>
								<summary class="cursor-pointer list-none rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
									<Inline align="center" gap="sm">
										<Icon icon="lucide:notebook-tabs" class="size-4 text-primary" />
										<div class="min-w-0 flex-1">
											<p class="m-0 truncate text-xs font-semibold">Plan r{activePlan.revision}</p>
											<p class="m-0 truncate text-tiny text-muted-foreground">
												{activePlan.body.split('\n').find((line) => line.trim().length > 0) ?? 'Empty Plan'}
											</p>
										</div>
										<span class="rounded-full bg-background px-2 py-0.5 text-tiny">{planState()}</span>
									</Inline>
								</summary>
								<Stack gap="sm" class="border-t border-border/60 pt-2">
									<Inline gap="md" class="text-tiny text-muted-foreground">
										<span>{elapsedSince(activePlan.created_at)}</span>
										{#if costLabel !== ''}<span>{costLabel}</span>{/if}
									</Inline>
									<p class="m-0 whitespace-pre-wrap text-xs leading-5">{activePlan.body}</p>
									<Inline gap="xs" justify="end">
										{#if canStop}
											<Button size="sm" variant="ghost" onclick={() => control('stop')}>Stop</Button>
										{:else if canResume}
											<Button size="sm" variant="ghost" onclick={() => control('resume')}>Resume</Button>
										{/if}
									</Inline>
								</Stack>
							</details>
						{/if}

						{#if contextView.checkpoint !== null}
							<section class="rounded-xl border border-primary/20 bg-primary/5 px-3 py-2" aria-label={compactTitle(contextView.checkpointOrigin)}>
								<Inline align="center" gap="sm">
									<Icon icon="lucide:scan-text" class="size-4 shrink-0 text-primary" />
									<div class="min-w-0 flex-1">
										<p class="m-0 text-xs font-semibold">{compactTitle(contextView.checkpointOrigin)}</p>
										<p class="m-0 text-tiny text-muted-foreground">
											The agent sees this checkpoint and newer in-view messages. Full history remains saved.
										</p>
									</div>
								</Inline>
								<p class="mb-0 whitespace-pre-wrap text-xs leading-5">
									{plainMessageText(contextView.checkpoint)}
								</p>
							</section>
						{/if}

						{#if todo !== null && todo.items.length > 0}
							<details class="rounded-xl border border-border/70 bg-muted/20 px-3 py-2">
								<summary class="cursor-pointer list-none rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
									<Inline align="center" gap="sm">
										<span
											class="grid size-6 place-items-center rounded-full text-micro font-semibold"
											style={`background: conic-gradient(var(--primary) ${(todo.items.filter((item) => item.status === 'done').length / todo.items.length) * 100}%, var(--muted) 0)`}
										>
											<span class="grid size-4 place-items-center rounded-full bg-card">{todoPosition(todo)}</span>
										</span>
										<span class="text-xs font-medium">Step {todoPosition(todo)} / {todo.items.length}</span>
									</Inline>
								</summary>
								<Scroll name="Task progress" class="max-h-64">
								<Stack as="ol" gap="xs" class="pl-0" aria-label="Task progress">
									{#each todo.items as item (item.id)}
										<li class="min-w-0 text-xs">
											<Inline align="start" gap="sm">
											{#if item.status === 'done'}
												<Icon icon="lucide:circle-check" class="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
											{:else if item.status === 'doing'}
												<Spinner class="mt-0.5 size-3.5 shrink-0" label="In progress" />
											{:else}
												<Icon icon="lucide:circle" class="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
											{/if}
											<span class={item.status === 'done' ? 'min-w-0 text-muted-foreground line-through' : 'min-w-0'}>{item.text}</span>
											</Inline>
										</li>
									{/each}
								</Stack>
								</Scroll>
							</details>
						{/if}

						<ol class="m-0 list-none p-0" aria-label="Messages in the agent model view">
							{#each contextView.focusMessages as message (message.key)}
								<AgentTranscriptItem
									{message}
									onedit={!taskAcceptsSubmission || editableUserMessageText(message) === null
										? undefined
										: reviseMessage}
								/>
							{/each}
						</ol>

						{#each directChildren(activeTask.id) as child (child.id)}
							{@render childConversation(child)}
						{/each}
					</Stack>
				{:else}
					<Stack
						gap="md"
						id="agent-history-view"
						role="tabpanel"
						aria-labelledby="agent-history-tab"
					>
						{#if contextProjectionIncomplete}
							<div class="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs" role="status">
								This view reached its bounded query limit. Older durable rows are not loaded in this browser view.
							</div>
						{/if}
						<div class="rounded-lg border border-border/70 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
							This is the complete durable transcript. Messages labelled “Outside model view” remain saved for audit, but are not in the agent’s current prompt.
						</div>
						<ol class="m-0 list-none p-0" aria-label="Full Task transcript">
							{#each rootMessages as message (message.key)}
								<AgentTranscriptItem
									{message}
									outsideModelView={contextView.outsideMessageIds.has(message.id)}
									checkpointOrigin={message.annotation?.tag === 'compact'
										? compactOrigin(message, rootRuns)
										: null}
									onedit={!taskAcceptsSubmission || editableUserMessageText(message) === null
										? undefined
										: reviseMessage}
								/>
							{/each}
						</ol>
						{#each directChildren(activeTask.id) as child (child.id)}
							{@render childConversation(child)}
						{/each}
					</Stack>
				{/if}
			{/if}
		</Stack>
	</Scroll>

	<Stack gap="sm" class="shrink-0 border-t border-border bg-card px-3 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
		{#if revisedMessage !== null}
			<Inline
				align="center"
				gap="sm"
				class="rounded-lg border border-primary/20 bg-primary/5 px-2.5 py-2"
			>
				<Icon icon="lucide:message-square-pen" class="size-3.5 shrink-0 text-primary" />
				<p class="m-0 min-w-0 flex-1 text-tiny text-muted-foreground">
					Revising message {revisedMessage.sequence + 1}. The original remains in the durable transcript;
					this appends a revision that supersedes it.
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
		{#if activeTask?.status === 'done'}
			<p class="text-xs text-muted-foreground">
				This Task is complete and immutable. Start a new Task for another objective.
			</p>
		{:else if canResume}
			<p class="text-xs text-muted-foreground">
				Resume this Task before submitting another message.
			</p>
		{/if}
		{#if sendFailure !== null}
			<p class="text-xs text-destructive" role="alert">{sendFailure}</p>
		{/if}
		{#if planMode || parsedDraft.kind === 'submission'}
			<p class="text-tiny text-muted-foreground">
				{parsedDraft.kind === 'submission' && parsedDraft.mode === 'compact'
					? 'Compact saves a focus checkpoint without deleting durable history.'
					: 'Plan saves an objective and verification contract. Future Agent turns focus on the latest Plan; no new Task is needed.'}
			</p>
		{/if}
		<form
			class={AGENT_COMPOSER_SHELL_CLASS}
			onsubmit={(event) => {
				event.preventDefault();
				attemptSend('normal');
			}}
		>
			<label class="sr-only" for="agent-task-composer">Message</label>
			<textarea
				id="agent-task-composer"
				bind:this={composer}
				bind:value={draft}
				onkeydown={onComposerKeydown}
				rows={3}
				placeholder="Ask anything, or type /plan or /compact"
				class={AGENT_COMPOSER_EDITOR_CLASS}
				disabled={pending || controlPending || !taskAcceptsSubmission}
			></textarea>
			<Inline align="center" gap="xs" class="px-2.5 pb-2">
				<button
					type="button"
					aria-pressed={planMode}
					aria-keyshortcuts="Tab"
					disabled={pending || controlPending || !taskAcceptsSubmission}
					onclick={() => (planMode = !planMode)}
					class={`rounded-md px-1.5 py-0.5 ${AGENT_COMPOSER_CONTROL_TEXT_CLASS} ${
						planMode ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted'
					}`}
				>
					{planMode ? 'Plan' : 'Agent'}
				</button>
				<kbd class="rounded border border-border/70 bg-muted/60 px-1 py-0.5 font-mono text-micro">Tab</kbd>
				{#if costLabel !== ''}<span class="text-tiny text-muted-foreground">{costLabel}</span>{/if}
				<span class="flex-1"></span>
				{#if taskWorking}
					<Button
						type="button"
						variant="ghost"
						size="icon"
						class="size-8 rounded-full"
						disabled={!canSend}
						aria-label="Steer Task"
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
						aria-label="Stop Task"
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
						disabled={controlPending}
						aria-label="Resume Task"
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
					aria-label={revisedMessage !== null ? 'Send revised message' : 'Submit Task message'}
				>
					{#if pending}
						<Spinner class="size-4" label={t(agentOrbBusyStatusKey(orbState))} />
					{:else}
						<Icon icon="lucide:arrow-up" class="size-4" />
					{/if}
				</Button>
			</Inline>
		</form>
	</Stack>
</Stack>
