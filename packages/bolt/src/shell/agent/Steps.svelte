<!--
	A run of tool steps (§5.9), the agent panel's and each sub-agent's: one quiet line per step (its own icon, what it did in
	words, on what, how long), opening to tabs — the code it carried (highlighted), its input and its output, each compacted
	and formatted — and a one-line result above them (the failure, or a row count). A failed step is red and says why in one
	line under it (the whole reason on hover, and in full when opened). A piece of reasoning opens to its text.
-->
<script lang="ts">
	import { Option, Schema } from 'effect';
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import { CodeEditor, Icon } from '@norbital-ai/ui';
	import type { AgentRow } from '../../protocol/wire.ts';
	import { failureOf, resultLine, stepView, type StepView } from './view.ts';

	let { steps, t }: { steps: readonly AgentRow[]; t: (key: string) => string } = $props();

	const json = (text: string | undefined) =>
		Option.getOrNull(Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))(text ?? ''));
	const viewOf = (s: AgentRow): StepView =>
		s.tool === undefined
			? { icon: 'lucide:brain', verb: 'Thought', target: '' }
			: stepView(s.tool.name, json(s.tool.args));
	/** Pretty JSON when it parses (a clipped result does not), else the text as it came. */
	const pretty = (text: string) => {
		const v = json(text);
		return v === null ? text : JSON.stringify(v, null, 2);
	};
	const active = (s: AgentRow) => s.tool?.running === true || s.state === 'streaming';
	const seconds = (ms: number) =>
		ms < 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`;
	/** The steps a reader opened: only those render their tabs. */
	const opened = new SvelteSet<string>();
	const pane = new SvelteMap<string, 'code' | 'input' | 'output'>();
</script>

<ol class="mt-1 space-y-0.5 border-l border-border/70 pl-3">
	{#each steps as s (s.id)}
		{@const v = viewOf(s)}
		{@const tool = s.tool}
		{@const failed = tool?.failed === true}
		{@const reason = failureOf(tool)}
		<li
			class="animate-in fade-in-0 slide-in-from-bottom-1 animation-duration-150 ease-out motion-reduce:animate-none"
			data-step
			data-tool={tool?.name}
			data-step-icon={v.icon}
			data-step-state={active(s) ? 'running' : failed ? 'failed' : 'done'}
		>
			<details
				class="group/step"
				ontoggle={(e) => (e.currentTarget.open ? opened.add(s.id) : opened.delete(s.id))}
			>
				<summary
					class="flex cursor-pointer list-none items-center gap-2 rounded py-0.5 text-xs [&::-webkit-details-marker]:hidden {failed
						? 'text-destructive'
						: 'text-muted-foreground hover:text-foreground'}"
				>
					<Icon
						name={failed ? 'lucide:circle-alert' : active(s) ? 'lucide:loader-circle' : v.icon}
						class="size-3.5 shrink-0 {active(s) ? 'animate-spin motion-reduce:animate-none' : ''}"
					/>
					<span class="shrink-0 font-medium {active(s) ? 'agent-shimmer' : ''}">{t(v.verb)}</span>
					{#if v.target !== ''}<span class="min-w-0 truncate opacity-80" title={v.target}
							>{v.target}</span
						>{/if}
					{#if tool?.ms !== undefined && tool.ms >= 100}<span
							class="ml-auto shrink-0 tabular-nums opacity-70">{seconds(tool.ms)}</span
						>{:else}<span class="ml-auto"></span>{/if}
					<Icon
						name="lucide:chevron-right"
						class="size-3 shrink-0 opacity-40 transition-transform group-open/step:rotate-90"
					/>
				</summary>
				{#if opened.has(s.id)}
					<div class="mt-1 mb-2 grid gap-1.5 text-xs">
						{#if tool === undefined}
							<p class="whitespace-pre-wrap text-muted-foreground italic" data-reasoning>
								{s.reasoning}
							</p>
						{:else}
							{@const line = resultLine(json(tool.result))}
							{#if line !== ''}<p
									class={failed ? 'text-destructive' : 'text-muted-foreground'}
									data-step-result
								>
									{line}
								</p>{/if}
							{@const tabs = [
								...(v.code !== undefined && v.code.text !== '' ? (['code'] as const) : []),
								...(tool.args !== undefined ? (['input'] as const) : []),
								...(tool.result !== undefined ? (['output'] as const) : [])
							]}
							{#if tabs.length > 0}
								{@const shown = tabs.find((k) => k === pane.get(s.id)) ?? tabs[0]!}
								<div role="tablist" class="flex gap-1">
									{#each tabs as k (k)}
										<button
											type="button"
											role="tab"
											data-pane={k}
											aria-selected={shown === k}
											onclick={() => pane.set(s.id, k)}
											class="rounded px-1.5 py-0.5 text-[0.7rem] {shown === k
												? 'bg-muted font-medium text-foreground'
												: 'text-muted-foreground hover:text-foreground'}"
											>{t(k === 'code' ? 'Code' : k === 'input' ? 'Input' : 'Output')}</button
										>
									{/each}
								</div>
								{@const text =
									shown === 'code'
										? (v.code?.text ?? '')
										: pretty((shown === 'input' ? tool.args : tool.result) ?? '')}
								<div
									role="tabpanel"
									class="max-h-56 overflow-auto rounded-md"
									data-step-pane={shown}
								>
									{#key `${s.id}:${shown}`}
										<CodeEditor
											value={text}
											readonly
											wrap
											minHeight="0"
											class="text-[0.7rem]"
											language={shown === 'code'
												? (v.code?.language ?? 'plaintext')
												: /^\s*[[{]/.test(text)
													? 'json'
													: 'plaintext'}
											aria-label={t(
												shown === 'code' ? 'Code' : shown === 'input' ? 'Input' : 'Output'
											)}
										/>
									{/key}
								</div>
							{/if}
						{/if}
					</div>
				{/if}
			</details>
			{#if reason !== ''}<p
					class="truncate pb-0.5 pl-5.5 text-xs text-destructive/80"
					title={reason}
					data-step-failure
				>
					{reason}
				</p>{/if}
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
