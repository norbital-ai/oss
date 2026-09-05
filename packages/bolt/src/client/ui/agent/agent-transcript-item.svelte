<script lang="ts">
	import Icon from '@iconify/svelte';
	import { CodeEditor } from '@norbital-ai/ui/code-editor';
	import { ReadonlyMarkdown } from '@norbital-ai/ui/markdown-editor';
	import { Inline, Stack } from '@norbital-ai/ui/layout';
	import { Result, Schema } from 'effect';
	import type { Prompt } from 'effect/unstable/ai';
	import { workspaceSession } from '#lib/client/session.js';
	import { decodeAttachmentDescriptor } from '#lib/runtime/agents/image-descriptors.js';
	import type { CompactOrigin } from './context-view.js';
	import { plainMessageText } from './context-view.js';
	import type { PanelMessage } from './transcript.js';

	let {
		message,
		mode = null,
		parentAttribution = false,
		outsideModelView = false,
		checkpointOrigin = null,
		generating = false,
		hideTodo = false,
		onedit
	}: {
		message: PanelMessage;
		mode?: 'agent' | 'plan' | 'compact' | null;
		parentAttribution?: boolean;
		outsideModelView?: boolean;
		checkpointOrigin?: CompactOrigin | null;
		generating?: boolean;
		hideTodo?: boolean;
		onedit?: ((message: PanelMessage) => void) | undefined;
	} = $props();

	/** A persisted run failure renders as an error bubble, not a plain system note. */
	const failureText = $derived(
		message.author.kind === 'system' && plainMessageText(message).startsWith('Task failed:')
			? plainMessageText(message)
			: null
	);
	const steering = $derived(
		message.annotation?.tag === 'input' && message.annotation.priority === 'steer'
	);
	const cancelled = $derived(
		message.annotation?.tag === 'input' && message.annotation.cancelled === true
	);
	const queued = $derived(
		message.annotation?.tag === 'input' &&
			message.annotation.consumedAfterSequence === undefined &&
			!cancelled
	);
	const humanBubble = $derived(message.author.kind === 'human' && !parentAttribution && !steering);

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

	const isString = Schema.is(Schema.String);
	const isProgressPart = (part: Exclude<Prompt.MessageEncoded['content'], string>[number]) =>
		(part.type === 'tool-call' || part.type === 'tool-result') &&
		['todo', 'system/todo'].includes(part.name) &&
		(part.type !== 'tool-result' || !part.isFailure);

	function diagnostic(value: unknown): string {
		if (isString(value)) return value;
		return Result.getOrElse(
			Result.try(() => JSON.stringify(value, null, 2) ?? String(value)),
			() => String(value)
		);
	}

	function diagnosticLanguage(value: unknown): 'json' | 'plaintext' {
		const text = diagnostic(value).trimStart();
		return text.startsWith('{') || text.startsWith('[') ? 'json' : 'plaintext';
	}

	function fileHref(part: Prompt.FilePartEncoded): string | null {
		const descriptor = decodeAttachmentDescriptor(part.data);
		if (descriptor !== undefined) return workspaceSession().files.urlFor(descriptor.key);
		const href = isString(part.data)
			? part.data
			: part.data instanceof URL
				? part.data.toString()
				: null;
		return href !== null && /^(https?:\/\/|data:image\/(png|jpeg|gif|webp|avif);base64,)/.test(href)
			? href
			: null;
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

{#if !hideTodo || isString(message.message.content) || message.message.content.some((part) => !isProgressPart(part))}
	<li
		class="my-1.5 min-w-0 {mode === 'agent'
			? 'border-l-2 border-l-primary pl-2'
			: mode === 'plan'
				? 'border-l-2 border-l-yellow-500/70 pl-2'
				: ''}"
		data-role={message.message.role}
		data-model-view={outsideModelView ? 'outside' : 'inside'}
		aria-busy={generating && message.annotation?.tag === 'generation'}
	>
		<Stack gap="xs" align={humanBubble ? 'end' : 'stretch'}>
			<Inline align="center" gap="xs" justify={humanBubble ? 'end' : 'start'} class="min-w-0 px-1">
				<span class="text-tiny font-medium text-muted-foreground">{speaker(message)}</span>
				{#if cancelled}
					<span class="text-tiny text-muted-foreground">Cancelled</span>
				{:else if steering}
					<Icon icon="lucide:milestone" class="size-3.5 text-muted-foreground" />
					<span class="text-tiny text-muted-foreground"
						>{queued ? 'Steering · next step' : 'Steering applied'}</span
					>
				{:else if queued}
					<span class="text-tiny text-muted-foreground">Queued</span>
				{/if}
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

			{#if failureText !== null}
				<div
					class="rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm"
					role="alert"
				>
					<Inline gap="sm" align="start">
						<Icon icon="lucide:circle-alert" class="size-4 shrink-0 text-destructive" />
						<p class="m-0 min-w-0 flex-1 break-words whitespace-pre-wrap text-foreground">
							{failureText}
						</p>
					</Inline>
				</div>
			{:else if typeof message.message.content === 'string'}
				<div
					class={humanBubble
						? 'max-w-[88%] rounded-[1.15rem] bg-muted px-3.5 py-2.5 text-sm leading-6 text-foreground'
						: 'w-full text-sm leading-6 text-foreground'}
				>
					{#if message.message.role === 'assistant'}
						{#if message.annotation?.tag === 'generation' && message.annotation.activeParts.includes(0)}
							<span role="status" class="text-xs text-muted-foreground"
								>{generating ? 'Writing…' : 'Response interrupted'}</span
							>
						{/if}
						<ReadonlyMarkdown scale="reading" content={message.message.content} />
					{:else}
						<p class="m-0 break-words whitespace-pre-wrap">{message.message.content}</p>
					{/if}
				</div>
			{:else}
				{#each message.message.content as part, index (`${message.id}:${index}`)}
					{#if !hideTodo || !isProgressPart(part)}
						{@const pendingPart =
							message.annotation?.tag === 'generation' &&
							message.annotation.activeParts.includes(index)}
						{#if part.type === 'text'}
							<div
								class={humanBubble
									? 'max-w-[88%] rounded-[1.15rem] bg-muted px-3.5 py-2.5 text-sm leading-6 text-foreground'
									: 'w-full text-sm leading-6 text-foreground'}
							>
								{#if message.message.role === 'assistant'}
									{#if pendingPart}<span role="status" class="text-xs text-muted-foreground"
											>{generating ? 'Writing…' : 'Response interrupted'}</span
										>{/if}
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
										<span
											>{pendingPart
												? generating
													? 'Reasoning…'
													: 'Reasoning interrupted'
												: 'Reasoning'}</span
										>
									</Inline>
								</summary>
								<div class="mt-1 border-l border-border pl-3 text-foreground/85">
									<ReadonlyMarkdown scale="reading" content={part.text} />
								</div>
							</details>
						{:else if part.type === 'file'}
							{@const href = fileHref(part)}
							{#if href !== null && /^image\/(png|jpeg|gif|webp|avif)$/.test(part.mediaType)}
								<img
									src={href}
									alt={part.fileName ?? 'Agent image'}
									class="max-h-96 max-w-full rounded-lg object-contain"
								/>
							{/if}
							<div class="rounded-lg border border-border/70 bg-muted/30 px-3 py-2 text-xs">
								<Inline gap="sm">
									<Icon icon="lucide:file" class="size-3.5 text-muted-foreground" />
									{#if href === null}
										<span>{part.fileName ?? part.mediaType}</span>
									{:else}
										<a {href} target="_blank" rel="noreferrer" class="underline">
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
										{#if pendingPart}<span role="status" class="text-muted-foreground"
												>{generating ? 'Preparing…' : 'Interrupted'}</span
											>{/if}
									</Inline>
								</summary>
								<!-- repository-health:allow UI22 -- this box clips a growing CodeEditor under max-h-56; Bound always imposes one of its named height contracts, which would change the region's intrinsic height -->
								<div class="mt-1 max-h-56 overflow-hidden rounded-md border bg-background">
									<CodeEditor
										value={diagnostic(part.params)}
										language={diagnosticLanguage(part.params)}
										readonly
										ariaLabel="Tool call"
										minHeight="7rem"
										class="h-full w-full min-h-0 rounded-none border-0 shadow-none"
									/>
								</div>
							</details>
						{:else if part.type === 'tool-result'}
							<details class="group/tool-result rounded-lg px-2 py-1.5 text-xs">
								<summary class="cursor-pointer list-none">
									<Inline as="span" gap="sm">
										<Icon
											icon={part.isFailure ? 'lucide:circle-alert' : 'lucide:circle-check'}
											class={part.isFailure
												? 'size-3.5 text-destructive'
												: 'size-3.5 text-muted-foreground'}
										/>
										<span class="font-medium">{part.name}</span>
									</Inline>
								</summary>
								<!-- repository-health:allow UI22 -- this box clips a growing CodeEditor under max-h-56; Bound always imposes one of its named height contracts, which would change the region's intrinsic height -->
								<div class="mt-1 max-h-56 overflow-hidden rounded-md border bg-background">
									<CodeEditor
										value={diagnostic(part.result)}
										language={diagnosticLanguage(part.result)}
										readonly
										ariaLabel="Tool result"
										minHeight="7rem"
										class="h-full w-full min-h-0 rounded-none border-0 shadow-none"
									/>
								</div>
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
					{/if}
				{/each}
			{/if}

			{#if message.annotation?.tag === 'compact'}
				<details class="rounded-lg border border-border/70 bg-muted/20 px-3 py-2 text-xs">
					<summary class="cursor-pointer">{compactLabel(checkpointOrigin)}</summary>
					<p class="mb-0 text-muted-foreground">
						Focus begins after message {message.annotation.cutoff}; full durable history is
						retained.
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
{/if}
