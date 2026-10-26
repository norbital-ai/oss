<!--
	A delegated sub-agent (§5.9 `subagent`), read-only: `compact`, one line in the session panel's list
	(its mark, task and state) that opens it; otherwise its whole view in the session panel — its task,
	checklist, steps as they land (the panel's own `Steps`), what it changed and made, its exchange with the delegating agent
	(a question it stopped on, the answer it got) and its answer. Sub-agents run detached and several at once; one spawns
	none of its own, so nothing nests. It reads the child as the panel reads its own conversation: a live transcript whose
	streaming and running rows say it works.
-->
<script lang="ts">
	import { observe } from '@norbital-ai/ui/effect';
	import { Option, Schema } from 'effect';
	import { watch } from 'runed';
	import { Button, Icon, ReadonlyMarkdown, Spinner } from '@norbital-ai/ui';
	import type { AgentRow } from '../../protocol/wire.ts';
	import type { ShellBolt } from '../runtime.ts';
	import Steps from './Steps.svelte';
	import MadeFiles from './MadeFiles.svelte';
	import AgentAvatar from './AgentAvatar.svelte';
	import { elapsedText } from '../studio/model.ts';
	import { callableWords, childStatus } from './view.ts';

	let {
		bolt,
		t,
		id,
		compact = false,
		onOpen,
		onBack,
		onState,
		control
	}: {
		bolt: Pick<ShellBolt, 'observe' | 'fileUrl'>;
		t: (key: string) => string;
		id: string;
		/** One line that opens the sub-agent (`onOpen`), instead of its whole view. */
		compact?: boolean;
		onOpen?: () => void;
		onBack?: () => void;
		onState?: (status: ReturnType<typeof childStatus> | null) => void;
		/** Stops a running sub-agent, or resumes a stopped one (its own conversation's stop and resume), calling `refused` when it did not; absent, it has neither. */
		control?: (id: string, stop: boolean, refused: () => void) => void;
	} = $props();

	const transcript = observe(() =>
		bolt.observe<{ rows: AgentRow[]; status?: 'idle' | 'running' | 'stopped' }>({
			read: { m: 'transcript', a: [id] }
		})
	);
	const rows = $derived(transcript.current?.rows ?? []);
	const error = $derived(transcript.error?.message ?? null);
	const task = $derived(rows.find((r) => r.role === 'user')?.text ?? '');
	/** After its task: each reply it settled on (a question when it stopped to ask) and the delegating agent's messages. */
	const thread = $derived(
		rows
			.slice(rows.findIndex((r) => r.role === 'user') + 1)
			.filter(
				(r) =>
					!!r.text &&
					(r.role === 'user' ||
						(r.role === 'assistant' && (r.tag === 'reply' || r.tag === 'failed')))
			)
	);
	const steps = $derived(
		rows.filter((r) => r.tool !== undefined || (r.role === 'assistant' && !!r.reasoning))
	);
	const status = $derived(childStatus(rows, transcript.current?.status));
	const reported = $derived(
		error !== null ? 'failed' : transcript.current === undefined ? null : status
	);
	const model = $derived(rows.findLast((r) => r.usage?.model !== undefined)?.usage?.model);
	const startedAt = $derived(Date.parse(rows.find((r) => r.role === 'user')?.at ?? ''));
	let now = $state(Date.now());
	watch(
		() => !compact && reported === 'running' && Number.isFinite(startedAt),
		(running) => {
			if (!running) return;
			now = Date.now();
			const timer = setInterval(() => (now = Date.now()), 1_000);
			return () => clearInterval(timer);
		}
	);
	/** Its checklist as its latest `goals` call set it (the child's own conversation holds the same list). */
	const Goals = Schema.fromJsonString(
		Schema.Struct({
			items: Schema.Array(
				Schema.Struct({
					id: Schema.String,
					text: Schema.String,
					status: Schema.Literals(['pending', 'doing', 'done'])
				})
			)
		})
	);
	const goals = $derived(
		Option.match(
			Schema.decodeUnknownOption(Goals)(
				rows.findLast((r) => r.tool?.name === 'goals' && !r.tool.failed)?.tool?.args ?? ''
			),
			{ onNone: () => [], onSome: (g) => g.items }
		)
	);
	const changes = $derived(rows.flatMap((r) => r.receipts ?? []));
	const made = $derived(rows.flatMap((r) => (r.role === 'tool' ? (r.files ?? []) : [])));
	const LABEL = {
		running: 'is working',
		asking: 'Waiting for an answer',
		stopped: 'Stopped',
		failed: 'Failed',
		done: 'Done'
	} as const;
	/** A stop asked for and not yet seen: the button holds until the status says so, or the stop is refused. */
	let stopping = $state(false);
	const toggle = (stop: boolean) => {
		stopping = stop;
		control?.(id, stop, () => (stopping = false));
	};
	watch([() => reported, () => onState], ([state, notify]) => {
		notify?.(state);
		if (state !== 'running') stopping = false;
	});
</script>

{#snippet stopButton()}
	{#if control !== undefined && reported === 'running'}<Button
			size="icon-sm"
			variant="ghost"
			class="shrink-0 text-muted-foreground"
			aria-label={t('Stop sub-agent')}
			title={t('Stop sub-agent')}
			disabled={stopping}
			onclick={() => toggle(true)}
			data-subagent-stop><Icon name="lucide:square" class="size-3.5 fill-current" /></Button
		>{/if}
{/snippet}

{#snippet head()}
	<AgentAvatar {id} />
	<span class="min-w-0 flex-1 truncate" title={task}>{task.split('\n')[0] || t('Sub-agent')}</span>
	{#if reported !== 'running' && reported !== 'done'}<span
			class="shrink-0 text-xs {error !== null || status === 'failed'
				? 'text-destructive'
				: 'text-muted-foreground'}"
			title={error ?? undefined}
			>{error !== null ? t('Failed') : reported === null ? t('Loading…') : t(LABEL[status])}</span
		>{/if}
{/snippet}

{#if compact}
	<!-- one line that opens it; a running one's Stop sits beside it (a button cannot hold another) -->
	<div
		class="flex w-full min-w-0 items-center"
		data-subagent={id}
		data-subagent-state={error !== null ? 'failed' : (reported ?? 'pending')}
	>
		<button
			type="button"
			class="flex min-h-9 min-w-0 flex-1 items-center gap-3 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none max-sm:min-h-11"
			onclick={onOpen}
		>
			{@render head()}
		</button>
		{@render stopButton()}
	</div>
{:else}
	<section
		class="grid text-sm"
		data-subagent-detail={id}
		data-subagent-state={error !== null ? 'failed' : (reported ?? 'pending')}
	>
		<header
			class="sticky top-0 z-10 flex min-h-16 min-w-0 items-center gap-3 rounded-t-2xl border-b border-border bg-background p-4"
		>
			{#if onBack !== undefined}<Button
					size="icon-sm"
					variant="ghost"
					class="-ml-1 shrink-0 text-muted-foreground"
					aria-label={t('Back to subagents')}
					onclick={onBack}
					data-rail-back><Icon name="lucide:arrow-left" class="size-4" /></Button
				>{/if}
			<AgentAvatar {id} class="size-6" />
			<span class="min-w-0 flex-1 truncate font-medium" title={task}
				>{task.split('\n')[0] || t('Sub-agent')}</span
			>
			{#if model}<span class="max-w-[40%] truncate text-xs text-muted-foreground" title={model}
					>{model}</span
				>{/if}
			{@render stopButton()}
			{#if control !== undefined && reported === 'stopped'}<Button
					size="sm"
					variant="ghost"
					class="shrink-0 px-2"
					onclick={() => toggle(false)}
					data-subagent-resume><Icon name="lucide:play" class="size-3.5" />{t('Resume')}</Button
				>{/if}
		</header>
		<div class="grid gap-5 p-4">
			{#if error !== null}<p role="alert" class="text-destructive">{error}</p>{/if}
			<p class="border-b border-border pb-4 text-muted-foreground" data-subagent-elapsed>
				{#if reported === 'running' && Number.isFinite(startedAt)}
					{t('Working for')} <span class="tabular-nums">{elapsedText(now - startedAt)}</span>
				{:else}{error !== null
						? t('Failed')
						: reported === null
							? t('Loading…')
							: t(LABEL[status])}{/if}
			</p>
			{#if task !== ''}<details class="group/task text-xs" data-subagent-task>
					<summary
						class="flex cursor-pointer list-none items-center gap-2 text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [&::-webkit-details-marker]:hidden"
					>
						{t('Task')}<Icon
							name="lucide:chevron-right"
							class="size-3 transition-transform group-open/task:rotate-90"
						/>
					</summary>
					<p class="pt-2 whitespace-pre-wrap text-muted-foreground">{task}</p>
				</details>{/if}
			{#if goals.length > 0}
				<ol class="grid gap-1" aria-label={t('Goal steps')} data-subagent-goals>
					{#each goals as g (g.id)}
						<li class="flex min-w-0 items-start gap-2" data-goal={g.status}>
							{#if g.status === 'doing' && status === 'running'}<Spinner
									class="mt-0.5 size-3.5 shrink-0"
									label={t('In progress')}
								/>
							{:else}<Icon
									name={g.status === 'done' ? 'lucide:circle-check' : 'lucide:circle-dashed'}
									class="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
								/>{/if}
							<span class="min-w-0 {g.status === 'pending' ? 'text-muted-foreground' : ''}"
								>{g.text}</span
							>
						</li>
					{/each}
				</ol>
			{/if}
			{#if steps.length > 0}<Steps {steps} {t} activity />{/if}
			{#if changes.length > 0}
				<!-- what it changed in the workspace -->
				<ul class="grid gap-1" data-subagent-changes>
					{#each changes as c, i (i)}
						<li class="flex min-w-0 items-center gap-2" data-change={c.outcome}>
							<Icon
								name={c.outcome === 'committed' ? 'lucide:square-pen' : 'lucide:clock'}
								class="size-3.5 shrink-0 text-muted-foreground"
							/>
							<span class="min-w-0 flex-1 truncate">{callableWords(c.callable)}</span>
							{#if c.outcome !== 'committed'}<span class="text-muted-foreground"
									>{t('Awaiting approval')}</span
								>{/if}
						</li>
					{/each}
				</ul>
			{/if}
			<!-- the files it made -->
			{#if made.length > 0}<MadeFiles
					files={made}
					fileHref={(id) => bolt.fileUrl({ id })}
					{t}
				/>{/if}
			<!-- its exchange with the delegating agent: a question it stopped on, the answer it got, then its own answer -->
			{#each thread as r (r.id)}
				{#if r.role === 'user'}
					<div class="grid gap-0.5 border-l-2 border-border pl-2" data-subagent-message>
						<span class="font-medium text-muted-foreground">{t('Main agent')}</span>
						<p class="whitespace-pre-wrap">{r.text}</p>
					</div>
				{:else if r.asked === true}
					<div
						class="grid gap-0.5 rounded-md border border-border bg-muted/40 px-2 py-1.5"
						data-subagent-question
					>
						<span class="flex items-center gap-1 font-medium"
							><Icon name="lucide:message-circle-question" class="size-3.5" />{t(
								'Asks the main agent'
							)}</span
						>
						<p class="whitespace-pre-wrap">{r.text}</p>
					</div>
				{:else}
					<div class="text-sm" data-subagent-answer><ReadonlyMarkdown value={r.text ?? ''} /></div>
				{/if}
			{/each}
		</div>
	</section>
{/if}
