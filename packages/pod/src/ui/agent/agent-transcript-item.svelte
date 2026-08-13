<script lang="ts">
	/**
	 * One row of a transcript, which may itself contain a transcript.
	 *
	 * Split out of the panel so a delegated agent renders through the same component as its parent
	 * rather than a second, quietly diverging renderer. It imports itself for that recursion; depth
	 * is bounded in `toPanelMessages`, so nothing here has to guard against a cycle.
	 *
	 * There is deliberately no composer inside: a subagent is given a task, it is not talked to.
	 */
	import Icon from '@iconify/svelte';
	import { onMount } from 'svelte';
	import { ReadonlyMarkdown } from '@norbital-ai/ui/markdown-editor';
	import { Inline, Scroll, Stack } from '@norbital-ai/ui/layout';
	import { Textarea } from '@norbital-ai/ui/textarea';
	import type { PanelMessage } from './transcript.js';
	import Self from './agent-transcript-item.svelte';
	import NorbitalThinkingOrb from './norbital-thinking-orb.svelte';
	import { toolOrbActivity } from './agent-orb-state.js';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import type { PodUiKeys } from '$lib/i18n/index.js';

	const { t } = useI18n<PodUiKeys>();

	/**
	 * Where this row sits, which decides what a `user` message means.
	 *
	 * Inside a subagent it is the task the parent handed down, and labelling it "You" reads as though
	 * the person typed it. Inside a checkpoint's history it really was the person. Both are nested, so
	 * a boolean cannot tell them apart.
	 */
	let {
		message,
		nested = null,
		onVerifierPrompt = undefined
	}: {
		message: PanelMessage;
		nested?: 'subagent' | 'history' | null;
		onVerifierPrompt?: (prompt: string) => void;
	} = $props();

	let prompt = $state('');

	onMount(() => {
		if (message.kind === 'verifier') prompt = message.prompt;
	});

	function saveVerifierPrompt(): void {
		if (message.kind !== 'verifier') return;
		if (prompt === message.prompt) return;
		onVerifierPrompt?.(prompt);
	}

	/** The recap is what the model carries, so it opens first; the raw conversation is one click away. */
	let checkpointTab = $state<'summary' | 'raw'>('summary');

	function roleLabel(role: string): string {
		if (role === 'user') return t('pod.agent.you');
		if (role === 'assistant') return t('pod.agent.agent');
		return t('pod.agent.system');
	}

	/** A built-in tool's label is a catalog key; everything else is the humanized name. */
	function toolLabel(message: Extract<PanelMessage, { kind: 'tool' }>): string {
		return message.labelKey ? t(message.labelKey) : (message.label ?? message.name);
	}

	function showToolNeedsInput(message: Extract<PanelMessage, { kind: 'tool' }>): boolean {
		return (
			message.state === 'needs_input' ||
			(Array.isArray(message.elicitation) && message.elicitation.length > 0)
		);
	}
</script>

