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
	import type { PanelMessage } from './transcript.js';
	import Self from './agent-transcript-item.svelte';

	let { message, nested = false }: { message: PanelMessage; nested?: boolean } = $props();

	/** The recap is what the model carries, so it opens first; the raw conversation is one click away. */
	let checkpointTab = $state<'summary' | 'raw'>('summary');

	function roleLabel(role: string): string {
		if (role === 'user') return 'You';
		if (role === 'assistant') return 'Agent';
		return 'System';
	}
</script>

{#if message.kind === 'checkpoint'}
	<li class="message my-1.5" data-role="checkpoint">
		<!-- Core rendered this as a bare `<details>` reading "Context automatically compacted". The two
		     tabs are the addition: the summary alone tells a reader that history went somewhere without
		     telling them where, and nothing was actually deleted to hide. -->
		<details class="group/compaction w-full text-xs" role="note">
			<!-- stupidity:allow UI6 -- details disclosure summary is a clickable control row. -->
			<summary
				class="flex cursor-pointer list-none items-center gap-2 rounded-lg px-2 py-1.5 text-muted-foreground transition-colors duration-150 hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-ring"
			>
				<Icon icon="lucide:notebook-tabs" class="size-3.5 shrink-0" />
				<span>Context compacted</span>
				<span class="text-tiny text-muted-foreground/70">
					{message.before.length} message{message.before.length === 1 ? '' : 's'} kept below
				</span>
				<Icon
					icon="lucide:chevron-right"
					class="ml-auto size-3 shrink-0 text-muted-foreground/45 transition-transform duration-150 group-open/compaction:rotate-90"
				/>
			</summary>
			<div class="mt-1 ml-3.5 flex flex-col gap-2 border-l border-border/60 py-1 pl-3">
				<div class="flex items-center gap-1" role="tablist" aria-label="Compacted context">
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
						What the agent kept
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
						Full conversation
					</button>
				</div>
				<div role="tabpanel" class="min-w-0">
					{#if checkpointTab === 'summary'}
						<p
							class="m-0 max-h-72 overflow-auto text-micro leading-relaxed break-words whitespace-pre-wrap text-foreground/90"
						>
							{message.summary}
						</p>
					{:else}
						<ol
							class="m-0 flex max-h-72 list-none flex-col gap-1.5 overflow-auto p-0"
							aria-label="Conversation before compaction"
						>
							{#each message.before as earlier (earlier.key)}
								<Self message={earlier} nested />
							{/each}
						</ol>
					{/if}
				</div>
			</div>
		</details>
	</li>
{:else if message.kind === 'tool'}
	<li class="message" data-role="tool" data-tool={message.name}>
		<!-- One row per call, collapsed: the name and its identifying argument are the whole story most
		     of the time, and the payload is tenant data that belongs behind a deliberate click rather
		     than in the flow of the conversation. -->
		<details class="group/tool w-full">
			<!-- stupidity:allow UI6 -- details disclosure summary is a clickable control row. -->
			<summary
				class="flex cursor-pointer list-none items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-muted-foreground transition-colors duration-150 hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-ring"
			>
				<Icon
					icon={message.icon}
					class={`size-3.5 shrink-0 ${
						message.state === 'failed' ? 'text-destructive' : 'text-muted-foreground'
					}`}
				/>
				<span class="shrink-0 font-medium text-foreground/80">{message.label}</span>
				{#if message.detail}
					<span class="min-w-0 truncate font-mono text-tiny">{message.detail}</span>
				{/if}
				{#if message.children.length > 0}
					<span class="shrink-0 text-tiny text-muted-foreground/70">
						{message.children.length} step{message.children.length === 1 ? '' : 's'}
					</span>
				{/if}
				{#if message.state === 'running'}
					<Icon icon="lucide:loader-circle" class="size-3 shrink-0 animate-spin" />
				{:else if message.state === 'failed'}
					<Icon icon="lucide:circle-alert" class="size-3 shrink-0 text-destructive" />
				{/if}
				<Icon
					icon="lucide:chevron-right"
					class="ml-auto size-3 shrink-0 text-muted-foreground/45 transition-transform duration-150 group-open/tool:rotate-90"
				/>
			</summary>
			<div class="mt-1 ml-3.5 flex flex-col gap-2 border-l border-border/60 py-1 pl-3">
				{#if message.input}
					<div class="flex min-w-0 flex-col gap-1">
						<span class="text-tiny font-medium tracking-wide text-muted-foreground uppercase">
							Input
						</span>
						<pre
							class="m-0 max-h-56 overflow-auto rounded-md border bg-background p-2 font-mono text-micro leading-snug text-foreground/90">{message.input}</pre>
					</div>
				{/if}
				{#if message.children.length > 0}
					<!-- The delegated agent's own transcript, rendered by this same component. -->
					<div class="flex min-w-0 flex-col gap-1">
						<span class="text-tiny font-medium tracking-wide text-muted-foreground uppercase">
							Delegated transcript
						</span>
						<ol class="m-0 flex list-none flex-col gap-1.5 p-0" aria-label="Subagent transcript">
							{#each message.children as child (child.key)}
								<Self message={child} nested />
							{/each}
						</ol>
					</div>
				{/if}
				{#if message.error}
					<div class="flex min-w-0 flex-col gap-1">
						<span class="text-tiny font-medium tracking-wide text-destructive uppercase">Error</span
						>
						<pre
							class="m-0 max-h-56 overflow-auto rounded-md border border-destructive/30 bg-destructive/5 p-2 font-mono text-micro leading-snug break-words whitespace-pre-wrap text-destructive">{message.error}</pre>
					</div>
				{:else if message.output}
					<div class="flex min-w-0 flex-col gap-1">
						<span class="text-tiny font-medium tracking-wide text-muted-foreground uppercase">
							Result
						</span>
						<pre
							class="m-0 max-h-56 overflow-auto rounded-md border bg-background p-2 font-mono text-micro leading-snug text-foreground/90">{message.output}</pre>
					</div>
				{:else if message.state === 'running'}
					<p class="m-0 text-micro text-muted-foreground">Waiting for the result…</p>
				{/if}
			</div>
		</details>
	</li>
{:else}
	<!-- The list gap is tuned for consecutive tool rows; the margin restores the wider rhythm between
	     spoken messages without re-spacing the trace. A nested transcript keeps the tighter rhythm. -->
	<li
		class="message flex flex-col gap-1.5"
		class:my-1.5={!nested}
		class:items-end={message.role === 'user' && !nested}
		data-role={message.role}
	>
		<span class="px-1 text-tiny font-medium text-muted-foreground">
			{nested && message.role === 'user' ? 'Task' : roleLabel(message.role)}
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
			<p class="content m-0 break-words whitespace-pre-wrap">{message.content}</p>
			{#if message.status === 'streaming'}
				<span class="mt-1.5 inline-flex items-center gap-1.5 text-tiny text-muted-foreground">
					<span class="size-1.5 animate-pulse rounded-full bg-current"></span>
					Streaming
				</span>
			{/if}
		</div>
	</li>
{/if}
