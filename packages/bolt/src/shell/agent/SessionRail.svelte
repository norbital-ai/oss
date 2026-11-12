<script lang="ts">
	import { Effect, Stream } from 'effect';
	import { observe as liveEdge } from '@norbital-ai/ui/effect';
	import { Button, Icon, Progress } from '@norbital-ai/ui';
	import { tick, type Snippet } from 'svelte';
	import { SvelteMap } from 'svelte/reactivity';
	import type { TransitionConfig } from 'svelte/transition';
	import { watch } from 'runed';
	import { humanise, usd } from '../i18n.ts';
	import type { AgentRow } from '../../protocol/wire.ts';
	import type { RunView } from '../../engine/runs/rows.ts';
	import { RunsReadAnswer, type ShellApi } from '../api-types.ts';
	import type { ShellBolt } from '../runtime.ts';
	import AgentChild from './AgentChild.svelte';
	import Attachments from './Attachments.svelte';
	import { background, callableWords, childStatus, ORB, runState } from './view.ts';
	import { context_meter, token_count as k } from './usage.ts';
	let { rail, rail_el = $bindable(null), focus = $bindable(null), navigating = $bindable(false), conversation, rows, inputs, outputs,
		thread, automation, attached_count, meter, model, model_label, connectors, bolt, api,
		control, dispatch, on_close, on_attach, on_create_file, motion, file_href, t }: {
		rail: boolean;
		rail_el?: HTMLElement | null;
		focus?: string | null;
		navigating?: boolean;
		conversation: string | null;
		rows: readonly AgentRow[];
		inputs: NonNullable<AgentRow['files']>;
		outputs: NonNullable<AgentRow['files']>;
		thread: boolean;
		automation: boolean;
		attached_count: number;
		meter: ReturnType<typeof context_meter>;
		model: string | null;
		model_label: string;
		connectors: readonly { name: string; description: string }[];
		bolt: Pick<ShellBolt, 'observe' | 'file_url'>;
		api: Pick<ShellApi, 'stop_run'>;
		control: (id: string, stop: boolean, refused: () => void) => void;
		dispatch: (work: Effect.Effect<void, { readonly message: string }>) => void;
		on_close: () => void;
		on_attach: () => void;
		on_create_file: () => void;
		motion: (node: HTMLElement, options: { x: number; duration: number }) => TransitionConfig;
		file_href: (id: string) => string;
		t: (key: string) => string;
	} = $props();
	async function openChild(id: string): Promise<void> {
		navigating = true;
		focus = id;
		await tick();
		rail_el?.querySelector<HTMLButtonElement>('[data-rail-back]')?.focus({ preventScroll: true });
	}
	async function backToChildren(): Promise<void> {
		navigating = true;
		const id = focus;
		focus = null;
		await tick();
		const child = [...(rail_el?.querySelectorAll<HTMLElement>('[data-subagent]') ?? [])].find(
			(row) => row.dataset['subagent'] === id
		);
		child?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
	}
	// the session rail: what this conversation changed, and the work it left running (its sub-agents and automation runs)
	const changes = $derived(rows.flatMap((r) => r.receipts ?? []));
	const tasks = $derived(background(rows));
	const children = $derived(tasks.filter((task) => task.kind === 'agent'));
	const childStates = new SvelteMap<string, ReturnType<typeof childStatus> | null>();
	let showCompleted = $state(false);
	const childrenLoading = $derived(children.every((child) => childStates.get(child.id) == null));
	const workingChildren = $derived(
		children.filter((child) => childStates.get(child.id) === 'running')
	);
	const doneChildren = $derived(children.filter((child) => childStates.get(child.id) === 'done'));
	// Keyed rows move into the completed group without restarting their live reads.
	const orderedChildren = $derived([
		...children.filter((child) => childStates.get(child.id) !== 'done'),
		...doneChildren
	]);
	function childState(id: string, state: ReturnType<typeof childStatus> | null): void {
		const focused = rail_el?.ownerDocument.activeElement;
		const foldingFocused =
			state === 'done' &&
			!showCompleted &&
			focused?.closest('[data-subagent]')?.getAttribute('data-subagent') === id;
		childStates.set(id, state);
		if (foldingFocused)
			void tick().then(() =>
				rail_el?.querySelector<HTMLButtonElement>('[data-subagent-completed-toggle]')?.focus()
			);
	}
	watch(
		() => conversation,
		() => {
			showCompleted = false;
			childStates.clear();
		}
	);
	/** The runs' ids as one value, so a transcript patch that starts no run does not restart their read. */
	const runIds = $derived(
		tasks
			.filter((w) => w.kind === 'run')
			.map((w) => w.id)
			.join(' ')
	);
	/** The rail follows the same live runs view as the command center. */
	const runs = liveEdge(() => {
		if (!rail || runIds === '') return null;
		const streams = runIds.split(' ').map((id) =>
			bolt
				.observe({ read: { m: 'runs', a: [{ id, limit: 1 }] } }, RunsReadAnswer)
				.pipe(
					Stream.map(({ rows }) => ({ id, view: rows[0] })),
					Stream.catch(() => Stream.succeed({ id, view: undefined }))
				)
		);
		return Stream.mergeAll(streams, { concurrency: 'unbounded' }).pipe(
			Stream.scan(
				() => new Map<string, RunView>(),
				(current, { id, view }) => {
					const next = new Map(current);
					if (view === undefined) next.delete(id);
					else next.set(id, view);
					return next;
				}
			)
		);
	});
	const stop_run = (id: string) => dispatch(api.stop_run(id).pipe(Effect.asVoid));

