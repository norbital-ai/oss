<script lang="ts">
	import Icon from '@iconify/svelte';
	import { ReadonlyMarkdown } from '@norbital-ai/ui/markdown-editor';
	import { Inline, Scroll, Stack } from '@norbital-ai/ui/layout';
	import type { Prompt } from 'effect/unstable/ai';
	import type { CompactOrigin } from './context-view.js';
	import type { PanelMessage } from './transcript.js';

	let {
		message,
		parentAttribution = false,
		outsideModelView = false,
		checkpointOrigin = null,
		onedit
	}: {
		message: PanelMessage;
		parentAttribution?: boolean;
		outsideModelView?: boolean;
		checkpointOrigin?: CompactOrigin | null;
		onedit?: ((message: PanelMessage) => void) | undefined;
	} = $props();

	function speaker(entry: PanelMessage): string {
		switch (entry.author.kind) {
			case 'human':
				return parentAttribution ? 'Parent agent' : 'You';
			case 'parent-agent':
				return 'Parent agent';
			case 'agent':
				return 'Agent';
			case 'tool':
				return 'Tool';
			case 'system':
				return 'System';
		}
	}

	function diagnostic(value: unknown): string {
		if (typeof value === 'string') return value;
		try {
			return JSON.stringify(value, null, 2) ?? String(value);
		} catch {
			return String(value);
		}
	}

	function fileHref(part: Prompt.FilePartEncoded): string | null {
		if (typeof part.data === 'string') return part.data;
		if (part.data instanceof URL) return part.data.toString();
		return null;
	}

	function compactLabel(origin: CompactOrigin | null): string {
		switch (origin) {
			case 'automatic':
				return 'Automatic context checkpoint';
			case 'manual':
				return 'Manual context checkpoint';
			case 'unresolved':
				return 'Context checkpoint · origin unavailable';
			case null:
				return 'Context checkpoint';
		}
	}
</script>

<li
	class="my-1.5 min-w-0"
	data-role={message.message.role}
	data-model-view={outsideModelView ? 'outside' : 'inside'}
