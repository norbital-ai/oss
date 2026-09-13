<script lang="ts">
	import Icon from '@iconify/svelte';
	import { Button } from '@norbital-ai/ui/button';
	import { Tooltip } from '@norbital-ai/ui/tooltip';
	import { ReadonlyMarkdown } from '@norbital-ai/ui/markdown-editor';
	import { Tabs } from '@norbital-ai/ui/tabs';
	import { Bound, Inline, Scroll, Stack } from '@norbital-ai/ui/layout';
	import { compactOrigin, plainMessageText, projectAgentContextView } from './context-view.js';
	import AgentTranscriptItem from './agent-transcript-item.svelte';
	import type { SubagentTranscript, ToolPairing } from './tool-rows.js';
	import { type PlanRow, type TurnRow, type PanelMessage } from './transcript.js';

	let {
		plan,
		runs,
		messages,
		status,
		onrevise,
		onexecute,
		ondelete,
		executeDisabled = false,
		executePending = false,
		transitionDisabled = false,
		deleteDisabled = false,
		parentAttribution = false,
		tools = undefined,
		subagent = undefined
	}: {
		plan?: PlanRow | undefined;
		runs: readonly TurnRow[];
		messages: readonly PanelMessage[];
		status?: string | undefined;
		onrevise?: (() => void) | undefined;
		onexecute?: (() => void) | undefined;
		ondelete?: (() => void) | undefined;
		executeDisabled?: boolean;
		executePending?: boolean;
		transitionDisabled?: boolean;
		deleteDisabled?: boolean;
		parentAttribution?: boolean;
		tools?: ToolPairing | undefined;
		subagent?: SubagentTranscript | undefined;
	} = $props();
	let draftExpanded = $state(false);
	const draftBodyId = $props.id();
	const view = $derived(projectAgentContextView({ messages, runs, activePlan: plan }));
	const drafting = $derived(plan?.status === 'draft');
	const checkpoint = $derived(drafting ? null : view.checkpoint);
	const title = $derived(drafting ? 'Draft plan' : checkpoint === null ? 'Plan' : 'Compaction');
	const retainedCount = $derived(
		view.historyMessages.filter(
			(message) => message.id !== checkpoint?.id && !view.outsideMessageIds.has(message.id)
		).length
	);
	const explanation = $derived(
		`The agent continues from this ${checkpoint === null ? 'plan' : 'summary'}${plan !== undefined && checkpoint !== null ? ', the retained plan' : ''}${retainedCount > 0 ? `, ${retainedCount} retained ${retainedCount === 1 ? 'message' : 'messages'}` : ''} and new messages below. Earlier messages are saved in Transcript.`
	);
</script>

