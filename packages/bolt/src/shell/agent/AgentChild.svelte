<!--
	A delegated sub-agent (§5.9 `subagent`), read-only, Codex's: `compact`, one line in the transcript and the session panel's
	list (its state, task, checklist and step counts) that opens it; otherwise its whole view in the session panel — its task,
	checklist, steps as they land (the panel's own `Steps`), what it changed and made, its exchange with the delegating agent
	(a question it stopped on, the answer it got) and its answer. Sub-agents run detached and several at once; one spawns
	none of its own, so nothing nests. It reads the child as the panel reads its own conversation: a live transcript whose
	streaming and running rows say it works.
-->
<script lang="ts">
	import { live } from '@norbital-ai/ui/effect';
	import { Option, Schema } from 'effect';
	import { Button, Icon, ReadonlyMarkdown, Spinner } from '@norbital-ai/ui';
	import type { FileRef } from '../../decl/values.ts';
	import type { AgentRow } from '../../protocol/wire.ts';
	import type { ShellBolt } from '../runtime.ts';
	import Steps from './Steps.svelte';
	import { callableWords, childStatus } from './view.ts';

	let {
		bolt,
		t,
		id,
		compact = false,
		onOpen,
		control
	}: {
		bolt: Pick<ShellBolt, 'live' | 'fileUrl'>;
		t: (key: string) => string;
		id: string;
		/** One line that opens the sub-agent (`onOpen`), instead of its whole view. */
		compact?: boolean;
		onOpen?: () => void;
		/** Stops a running sub-agent, or resumes a stopped one (its own conversation's stop and resume), calling `refused` when it did not; absent, it has neither. */
		control?: (id: string, stop: boolean, refused: () => void) => void;
	} = $props();

	const transcript = live(() =>
		bolt.live<{ rows: AgentRow[]; status?: 'idle' | 'running' | 'stopped' }>({
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
		running: 'Working…',
		asking: 'Waiting for an answer',
		stopped: 'Stopped',
		failed: 'Failed',
		done: 'Done'
	} as const;
	const TONE = {
		running: 'text-muted-foreground',
		asking: 'text-warning',
		stopped: 'text-muted-foreground',
		failed: 'text-destructive',
		done: 'text-success'
	} as const;
	/** A stop asked for and not yet seen: the button holds until the status says so, or the stop is refused. */
	let stopping = $state(false);
	const toggle = (stop: boolean) => {
		stopping = stop;
		control?.(id, stop, () => (stopping = false));
	};
</script>

{#snippet stopButton()}
	{#if control !== undefined && status === 'running'}<Button
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
	{#if status === 'running'}<Spinner label={t('Working…')} class="size-3.5 shrink-0" />
	{:else}<Icon
			name={status === 'failed'
				? 'lucide:circle-alert'
				: status === 'asking'
					? 'lucide:message-circle-question'
					: status === 'done'
						? 'lucide:circle-check'
						: 'lucide:circle-stop'}
			class="size-3.5 shrink-0 {TONE[status]}"
		/>{/if}
	<span class="min-w-0 flex-1 truncate" title={task}>{task.split('\n')[0] || t('Sub-agent')}</span>
	<span class="shrink-0 text-muted-foreground tabular-nums"
		>{goals.length > 0
			? `${goals.filter((g) => g.status === 'done').length}/${goals.length} · `
			: ''}{steps.length > 0
			? `${steps.length} ${t(steps.length === 1 ? 'step' : 'steps')} · `
			: ''}{t(LABEL[status])}</span
	>
{/snippet}

{#if compact}
	<!-- one line that opens it; a running one's Stop sits beside it (a button cannot hold another) -->
	<div
		class="flex w-full min-w-0 animate-in items-center rounded-lg border border-border/70 bg-background fade-in-0 slide-in-from-bottom-1 animation-duration-150 ease-out motion-reduce:animate-none"
		data-subagent={id}
		data-subagent-state={status}
	>
		<button
			type="button"
			class="flex min-h-8 min-w-0 flex-1 items-center gap-2 rounded-lg px-3 py-2 text-left text-xs transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
			onclick={onOpen}
		>
			{@render head()}
			<Icon name="lucide:chevron-right" class="size-3 shrink-0 text-muted-foreground" />
		</button>
		{@render stopButton()}
	</div>
{:else}
	<section
		class="grid animate-in gap-3 text-xs fade-in-0 slide-in-from-right-2 animation-duration-150 ease-out motion-reduce:animate-none"
		data-subagent-detail={id}
		data-subagent-state={status}
	>
		<div class="flex min-h-8 min-w-0 items-center gap-2 text-sm font-medium">
			{@render head()}
			{@render stopButton()}
			{#if control !== undefined && status === 'stopped'}<Button
					size="sm"
					variant="ghost"
					class="shrink-0 px-2"
					onclick={() => toggle(false)}
					data-subagent-resume><Icon name="lucide:play" class="size-3.5" />{t('Resume')}</Button
				>{/if}
		</div>
		{#if error !== null}<p role="alert" class="text-destructive">{error}</p>{/if}
		{#if task !== ''}<p class="whitespace-pre-wrap text-muted-foreground" data-subagent-task>
				{task}
			</p>{/if}
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
		{#if steps.length > 0}<Steps {steps} {t} />{/if}
		{#if changes.length > 0 || made.length > 0}
			<!-- what it changed in the workspace and the files it made -->
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
				{#each made as f, i (i)}
					<li>
						<a
							class="inline-flex max-w-full items-center gap-2 underline-offset-2 hover:underline"
							href={f.id === undefined ? undefined : bolt.fileUrl({ id: f.id } as FileRef)}
							target="_blank"
							rel="noreferrer"
							download={f.name}
							><Icon name="lucide:download" class="size-3.5 shrink-0 text-muted-foreground" /><span
								class="truncate">{f.name}</span
							></a
						>
					</li>
				{/each}
			</ul>
		{/if}
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
	</section>
{/if}