>
		<Stack gap="xs" align={message.author.kind === 'human' && !parentAttribution ? 'end' : 'stretch'}>
			<Inline
				align="center"
				gap="xs"
				justify={message.author.kind === 'human' && !parentAttribution ? 'end' : 'start'}
				class="min-w-0 px-1"
			>
				<span class="text-tiny font-medium text-muted-foreground">{speaker(message)}</span>
				{#if outsideModelView}
					<span
						class="rounded-full border border-border/70 bg-muted/50 px-1.5 py-0.5 text-micro text-muted-foreground"
						title="Saved in the full transcript, but outside the agent's active model view"
					>
						Outside model view
					</span>
				{/if}
				{#if onedit !== undefined && message.author.kind === 'human' && !parentAttribution}
					<button
						type="button"
						class="rounded px-1.5 py-0.5 text-micro text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						aria-label="Revise this message as a new instruction"
						onclick={() => onedit?.(message)}
					>
						Revise
					</button>
				{/if}
			</Inline>

			{#if typeof message.message.content === 'string'}
				<div
					class={message.author.kind === 'human' && !parentAttribution
						? 'max-w-[88%] rounded-[1.15rem] bg-muted px-3.5 py-2.5 text-sm leading-6 text-foreground'
						: 'w-full text-sm leading-6 text-foreground'}
				>
					{#if message.message.role === 'assistant'}
						<ReadonlyMarkdown scale="reading" content={message.message.content} />
					{:else}
						<p class="m-0 break-words whitespace-pre-wrap">{message.message.content}</p>
					{/if}
				</div>
			{:else}
				{#each message.message.content as part, index (`${message.id}:${index}`)}
					{#if part.type === 'text'}
						<div
							class={message.author.kind === 'human' && !parentAttribution
								? 'max-w-[88%] rounded-[1.15rem] bg-muted px-3.5 py-2.5 text-sm leading-6 text-foreground'
								: 'w-full text-sm leading-6 text-foreground'}
						>
							{#if message.message.role === 'assistant'}
								<ReadonlyMarkdown scale="reading" content={part.text} />
							{:else}
								<p class="m-0 break-words whitespace-pre-wrap">{part.text}</p>
							{/if}
						</div>
					{:else if part.type === 'reasoning'}
						<details class="group/reasoning rounded-lg px-2 py-1.5 text-xs">
							<summary class="cursor-pointer list-none text-muted-foreground">
								<Inline as="span" gap="sm">
									<Icon icon="lucide:brain" class="size-3.5" />
									<span>Reasoning</span>
								</Inline>
							</summary>
							<div class="mt-1 border-l border-border pl-3 text-foreground/85">
								<ReadonlyMarkdown scale="reading" content={part.text} />
							</div>
						</details>
					{:else if part.type === 'file'}
						{@const href = fileHref(part)}
						<div class="rounded-lg border border-border/70 bg-muted/30 px-3 py-2 text-xs">
							<Inline gap="sm">
								<Icon icon="lucide:file" class="size-3.5 text-muted-foreground" />
								{#if href === null}
									<span>{part.fileName ?? part.mediaType}</span>
								{:else}
									<a href={href} target="_blank" rel="noreferrer" class="underline">
										{part.fileName ?? part.mediaType}
									</a>
								{/if}
							</Inline>
						</div>
					{:else if part.type === 'tool-call'}
						<details class="group/tool rounded-lg px-2 py-1.5 text-xs">
							<summary class="cursor-pointer list-none">
								<Inline as="span" gap="sm">
									<Icon
										icon={part.name === 'system/subagent' ? 'lucide:bot' : 'lucide:wrench'}
										class="size-3.5 text-muted-foreground"
									/>
									<span class="font-medium">{part.name}</span>
								</Inline>
							</summary>
							<Scroll
								axis="both"
								name="Tool call details"
								class="mt-1 max-h-56 rounded-md border bg-background p-2"
							>
								<pre class="m-0 font-mono text-micro">{diagnostic(part.params)}</pre>
							</Scroll>
						</details>
					{:else if part.type === 'tool-result'}
						<details class="group/tool-result rounded-lg px-2 py-1.5 text-xs">
							<summary class="cursor-pointer list-none">
								<Inline as="span" gap="sm">
									<Icon
										icon={part.isFailure ? 'lucide:circle-alert' : 'lucide:circle-check'}
										class={part.isFailure ? 'size-3.5 text-destructive' : 'size-3.5 text-muted-foreground'}
									/>
									<span class="font-medium">{part.name}</span>
								</Inline>
							</summary>
							<Scroll
								axis="both"
								name="Tool result details"
								class="mt-1 max-h-56 rounded-md border bg-background p-2"
							>
								<pre class="m-0 font-mono text-micro">{diagnostic(part.result)}</pre>
							</Scroll>
						</details>
					{:else if part.type === 'tool-approval-request'}
						<div class="rounded-lg border border-border/70 bg-muted/30 px-3 py-2 text-xs">
							<Inline gap="sm">
								<Icon icon="lucide:shield-question" class="size-3.5" />
								<span>Approval requested for tool call {part.toolCallId}</span>
							</Inline>
						</div>
					{:else if part.type === 'tool-approval-response'}
						<div class="rounded-lg border border-border/70 bg-muted/30 px-3 py-2 text-xs">
							<Inline gap="sm">
								<Icon icon="lucide:shield-check" class="size-3.5" />
								<span>Approval response recorded</span>
							</Inline>
						</div>
					{/if}
				{/each}
			{/if}

			{#if message.annotation?.tag === 'compact'}
				<details class="rounded-lg border border-border/70 bg-muted/20 px-3 py-2 text-xs">
					<summary class="cursor-pointer">{compactLabel(checkpointOrigin)}</summary>
					<p class="mb-0 text-muted-foreground">
						Focus begins after message {message.annotation.cutoff}; full durable history is retained.
					</p>
				</details>
			{:else if message.annotation?.tag === 'plan-verdict'}
				<div class="rounded-lg border border-border/70 bg-muted/20 px-3 py-2 text-xs">
					<p class="m-0 font-medium">
						{message.annotation.complete ? 'Plan verified' : 'Plan verification found gaps'}
					</p>
					{#if message.annotation.gaps.length > 0}
						<ul class="mb-0 list-disc pl-4 text-muted-foreground">
							{#each message.annotation.gaps as gap (gap)}
								<li>{gap}</li>
							{/each}
						</ul>
					{/if}
				</div>
			{/if}
		</Stack>
</li>