</script>

{#snippet card(title: string, aside: string, body: Snippet, extra?: Snippet)}
	<details class="group/card min-w-0">
		<summary
			class="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-lg text-sm text-muted-foreground transition-colors duration-150 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [&::-webkit-details-marker]:hidden"
		>
			<span>{title}</span>
			<Icon
				name="lucide:chevron-right"
				class="size-3.5 transition-transform duration-150 group-open/card:rotate-90 motion-reduce:transition-none"
			/>
			<span class="flex-1"></span>
			{#if aside !== ''}<span class="shrink-0 text-xs tabular-nums">{aside}</span>{/if}
			{@render extra?.()}
		</summary>
		<div class="pt-1 pb-4 text-xs leading-5">{@render body()}</div>
	</details>
{/snippet}

{#if rail}
	<!-- One session frame: files and helpers stay visible; secondary session metadata opens in place. -->
	<aside
		bind:this={rail_el}
		transition:motion={{ x: 6, duration: 160 }}
		inert={!rail}
		class="absolute inset-y-0 right-0 z-30 flex w-full shrink-0 {focus === null
			? '@5xl:relative @5xl:w-[21rem] @5xl:border-l-0'
			: '@5xl:relative @5xl:w-[30rem] @5xl:border-l-0'} max-w-full flex-col overflow-hidden border-l border-border bg-card p-3 {!rail
			? 'pointer-events-none'
			: ''}"
		aria-label={t('Session')}
		data-agent-rail
	>
		<div class="mb-2 flex min-h-8 shrink-0 items-center justify-between gap-1 px-1">
			<p class="text-sm text-muted-foreground">{t(focus === null ? 'Session' : 'Subagents')}</p>
			<span class="flex-1"></span>
			<Button
				size="icon"
				variant="ghost"
				class="shrink-0 text-muted-foreground hover:text-foreground"
				aria-label={t('Close')}
				title={t('Close')}
				onclick={on_close}
				data-rail-close><Icon name="lucide:x" class="size-4" /></Button
			>
		</div>
		{#if focus !== null}
			<!-- one sub-agent, opened from the list: its whole live view -->
			<div
				class="min-h-0 flex-1 overflow-auto rounded-2xl border border-border bg-background"
				in:motion={{ x: 4, duration: navigating ? 120 : 0 }}
				data-rail-view="agent"
			>
				{#key focus}<AgentChild
						{bolt}
						{t}
						id={focus}
						control={control}
						on_back={backToChildren}
					/>{/key}
			</div>
		{:else}
			<div
				class="grid min-h-0 flex-1 content-start auto-rows-max divide-y divide-border overflow-auto rounded-2xl border border-border bg-background px-5 [&>section]:py-4"
				in:motion={{ x: -4, duration: navigating ? 120 : 0 }}
				data-rail-view="overview"
			>
				{#each [['Input', inputs], ['Outputs', outputs]] as const as [title, files] (title)}
					<section class="min-w-0" data-rail={title === 'Input' ? 'inputs' : 'outputs'}>
						<div class="mb-2 flex min-h-8 items-center justify-between gap-2">
							<h3 class="text-sm text-muted-foreground">{t(title)}</h3>
							{#if !thread && !automation}<Button
									size="icon"
									variant="ghost"
									class="text-muted-foreground hover:text-foreground"
									aria-label={t(title === 'Input' ? 'Attach files' : 'Create a file')}
									title={t(title === 'Input' ? 'Attach files' : 'Create a file')}
									onclick={title === 'Input' ? on_attach : on_create_file}
									data-rail-attach={title === 'Input' ? '' : undefined}
									data-rail-create={title === 'Outputs' ? '' : undefined}
									><Icon name="lucide:plus" class="size-4" /></Button
								>{:else if files.length > 0}<span class="text-xs text-muted-foreground tabular-nums"
									>{files.length}</span
								>{/if}
						</div>
						{#if files.length === 0}<p class="text-sm leading-6 text-muted-foreground">
								{t(
									title === 'Input'
										? 'Files you share appear here.'
										: 'Ask Norbius to create a file.'
								)}
							</p>
						{:else}<Attachments {files} file_href={file_href} {t} rail />{/if}
						{#if title === 'Input' && attached_count > 0}<p
								class="mt-2 text-xs text-muted-foreground"
								role="status"
							>
								{attached_count}
								{t('ready to send')}
							</p>{/if}
					</section>
				{/each}
				{#if children.length > 0}
					<section class="min-w-0" data-rail="tasks">
						<div
							class="mb-2 flex min-h-8 items-center justify-between gap-2 text-sm text-muted-foreground"
						>
							<h3>{t('Subagents')}</h3>
							<span
								class="tabular-nums"
								data-subagent-summary
								aria-live="polite"
								aria-atomic="true"
								aria-label={childrenLoading
									? t('Loading…')
									: t('{working} of {total} subagents working')
											.replace('{working}', String(workingChildren.length))
											.replace('{total}', String(children.length))}
								>{childrenLoading ? '…' : workingChildren.length}/{children.length}</span
							>
						</div>
						<ul id="agent-children" class="-mx-2 grid">
							{#each orderedChildren as child (child.id)}
								{#if child.id === doneChildren[0]?.id}
									<li class="min-w-0">
										<button
											type="button"
											class="flex min-h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none max-sm:min-h-11"
											aria-expanded={showCompleted}
											aria-controls={doneChildren.map((done) => `agent-child-${done.id}`).join(' ')}
											onclick={() => (showCompleted = !showCompleted)}
											data-subagent-completed-toggle
										>
											<Icon
												name="lucide:chevron-right"
												class="size-3.5 shrink-0 transition-transform duration-150 motion-reduce:transition-none {showCompleted
													? 'rotate-90'
													: ''}"
											/>
											{t('Completed')} <span class="tabular-nums">{doneChildren.length}</span>
										</button>
									</li>
								{/if}
								<li
									id={`agent-child-${child.id}`}
									class="min-w-0"
									data-subagent-completed={childStates.get(child.id) === 'done' ? '' : undefined}
									hidden={childStates.get(child.id) === 'done' && !showCompleted}
								>
									<AgentChild
										{bolt}
										{t}
										id={child.id}
										compact
										on_open={() => openChild(child.id)}
										on_state={(state) => childState(child.id, state)}
										control={control}
									/>
								</li>
							{/each}
						</ul>
					</section>
				{/if}
				{#if runIds !== ''}
					<section class="min-w-0" data-rail="runs">
						<h3 class="mb-2 text-sm text-muted-foreground">{t('Automations')}</h3>
						<ul class="grid gap-1">
							{#each tasks.filter((task) => task.kind === 'run') as task (task.id)}
								{@const run = runs.current?.get(task.id)}
								{@const state = run === undefined ? null : runState(run.status)}
								<li
									class="flex min-h-10 min-w-0 items-center gap-2 text-sm"
									data-run={task.id}
									data-run-state={state}
								>
									<Icon name="lucide:zap" class="size-4 shrink-0 text-muted-foreground" />
									<span class="min-w-0 flex-1 truncate" title={run?.automation}
										>{run === undefined
											? t('Automation run')
											: humanise(run.automation.replaceAll('.', ' '))}</span
									>
									<span class="shrink-0 text-xs text-muted-foreground"
										>{state === null
											? t('Loading…')
											: t(ORB[state === 'running' ? 'working' : state].label)}</span
									>
									{#if state === 'running'}<Button
											size="icon"
											variant="ghost"
											class="shrink-0 text-muted-foreground"
											aria-label={t('Stop run')}
											title={t('Stop run')}
											onclick={() => stop_run(task.id)}
											data-run-stop
											><Icon name="lucide:square" class="size-3.5 fill-current" /></Button
										>{/if}
								</li>
							{/each}
						</ul>
					</section>
				{/if}
				{#snippet contextBody()}
					<div class="grid gap-2">
						<p class="text-muted-foreground">
							{t(
								'How much of this conversation the assistant can still keep in mind. Older messages are summarized when it fills.'
							)}
						</p>
						<div class="grid gap-1">
							<div class="flex items-baseline justify-between gap-2 tabular-nums">
								<span class="text-muted-foreground">{t('Context')}</span>
								<span>{k(meter.context)} / {k(meter.window)}</span>
							</div>
							<Progress
								value={meter.percent ?? 0}
								class="h-1.5 w-full"
								aria-label={t('Context window used')}
							/>
						</div>
						<dl class="grid gap-1 tabular-nums">
							{#if model !== null}<div class="flex justify-between gap-2">
									<dt class="text-muted-foreground">{t('Model')}</dt>
									<dd class="min-w-0 truncate" data-context-model>{model_label}</dd>
								</div>{/if}
							<div class="flex justify-between gap-2">
								<dt class="text-muted-foreground">{t('Input')}</dt>
								<dd>{k(meter.input)}</dd>
							</div>
							<div class="flex justify-between gap-2 pl-3" data-context-cached>
								<dt class="text-muted-foreground">{t('from cache')}</dt>
								<dd>{k(meter.cached)}</dd>
							</div>
							<div class="flex justify-between gap-2">
								<dt class="text-muted-foreground">{t('Output')}</dt>
								<dd>{k(meter.output)}</dd>
							</div>
							<div class="flex justify-between gap-2 pl-3" data-context-reasoning>
								<dt class="text-muted-foreground">{t('reasoning')}</dt>
								<dd>{k(meter.reasoning)}</dd>
							</div>
							{#if meter.cost !== null}<div class="flex justify-between gap-2">
									<dt class="text-muted-foreground">{t('Cost')}</dt>
									<dd>{usd(meter.cost, 4)}</dd>
								</div>{/if}
						</dl>
					</div>
				{/snippet}
				{#snippet contextBar()}
					<Progress
						value={meter.percent ?? 0}
						class="h-1.5 w-10"
						aria-label={t('Context window used')}
					/>
				{/snippet}
				<div data-rail="context">
					{@render card(
						t('Context'),
						meter.percent === null ? '—' : `${Math.round(meter.percent)}%`,
						contextBody,
						contextBar
					)}
				</div>
				{#snippet changesBody()}
					<ul class="grid gap-1.5">
						{#each changes as c, i (i)}
							<li class="flex min-w-0 items-center gap-2" data-change={c.outcome}>
								<Icon
									name={c.outcome === 'committed' ? 'lucide:circle-check' : 'lucide:clock'}
									class="size-3.5 shrink-0 text-muted-foreground"
								/>
								<span class="min-w-0 flex-1 truncate">{callableWords(c.callable)}</span>
								<span class="shrink-0 text-muted-foreground"
									>{c.outcome === 'committed' ? '' : t('Awaiting approval')}</span
								>
							</li>
						{:else}<li class="text-muted-foreground">{t('Nothing changed yet.')}</li>{/each}
					</ul>
				{/snippet}
				<div data-rail="changes">
					{@render card(
						t('Changes'),
						changes.length === 0 ? '' : String(changes.length),
						changesBody
					)}
				</div>
				{#if connectors.length > 0}
					{#snippet connectorsBody()}
						<ul class="grid gap-1.5">
							{#each connectors as c (c.name)}
								<li class="flex min-w-0 items-center gap-2" data-connector={c.name}>
									<span class="size-1.5 shrink-0 rounded-full bg-success"></span>
									<span class="min-w-0 flex-1 truncate">{humanise(c.name)}</span>
									{#if c.description !== ''}<span class="min-w-0 truncate text-muted-foreground"
											>{c.description}</span
										>{/if}
								</li>
							{/each}
						</ul>
					{/snippet}
					<div data-rail="connectors">
						{@render card(
							t('Connectors'),
							`${connectors.length} ${t('connected')}`,
							connectorsBody
						)}
					</div>
				{/if}
			</div>
		{/if}
	</aside>
{/if}

<style>
	[data-agent-rail] details[open] > :not(summary) { animation: rail-card-in 150ms var(--ease-out, ease-out); }
	[data-subagent-completed]:not([hidden]) { animation: rail-card-in 120ms var(--ease-out, ease-out); }
	@keyframes rail-card-in { from { opacity: 0; transform: translateY(-2px); } }
	@media (prefers-reduced-motion: reduce) {
		[data-agent-rail] details[open] > :not(summary), [data-subagent-completed]:not([hidden]) { animation: none; }
	}
</style>