{#snippet summary()}
	<Scroll name={`${title} summary`}>
		<div class="px-3 pb-3">
			<Stack gap="lg" class="rounded-md bg-muted/30 p-3 text-sm">
				{#if checkpoint !== null}
					<!--
				The checkpoint is the model's own text. Rendered as markdown but never as HTML: a model
				that answers the summary request with its native tool-call markup must show that markup,
				not have the browser swallow the tags and leave the values run together (bolt.md B11).
			-->
					<ReadonlyMarkdown
						scale="compact"
						allowHtml={false}
						content={plainMessageText(checkpoint)}
					/>
				{/if}
				{#if plan !== undefined}
					<Inline justify="between" gap="md" class="text-xs text-muted-foreground">
						<span>Plan {plan.revision}</span>
						<span>{status ?? plan.status}</span>
						{#if onrevise}<Button
								size="sm"
								variant="ghost"
								disabled={transitionDisabled}
								onclick={onrevise}>Revise plan</Button
							>{/if}
						{#if ondelete}<Button
								size="sm"
								variant="ghost"
								disabled={deleteDisabled}
								onclick={ondelete}>Delete plan</Button
							>{/if}
					</Inline>
					<ReadonlyMarkdown scale="compact" allowHtml={false} content={plan.body} />
				{/if}
			</Stack>
		</div>
	</Scroll>
{/snippet}

{#snippet transcript()}
	<Scroll name={`${title} transcript`}>
		<Stack gap="md" class="px-3 pb-3">
			<ol class="m-0 list-none p-0" aria-label="Prior transcript">
				{#each view.historyMessages as message (message.key)}
					<AgentTranscriptItem
						{message}
						{parentAttribution}
						{tools}
						{subagent}
						outsideModelView={view.outsideMessageIds.has(message.id)}
						checkpointOrigin={message.annotation?.tag === 'compact' ? compactOrigin(message) : null}
					/>
				{/each}
			</ol>
		</Stack>
	</Scroll>
{/snippet}

{#if drafting && plan !== undefined}
	<section
		class="rounded-lg border border-border bg-muted/20"
		aria-label="Draft plan"
		aria-busy={executePending}
		data-context-boundary="draft-plan"
	>
		<Inline gap="xs" class="px-2 py-1.5">
			<Button
				variant="ghost"
				size="sm"
				class="min-w-0 gap-1.5 px-1"
				aria-expanded={draftExpanded}
				aria-controls={draftBodyId}
				onclick={() => (draftExpanded = !draftExpanded)}
			>
				<Icon
					icon="lucide:chevron-down"
					class="size-3.5 shrink-0 transition-transform duration-150 motion-reduce:transition-none {draftExpanded
						? 'rotate-180'
						: ''}"
				/>
				Draft plan
			</Button>
			<span
				class="ml-auto text-xs tabular-nums text-muted-foreground"
				title={`Revision ${plan.revision}`}>r{plan.revision}</span
			>
			{#if ondelete}<Button
					size="icon"
					variant="ghost"
					class="size-7 shrink-0"
					aria-label="Delete plan"
					hint="Delete plan and return to Agent mode"
					disabled={deleteDisabled || executePending}
					onclick={ondelete}
				>
					<Icon icon="lucide:trash-2" class="size-3.5" />
				</Button>{/if}
			{#if onexecute}<Button
					size="sm"
					class="shrink-0 gap-1.5 px-2"
					aria-label={executePending ? 'Starting plan' : 'Execute plan'}
					disabled={executeDisabled || executePending}
					onclick={onexecute}
				>
					<Icon
						icon={executePending ? 'lucide:loader-circle' : 'lucide:play'}
						class={executePending ? 'size-3.5 animate-spin motion-reduce:animate-none' : 'size-3.5'}
					/>
					<span aria-live="polite">{executePending ? 'Starting…' : 'Execute'}</span>
				</Button>{/if}
		</Inline>
		{#if draftExpanded}
			<Bound
				id={draftBodyId}
				size="compact"
				style="height: 28dvh"
				clip
				class="border-t border-border/60"
			>
				<Scroll name="Draft plan preview" inset>
					<ReadonlyMarkdown
						scale="compact"
						allowHtml={false}
						content={plan.body}
						class="px-3 py-2 leading-relaxed [&_h1]:text-base [&_h1]:tracking-normal [&_h2]:text-sm [&_h2]:tracking-normal"
					/>
				</Scroll>
			</Bound>
		{/if}
	</section>
{:else if plan !== undefined || checkpoint !== null}
	{#key `${plan?.id ?? ''}:${checkpoint?.id ?? ''}`}
		<section
			class="min-w-0 border-b border-border pb-3"
			class:plan-finalized={plan !== undefined}
			aria-label={`${title} and prior transcript`}
			data-context-boundary={checkpoint === null ? 'plan' : 'compaction'}
		>
			<Inline gap="sm" class="py-2 text-xs font-medium text-muted-foreground">
				<span class="h-px flex-1 bg-border"></span>
				<span>{title}</span>
				<Tooltip text={explanation} contentClass="max-w-72 text-xs">
					{#snippet trigger({ props })}
						<button
							{...props}
							type="button"
							aria-label={`About ${title.toLowerCase()}`}
							class="grid size-6 place-items-center rounded text-muted-foreground hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
							><Icon icon="lucide:info" class="size-3.5" /></button
						>
					{/snippet}
				</Tooltip>
				<span class="h-px flex-1 bg-border"></span>
			</Inline>

			<Tabs
				variant="underline"
				layout="horizontal"
				animate={false}
				contentPadding={false}
				class="h-80 max-h-[50dvh]"
				listClass="mx-3"
				keepAlive
				config={[
					{
						name: 'summary',
						label: 'Summary',
						icon: checkpoint === null ? 'lucide:notebook-pen' : 'lucide:scan-text',
						content: summary
					},
					{
						name: 'transcript',
						label: 'Transcript',
						icon: 'lucide:messages-square',
						content: transcript
					}
				]}
			/>
		</section>
	{/key}
{/if}

<style>
	.plan-finalized {
		animation: plan-finalize 200ms cubic-bezier(0.16, 1, 0.3, 1);
	}
	@keyframes plan-finalize {
		from {
			opacity: 0;
			transform: translateY(4px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.plan-finalized {
			animation: none;
		}
	}
</style>
