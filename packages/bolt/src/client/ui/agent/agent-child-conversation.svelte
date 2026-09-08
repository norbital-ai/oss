<script lang="ts">
	import Icon from '@iconify/svelte';
	import { CodeEditor } from '@norbital-ai/ui/code-editor';
	import { Inline, Stack } from '@norbital-ai/ui/layout';
	import AgentContextSegment from './agent-context-segment.svelte';
	import AgentTranscriptItem from './agent-transcript-item.svelte';
	import { projectAgentContextView } from './context-view.js';
	import {
		diagnostic,
		diagnosticLanguage,
		pairToolCalls,
		type SubagentLink,
		type SubagentTranscript
	} from './tool-rows.js';

	/**
	 * A `subagent` spawn row is the child's conversation: its status, its transcript rendered with
	 * the same rows as the parent, and its own children nested the same way. The raw call and
	 * result stay behind a toggle for debugging; a spawn that failed shows its error as the block's
	 * only line.
	 */
	let { link, transcript }: { link: SubagentLink; transcript: SubagentTranscript } = $props();

	const task = $derived(
		link.conversationId === null ? undefined : transcript.tasks.find((task) => task.id === link.conversationId)
	);
	const messages = $derived(
		task === undefined ? [] : transcript.messages.filter((message) => message.conversationId === task.id)
	);
	const runs = $derived(
		task === undefined ? [] : transcript.runs.filter((run) => run.conversation_id === task.id)
	);
	const plan = $derived(
		task === undefined || task.active_plan_id === null
			? undefined
			: transcript.plans.find((plan) => plan.id === task.active_plan_id)
	);
	const view = $derived(
		projectAgentContextView({ messages, runs, ...(plan === undefined ? {} : { activePlan: plan }) })
	);
	const tools = $derived(pairToolCalls(messages));
	const running = $derived(link.pending || task?.status === 'running');
	const state = $derived(
		link.failure !== null ? 'failed' : link.pending ? 'starting' : (task?.status ?? 'missing')
	);
	const statusText = $derived(
		link.failure !== null
			? 'Spawn failed'
			: task === undefined
				? 'Starting child'
				: task.status === 'done'
					? 'Required result ready'
					: task.status === 'running'
						? 'Required child in progress'
						: `Required child · ${task.status}`
	);
</script>

<details
	class="w-full rounded-xl border border-border/70 bg-muted/15 px-3 py-2"
	open={running}
	data-subagent-conversation={link.agentId}
	data-subagent-state={state}
>
	<summary
		class="cursor-pointer list-none rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
	>
		<Inline align="center" gap="sm">
			<Icon icon="lucide:bot" class="size-4 shrink-0" />
			<div class="min-w-0 flex-1">
				<p class="m-0 truncate text-xs font-medium">{link.agentId}</p>
				<p class="m-0 text-micro text-muted-foreground">{statusText}</p>
			</div>
			<span class="rounded-full bg-background px-2 py-0.5 text-tiny text-muted-foreground">
				{state}
			</span>
		</Inline>
	</summary>

	<Stack gap="sm" class="border-l border-border/60 pl-3">
		{#if task !== undefined}
			<AgentContextSegment
				{plan}
				{runs}
				{messages}
				{tools}
				subagent={transcript}
				parentAttribution
			/>

			<ol class="m-0 list-none p-0" aria-label={`Child Task ${task.agent_id} active conversation`}>
				{#each view.focusMessages as message (message.key)}
					<AgentTranscriptItem
						{message}
						{tools}
						subagent={transcript}
						generating={runs.some((run) => run.id === message.runId && run.status === 'running')}
						mode={message.runId === null
							? null
							: (runs.find((run) => run.id === message.runId)?.mode ?? null)}
						parentAttribution={true}
					/>
				{/each}
			</ol>
		{:else if link.failure !== null}
			<p class="m-0 text-xs text-destructive" role="alert" data-subagent-failure>{link.failure}</p>
		{:else}
			<p class="m-0 text-xs text-muted-foreground" role="status">Starting…</p>
		{/if}

		<details class="text-xs" data-subagent-raw>
			<summary class="cursor-pointer list-none text-micro text-muted-foreground">
				Raw call and result
			</summary>
			<Stack gap="xs" class="mt-1">
				<!-- repository-health:allow UI22 -- this box clips a growing CodeEditor under max-h-56; Bound always imposes one of its named height contracts, which would change the region's intrinsic height -->
				<div class="max-h-56 overflow-hidden rounded-md border bg-background">
					<CodeEditor
						value={diagnostic(link.raw.params)}
						language={diagnosticLanguage(link.raw.params)}
						readonly
						ariaLabel="Tool call"
						minHeight="7rem"
						class="h-full w-full min-h-0 rounded-none border-0 shadow-none"
					/>
				</div>
				{#if link.raw.result !== undefined}
					<!-- repository-health:allow UI22 -- same clipped CodeEditor box as the call above -->
					<div class="max-h-56 overflow-hidden rounded-md border bg-background">
						<CodeEditor
							value={diagnostic(link.raw.result)}
							language={diagnosticLanguage(link.raw.result)}
							readonly
							ariaLabel="Tool result"
							minHeight="7rem"
							class="h-full w-full min-h-0 rounded-none border-0 shadow-none"
						/>
					</div>
				{/if}
			</Stack>
		</details>
	</Stack>
</details>
