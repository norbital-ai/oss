<script lang="ts">
	import { ReadonlyMarkdown } from '@norbital-ai/ui/markdown-editor';
	import { Tabs } from '@norbital-ai/ui/tabs';
	import { Inline, Stack } from '@norbital-ai/ui/layout';
	import { compactOrigin, plainMessageText, projectAgentContextView } from './context-view.js';
	import AgentTranscriptItem from './agent-transcript-item.svelte';
	import type { AgentPlanRow, AgentRunRow, PanelMessage } from './transcript.js';

	let {
		plan,
		runs,
		messages,
		status,
		parentAttribution = false
	}: {
		plan?: AgentPlanRow | undefined;
		runs: readonly AgentRunRow[];
		messages: readonly PanelMessage[];
		status?: string | undefined;
		parentAttribution?: boolean;
	} = $props();
	const view = $derived(projectAgentContextView({ messages, runs, activePlan: plan }));
	const title = $derived(view.checkpoint === null ? 'Plan' : 'Summary');
</script>

{#snippet summary()}
	<Stack gap="lg" class="px-3 pb-3 text-sm leading-6">
		{#if plan !== undefined}
			<Inline justify="between" gap="md" class="text-xs text-muted-foreground">
				<span>Plan {plan.revision}</span>
				<span>{status ?? plan.status}</span>
			</Inline>
			<ReadonlyMarkdown scale="reading" content={plan.body} />
		{/if}
		{#if view.checkpoint !== null}
			{#if plan !== undefined}<p class="m-0 text-xs font-medium">Conversation summary</p>{/if}
			<ReadonlyMarkdown scale="reading" content={plainMessageText(view.checkpoint)} />
		{/if}
	</Stack>
{/snippet}

{#snippet transcript()}
	<Stack gap="md" class="px-3 pb-3">
		<p class="m-0 text-xs text-muted-foreground">
			Earlier messages are saved here. The agent continues from the {title.toLowerCase()} and the conversation
			below.
		</p>
		<ol class="m-0 list-none p-0" aria-label="Prior transcript">
			{#each view.historyMessages as message (message.key)}
				<AgentTranscriptItem
					{message}
					{parentAttribution}
					outsideModelView={view.outsideMessageIds.has(message.id)}
					checkpointOrigin={message.annotation?.tag === 'compact'
						? compactOrigin(message, runs)
						: null}
				/>
			{/each}
		</ol>
	</Stack>
{/snippet}

{#if plan !== undefined || view.checkpoint !== null}
	{#key `${plan?.id ?? ''}:${view.checkpoint?.id ?? ''}`}
		<section
			class="min-w-0 rounded-xl border border-border"
			aria-label={`${title} and prior transcript`}
		>
			<Tabs
				variant="underline"
				layout="horizontal"
				animate={false}
				contentPadding={false}
				class="h-auto"
				listClass="mx-3"
				keepAlive
				config={[
					{
						name: 'summary',
						label: title,
						icon: title === 'Plan' ? 'lucide:notebook-pen' : 'lucide:scan-text',
						content: summary
					},
					{
						name: 'transcript',
						label: `Prior transcript · ${view.historyMessages.length}`,
						icon: 'lucide:messages-square',
						content: transcript
					}
				]}
			/>
		</section>
	{/key}
{/if}
