<!--
	A run of tool steps, the agent panel's and each sub-agent's: one quiet line per step (its own icon, what it did in
	words, on what, how long), opening to that tool's own view (`ToolBody`). A failed step is red and says why in one line
	(the whole reason on hover). A piece of reasoning opens to its text.
-->
<script lang="ts">
	import { SvelteSet } from 'svelte/reactivity';
	import { CodeEditor, Icon, type UiContext } from '@norbital-ai/ui';
	import type { AgentRow } from '../../protocol/wire.ts';
	import ToolBody from './ToolBody.svelte';
	import { checkOf, failureOf, reportView, stepArgs, stepView, type StepView } from './view.ts';

	let {
		ctx,
		steps,
		t,
		activity = false,
		opened = new SvelteSet<string>()
	}: {
		ctx: UiContext;
		steps: readonly AgentRow[];
		t: (key: string) => string;
		activity?: boolean;
		/** The steps a reader opened: only those render their tabs. The panel's own, so a regrouped run keeps them open. */
		opened?: SvelteSet<string>;
	} = $props();

	const viewOf = (s: AgentRow): StepView =>
		s.tool === undefined
			? { icon: 'lucide:brain', verb: 'Thought', target: '' }
			: stepView(s.tool.name, stepArgs(s.tool.args));
	const active = (s: AgentRow) => s.tool?.running === true || s.state === 'streaming';
	const seconds = (ms: number) =>
		ms < 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`;
</script>

<ol class={activity ? 'min-w-0 w-full space-y-1' : 'mt-1 min-w-0 w-full space-y-0.5 border-l border-border/70 pl-3'}>
	{#each steps as s (s.id)}
		{@const report = reportView(s)}
		{@const v = report ?? viewOf(s)}
		{@const tool = s.tool}
		{@const check = checkOf(tool)}
		{@const failed = tool?.failed === true && check === null}
		{@const reason = failureOf(tool)}
		{@const found =
			check === null
				? ''
				: [
						check.typeErrors > 0 ? `${check.typeErrors} ${t('type errors')}` : '',
						check.testsFailed ? t('Tests failed') : ''
					]
						.filter((part) => part !== '')
						.join(' · ')}
		<li
			class="animate-in fade-in-0 slide-in-from-bottom-1 animation-duration-150 ease-out motion-reduce:animate-none"
			data-step
			data-tool={tool?.name}
			data-report={s.report?.conversation}
			data-step-icon={v.icon}
			data-step-state={active(s) ? 'running' : failed ? 'failed' : 'done'}
		>
			<details
				class="group/step min-w-0 w-full"
				open={opened.has(s.id)}
				ontoggle={(e) => (e.currentTarget.open ? opened.add(s.id) : opened.delete(s.id))}
			>
				<summary
					class="flex min-w-0 min-h-8 w-full pointer-coarse:min-h-11 cursor-pointer list-none items-center rounded focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [&::-webkit-details-marker]:hidden {activity
						? 'gap-3 py-2.5 text-sm'
						: 'gap-2 py-0.5 text-xs'} {failed
						? 'text-destructive'
						: 'text-muted-foreground hover:text-foreground'}"
				>
					<Icon
						name={failed
							? 'lucide:circle-alert'
							: active(s)
								? 'lucide:loader-circle'
								: found !== ''
									? 'lucide:shield-alert'
									: v.icon}
						class="shrink-0 {activity ? 'size-4.5' : 'size-3.5'} {active(s)
							? 'animate-spin motion-reduce:animate-none'
							: ''} {found !== '' ? 'text-warning-foreground dark:text-warning' : ''}"
					/>
					{#if failed}
						<span class="min-w-0 truncate font-medium" title={reason}>{reason}</span>
					{:else}
						<span
							class="shrink-0 {activity ? '' : 'font-medium'} {active(s) ? 'agent-shimmer' : ''}"
							>{t(v.verb)}</span
						>
						{#if (found || v.target) !== ''}<span
								class="min-w-0 truncate opacity-80"
								title={found || v.target}
								data-step-found={found !== '' || undefined}>{found || v.target}</span
							>{/if}
					{/if}
					{#if tool?.ms !== undefined && tool.ms >= 100}<span
							class="ml-auto shrink-0 tabular-nums opacity-70">{seconds(tool.ms)}</span
						>{:else}<span class="ml-auto"></span>{/if}
					{#if !activity}<Icon
							name="lucide:chevron-right"
							class="size-3 shrink-0 opacity-40 transition-transform group-open/step:rotate-90"
						/>{/if}
				</summary>
				{#if opened.has(s.id)}
					<div class="mt-1 mb-2 grid min-w-0 w-full gap-1.5 text-xs">
						{#if report !== null}
							<div class="max-h-56 overflow-auto rounded-md" data-step-pane="output">
								<CodeEditor
									value={report.message}
									readonly
									wrap
									min_height="0"
									class="text-micro"
									language="plaintext"
									aria-label={t('Output')}
								/>
							</div>
						{:else if tool === undefined}
							<p class="whitespace-pre-wrap text-muted-foreground italic" data-reasoning>
								{s.reasoning}
							</p>
						{:else}
							<ToolBody {ctx} {tool} view={v} {t} />
						{/if}
					</div>
				{/if}
			</details>
		</li>
	{/each}
</ol>

<style>
	/* the active step's words: a light band sweeping across muted text (still under reduced motion) */
	.agent-shimmer {
		background: linear-gradient(
				90deg,
				var(--color-muted-foreground) 35%,
				var(--color-foreground) 50%,
				var(--color-muted-foreground) 65%
			)
			0 0 / 250% 100%;
		-webkit-background-clip: text;
		background-clip: text;
		color: transparent;
		animation: agent-shimmer 1.8s linear infinite;
	}
	@keyframes agent-shimmer {
		from {
			background-position: 100% 0;
		}
		to {
			background-position: -150% 0;
		}
	}
	details[open] > div {
		animation: step-in 150ms var(--ease-out, ease-out);
	}
	@keyframes step-in {
		from {
			opacity: 0;
			transform: translateY(-2px);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.agent-shimmer {
			animation: none;
			color: var(--color-muted-foreground);
		}
		details[open] > div {
			animation: none;
		}
	}
</style>