{#if message.kind === 'checkpoint'}
	<li class="message my-1.5" data-role="checkpoint" data-fold={message.fold}>
		<!-- Core rendered this as a bare `<details>` reading "Context automatically compacted". The two
		     tabs are the addition: the summary alone tells a reader that history went somewhere without
		     telling them where, and nothing was actually deleted to hide. -->
		<details class="group/compaction w-full text-xs" role="note">
			<!-- stupidity:allow UI6 -- details disclosure summary is a clickable control row. -->
			<summary
				class="flex min-w-0 cursor-pointer list-none items-center gap-2 rounded-lg px-2 py-1.5 text-muted-foreground transition-colors duration-150 hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-ring"
			>
				<Icon icon="lucide:notebook-tabs" class="size-3.5 shrink-0" />
				<span class="shrink-0 whitespace-nowrap">
					{message.fold === 'plan' ? t('pod.agent.planFolded') : t('pod.agent.contextCompacted')}
				</span>
				<span class="min-w-0 flex-1 truncate text-tiny text-muted-foreground/70">
					{t('pod.agent.messagesKept', { count: message.before.length })}
				</span>
				<Icon
					icon="lucide:chevron-right"
					class="ml-auto size-3 shrink-0 text-muted-foreground/45 transition-transform duration-150 group-open/compaction:rotate-90"
				/>
			</summary>
			<Stack gap="sm" class="mt-1 ml-3.5 border-l border-border/60 py-1 pl-3">
				<Inline gap="xs" role="tablist" aria-label={t('pod.agent.compactedContextAria')}>
					<button
						type="button"
						role="tab"
						aria-selected={checkpointTab === 'summary'}
						onclick={() => (checkpointTab = 'summary')}
						class={`rounded-md px-2 py-0.5 text-tiny font-medium transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-ring ${
							checkpointTab === 'summary'
								? 'bg-primary/10 text-primary'
								: 'text-muted-foreground hover:bg-muted hover:text-foreground'
						}`}
					>
						{t('pod.agent.whatAgentKept')}
					</button>
					<button
						type="button"
						role="tab"
						aria-selected={checkpointTab === 'raw'}
						onclick={() => (checkpointTab = 'raw')}
						class={`rounded-md px-2 py-0.5 text-tiny font-medium transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-ring ${
							checkpointTab === 'raw'
								? 'bg-primary/10 text-primary'
								: 'text-muted-foreground hover:bg-muted hover:text-foreground'
						}`}
					>
						{message.fold === 'plan'
							? t('pod.agent.planningConversation')
							: t('pod.agent.fullConversation')}
					</button>
				</Inline>
				<div role="tabpanel" class="min-w-0">
					{#if checkpointTab === 'summary'}
						<Scroll
							name={t('pod.agent.whatAgentKept')}
							class="max-h-72 text-micro leading-relaxed text-foreground/90"
						>
							<ReadonlyMarkdown scale="reading" content={message.summary} class="content" />
						</Scroll>
					{:else}
						<Scroll
							as="ol"
							name={message.fold === 'plan'
								? t('pod.agent.planningConversation')
								: t('pod.agent.conversationBeforeCompaction')}
							layout="stack"
							gap="xs"
							class="m-0 max-h-72 list-none p-0"
						>
							{#each message.before as earlier (earlier.key)}
								<Self message={earlier} nested="history" />
							{/each}
						</Scroll>
					{/if}
				</div>
			</Stack>
		</details>
	</li>
{:else if message.kind === 'tool'}
	<li
		class="message"
		data-role="tool"
		data-tool={message.name}
		data-family={message.family === 'sandbox' ? 'sandbox' : undefined}
	>
		<!-- One row per call, collapsed: the name and its identifying argument are the whole story most
		     of the time, and the payload is tenant data that belongs behind a deliberate click rather
		     than in the flow of the conversation. -->
		<details class="group/tool w-full">
			<!-- stupidity:allow UI6 -- details disclosure summary is a clickable control row. -->
			<summary
				class="flex min-w-0 cursor-pointer list-none items-center gap-2 rounded-lg px-2 py-1.5 text-xs whitespace-nowrap text-muted-foreground transition-colors duration-150 hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-ring"
			>
				<Icon
					icon={message.icon}
					class={`size-3.5 shrink-0 ${
						message.state === 'failed' ? 'text-destructive' : 'text-muted-foreground'
					}`}
				/>
				<span class="shrink-0 font-medium whitespace-nowrap text-foreground/80">
					{#if message.family === 'sandbox'}
						{t('pod.agent.sandboxAgent')} · {toolLabel(message)}
					{:else}
						{toolLabel(message)}
					{/if}
				</span>
				{#if message.detail}
					<span class="min-w-0 flex-1 truncate font-mono text-tiny">{message.detail}</span>
				{/if}
				{#if message.children.length > 0}
					<span class="shrink-0 whitespace-nowrap text-tiny text-muted-foreground/70">
						{t('pod.agent.steps', { count: message.children.length })}
					</span>
				{/if}
				{#if message.state === 'running'}
					<NorbitalThinkingOrb
						state={toolOrbActivity(message.name)}
						size={16}
						class="shrink-0 text-foreground"
					/>
				{:else if message.state === 'needs_input'}
					<Icon
						icon="lucide:message-circle-question"
						class="size-3 shrink-0 text-muted-foreground"
					/>
				{:else if message.state === 'failed'}
					<Icon icon="lucide:circle-alert" class="size-3 shrink-0 text-destructive" />
				{/if}
				<Icon
					icon="lucide:chevron-right"
					class="ml-auto size-3 shrink-0 text-muted-foreground/45 transition-transform duration-150 group-open/tool:rotate-90"
				/>
			</summary>
			<Stack gap="sm" class="mt-1 ml-3.5 border-l border-border/60 py-1 pl-3">
				{#if showToolNeedsInput(message)}
					<Stack gap="xs" class="min-w-0">
						<span class="text-tiny font-medium tracking-wide text-muted-foreground uppercase">
							{t('pod.agent.needsInput')}
						</span>
						{#if message.elicitation?.length}
							{#each message.elicitation as request (request.id)}
								<Stack gap="xs" class="min-w-0">
									<p class="m-0 text-micro leading-relaxed text-foreground/90">{request.message}</p>
									{#if typeof request.url === 'string'}
										<p class="m-0 font-mono text-micro text-muted-foreground">{request.url}</p>
									{/if}
								</Stack>
							{/each}
						{:else}
							<p class="m-0 text-micro text-muted-foreground">{t('pod.agent.elicitation')}</p>
						{/if}
					</Stack>
				{/if}
				{#if message.input}
					<Stack gap="xs" class="min-w-0">
						<span class="text-tiny font-medium tracking-wide text-muted-foreground uppercase">
							{t('pod.agent.input')}
						</span>
						<Scroll
							name={t('pod.agent.input')}
							axis="both"
							class="m-0 max-h-56 rounded-md border bg-background p-2 font-mono text-micro leading-snug text-foreground/90"
						>
							<pre class="m-0 font-inherit text-inherit">{message.input}</pre>
						</Scroll>
					</Stack>
				{/if}
				{#if message.children.length > 0}
					<!-- The delegated agent's own transcript, rendered by this same component. -->
					<Stack gap="xs" class="min-w-0">
						<span class="text-tiny font-medium tracking-wide text-muted-foreground uppercase">
							{t('pod.agent.delegatedTranscript')}
						</span>
						<ol
							class="m-0 flex list-none flex-col gap-1.5 p-0"
							aria-label={t('pod.agent.subagentTranscriptAria')}
						>
							{#each message.children as child (child.key)}
								<Self message={child} nested="subagent" />
							{/each}
						</ol>
					</Stack>
				{/if}
				{#if message.error}
					<Stack gap="xs" class="min-w-0">
						<span class="text-tiny font-medium tracking-wide text-destructive uppercase"
							>{t('pod.agent.error')}</span
						>
						<Scroll
							name={t('pod.agent.error')}
							class="m-0 max-h-56 rounded-md border border-destructive/30 bg-destructive/5 p-2 font-mono text-micro leading-snug break-words whitespace-pre-wrap text-destructive"
						>
							<pre class="m-0 font-inherit text-inherit whitespace-pre-wrap">{message.error}</pre>
						</Scroll>
					</Stack>
				{:else if message.output}
					<Stack gap="xs" class="min-w-0">
						<span class="text-tiny font-medium tracking-wide text-muted-foreground uppercase">
							{t('pod.agent.result')}
						</span>
						<Scroll
							name={t('pod.agent.result')}
							axis="both"
							class="m-0 max-h-56 rounded-md border bg-background p-2 font-mono text-micro leading-snug text-foreground/90"
						>
							<pre class="m-0 font-inherit text-inherit">{message.output}</pre>
						</Scroll>
					</Stack>
				{:else if message.state === 'running'}
					<p class="m-0 text-micro text-muted-foreground">{t('pod.agent.waitingForResult')}</p>
				{/if}
			</Stack>
		</details>
	</li>
{:else if message.kind === 'reasoning'}
	<li class="message" data-role="reasoning">
		<details class="group/reasoning w-full">
			<!-- stupidity:allow UI6 -- reasoning is supplementary detail behind a disclosure. -->
			<summary
				class="flex min-w-0 cursor-pointer list-none items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-muted-foreground transition-colors duration-150 hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-ring"
			>
				<Icon icon="lucide:brain" class="size-3.5 shrink-0" />
				<span class="font-medium text-foreground/80">{t('pod.agent.reasoning')}</span>
				<Icon
					icon="lucide:chevron-right"
					class="ml-auto size-3 shrink-0 text-muted-foreground/45 transition-transform duration-150 group-open/reasoning:rotate-90"
				/>
			</summary>
			<div
				class="mt-1 ml-3.5 border-l border-border/60 py-1 pl-3 text-micro leading-relaxed text-foreground/80"
			>
				<ReadonlyMarkdown scale="reading" content={message.content} class="content" />
			</div>
		</details>
	</li>
{:else if message.kind === 'verifier'}
	<li class="message my-1.5" data-role="verifier" data-testid="agent-verifier-scheduled">
		<details class="group/verifier w-full" open>
			<!-- stupidity:allow UI6 -- verifier disclosure is a clickable control row. -->
			<summary
				class="flex min-w-0 cursor-pointer list-none items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-muted-foreground transition-colors duration-150 hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-ring"
			>
				<Icon icon="lucide:shield-check" class="size-3.5 shrink-0" />
				<span class="font-medium text-foreground/80">{t('pod.agent.verifierTriggered')}</span>
				<Icon
					icon="lucide:chevron-right"
					class="ml-auto size-3 shrink-0 text-muted-foreground/45 transition-transform duration-150 group-open/verifier:rotate-90"
				/>
			</summary>
			<Stack gap="xs" class="mt-1 ml-3.5 border-l border-border/60 py-1 pl-3">
				<p class="m-0 text-tiny text-muted-foreground">{t('pod.agent.verifierPromptHint')}</p>
				<label class="sr-only" for="agent-verifier-scheduled-{message.key}"
					>{t('pod.agent.verifierPrompt')}</label
				>
				<Textarea
					id="agent-verifier-scheduled-{message.key}"
					data-testid="agent-verifier-prompt"
					bind:value={prompt}
					onblur={saveVerifierPrompt}
					rows={3}
					class="min-h-16 max-h-32 resize-none border-border/60 bg-muted/30 px-2.5 py-2 text-xs shadow-none focus-visible:ring-1"
				/>
			</Stack>
		</details>
	</li>
{:else if message.kind === 'goal'}
	<li class="message my-1.5" data-role="goal" data-achieved={message.achieved}>
		<details class="group/goal w-full">
			<!-- stupidity:allow UI6 -- goal verification is supplementary detail behind a disclosure. -->
			<summary
				class="flex min-w-0 cursor-pointer list-none items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-muted-foreground transition-colors duration-150 hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-ring"
			>
				<Icon
					icon={message.achieved ? 'lucide:target' : 'lucide:circle-dashed'}
					class={`size-3.5 shrink-0 ${message.achieved ? 'text-primary' : 'text-muted-foreground'}`}
				/>
				<span class="font-medium text-foreground/80">
					{message.achieved ? t('pod.agent.verified') : t('pod.agent.notVerified')}
				</span>
				<Icon
					icon="lucide:chevron-right"
					class="ml-auto size-3 shrink-0 text-muted-foreground/45 transition-transform duration-150 group-open/goal:rotate-90"
				/>
			</summary>
			<Stack
				gap="xs"
				class="mt-1 ml-3.5 border-l border-border/60 py-1 pl-3 text-micro leading-relaxed text-foreground/80"
			>
				<ReadonlyMarkdown scale="reading" content={message.summary} class="content" />
				{#if message.gaps.length > 0}
					<Stack gap="xs">
						<span class="text-tiny font-medium tracking-wide text-muted-foreground uppercase">
							{t('pod.agent.goalGaps')}
						</span>
						<ul class="m-0 list-disc pl-4 text-micro text-foreground/80">
							{#each message.gaps as gap (gap)}
								<li>{gap}</li>
							{/each}
						</ul>
					</Stack>
				{/if}
			</Stack>
		</details>
	</li>
{:else if message.kind === 'text'}
	<!-- The list gap is tuned for consecutive tool rows; the margin restores the wider rhythm between
	     spoken messages without re-spacing the trace. A nested transcript keeps the tighter rhythm. -->
	<li
		class="message flex flex-col gap-1.5"
		class:my-1.5={!nested}
		class:items-end={message.role === 'user' && !nested}
		data-role={message.role}
	>
		<span class="px-1 text-tiny font-medium text-muted-foreground">
			{nested === 'subagent' && message.role === 'user'
				? t('pod.agent.task')
				: roleLabel(message.role)}
		</span>
		<div
			class={nested
				? 'w-full text-micro leading-relaxed text-foreground/90'
				: `text-sm leading-6 sm:max-w-[88%] ${
						message.role === 'user'
							? 'max-w-[88%] rounded-[1.15rem] bg-muted px-3.5 py-2.5 text-foreground'
							: message.role === 'assistant'
								? 'w-full text-foreground'
								: 'w-full rounded-lg bg-destructive/10 px-3.5 py-2.5 text-destructive'
					}`}
		>
			{#if message.role === 'assistant'}
				<ReadonlyMarkdown scale="reading" content={message.content} class="content" />
			{:else}
				<p class="content m-0 break-words whitespace-pre-wrap">{message.content}</p>
			{/if}
			{#if message.status === 'streaming'}
				<span class="mt-1.5 inline-flex items-center gap-1.5 text-tiny text-muted-foreground">
					<NorbitalThinkingOrb state="authoring" size={16} class="text-foreground" />
					{t('pod.agent.streaming')}
				</span>
			{/if}
		</div>
	</li>
{/if}
