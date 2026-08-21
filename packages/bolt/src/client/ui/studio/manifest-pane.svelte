<script module lang="ts">
	import { FEATURE_COLOR_STYLES } from '@norbital-ai/ui/feature-colors';

	// Constant lookups into a frozen table: per-module, and not computations to make reactive.
	const AUTOMATION_STYLES = FEATURE_COLOR_STYLES.automations;
	const REMOTE_STYLES = FEATURE_COLOR_STYLES.applications;
	/**
	 * What a manual run of each automation is doing, keyed by automation name.
	 *
	 * An automation otherwise only runs on its own schedule, which for the field-operations
	 * reconciliation is `0 2 * * *` — so a workspace reset at any other hour shows unreconciled data
	 * for the rest of the day with no way to ask for the work. The runtime already had the command;
	 * what was missing was somebody able to press it.
	 *
	 * `automations.start` declares `subject` in its input schema, and the client deliberately does not
	 * send one: the invocation boundary overwrites `subject` from the credential on every command
	 * before any case reads it, which is what `MINTED_IDENTITY` is for. A run therefore happens as the
	 * person who pressed the button and cannot be made to happen as anybody else.
	 */
	type AutomationRun = Readonly<{
		readonly state: 'starting' | 'running' | 'done' | 'failed';
		readonly taskId?: string;
		readonly detail?: string;
		readonly at: number;
	}>;
	let runs = $state<Record<string, AutomationRun>>({});

	/**
	 * What each automation has actually been doing, read from the queue rather than remembered here.
	 *
	 * `runs` above knows only what this session pressed. That is the wrong answer to "has this run" —
	 * a scheduled run at 2am is exactly the one somebody is looking for, and no browser was open for
	 * it. `automations.history` reads the task rows, so an empty list means the automation has never
	 * run rather than that nobody watched.
	 */
	type AutomationRunRow = Readonly<{
		readonly effect_id?: string;
		readonly status?: string;
		readonly attempts?: number;
		readonly error?: string | null;
		readonly created_at?: string;
	}>;
	let history = $state<Record<string, ReadonlyArray<AutomationRunRow>>>({});
	let historyLoaded = $state<Record<string, boolean>>({});

	const loadHistory = async (name: string): Promise<void> => {
		try {
			const answer = (await workspaceSession().transport.command('automations.history', {
				name,
				limit: 10
			})) as { readonly runs?: ReadonlyArray<AutomationRunRow> } | null;
			history = { ...history, [name]: answer?.runs ?? [] };
		} catch {
			// A history that cannot be read is left absent rather than shown as empty: "no runs" and
			// "could not ask" are different facts and an empty list would assert the first.
		}
	};

	const runAutomation = async (name: string): Promise<void> => {
		if (runs[name]?.state === 'starting' || runs[name]?.state === 'running') return;
		runs = { ...runs, [name]: { state: 'starting', at: Date.now() } };
		try {
			const started = (await workspaceSession().transport.command('automations.start', {
				name,
				input: {}
			})) as { readonly taskId?: string };
			const taskId = started?.taskId;
			runs = {
				...runs,
				[name]: { state: 'running', at: Date.now(), ...(taskId ? { taskId } : {}) }
			};
			if (taskId === undefined) return;
			// Polled rather than pushed: the runtime reports a task's state on request and nothing
			// streams it, so the surface asks until the answer stops being "running".
			for (let attempt = 0; attempt < 60; attempt += 1) {
				await new Promise((resolve) => setTimeout(resolve, 1_000));
				// `status` and not `state`: the task row's column is `status`, and the queue writes exactly
				// `done` or `failed` into it from `pending`. Reading a field the row does not have would
				// have polled sixty times and then reported a run as still going.
				const status = (await workspaceSession().transport.command('automations.status', {
					taskId
				})) as { readonly status?: string; readonly error?: string } | null;
				const settled = status?.status;
				if (settled !== 'done' && settled !== 'failed') continue;
				runs = {
					...runs,
					[name]: {
						state: settled,
						taskId,
						at: Date.now(),
						...(status?.error ? { detail: status.error } : {})
					}
				};
				await loadHistory(name);
				return;
			}
		} catch (cause) {
			runs = {
				...runs,
				[name]: {
					state: 'failed',
					at: Date.now(),
					detail: cause instanceof Error ? cause.message : String(cause)
				}
			};
		}
	};
</script>

<script lang="ts">
	import Icon from '@iconify/svelte';
	import AgentsPanel from './agents-panel.svelte';
	import CollectionDetail from './collection-detail.svelte';
	import EnvironmentPane from './environment-pane.svelte';
	import { IconWrapper } from '@norbital-ai/ui/icon-wrapper';
	import { Bound, Grid, Inline, Scroll, Stack } from '@norbital-ai/ui/layout';
	import { ProductIcon } from '@norbital-ai/ui/product-icon';
	import { cn } from '@norbital-ai/ui/utils';
	import type { WorkspaceClient } from './workspace-client.js';
	import { workspaceSession } from '../../session.js';
	import { Button } from '@norbital-ai/ui/button';
	import type {
		EnvironmentVariable,
		ManifestSection,
		StudioAgent,
		WorkspaceManifest
	} from './studio-state.js';

	/**
	 * The Manifest view's right-hand pane: one branch of the workspace, or one collection of it.
	 *
	 * Each kind is read in the shape that suits it rather than in one generic card grid — a
	 * collection is a thing you scan a wall of, a policy is a row you read a sentence of, an agent is
	 * a page. The pane never invents a landing page: selecting "Apps" shows the apps.
	 */
	let {
		manifest,
		sections = [],
		selected = 'collections',
		client,
		files = [],
		agents = [],
		environment = [],
		environmentError,
		command,
		onopenSource
	}: {
		manifest?: WorkspaceManifest | undefined;
		sections?: ReadonlyArray<ManifestSection>;
		selected?: string;
		client?: WorkspaceClient | undefined;
		/** Authored source paths; the agent's tool names are only legible from their filenames. */
		files?: ReadonlyArray<string>;
		agents?: ReadonlyArray<StudioAgent>;
		environment?: ReadonlyArray<EnvironmentVariable>;
		environmentError?: string | undefined;
		command: (name: string, input: Readonly<Record<string, string>>) => Promise<unknown>;
		onopenSource?: ((path: string) => void) | undefined;
	} = $props();

	/**
	 * Loaded once per automation, from an effect rather than from the template.
	 *
	 * Reading it inside the markup would fire during render and again on every state change the read
	 * itself caused — the shape of an infinite loop, and one that would look like a slow panel rather
	 * than like a bug. `historyLoaded` is the guard, so a failed read is not retried forever either.
	 */
	$effect(() => {
		for (const automation of manifest?.automations ?? []) {
			if (historyLoaded[automation.name] === true) continue;
			historyLoaded = { ...historyLoaded, [automation.name]: true };
			void loadHistory(automation.name);
		}
	});

	const kind = $derived(selected.split(':')[0] ?? 'collections');
	const name = $derived(selected.slice(kind.length + 1));
	const section = $derived(sections.find((candidate) => candidate.id === kind));
	const collection = $derived(
		kind === 'collections' ? manifest?.collections.find((item) => item.name === name) : undefined
	);
</script>

<!--
	A branch heading wears the feature's own colour chip where the product gives that kind one, and a
	plain glyph where it does not. Automations and Remotes carry a chip everywhere else they appear —
	including in their own cards two lines below — so a bare grey glyph in the heading read as a
	different family of page from the card underneath it.
-->
{#snippet panelHeading(
	branch: ManifestSection,
	count: number,
	styles?: (typeof FEATURE_COLOR_STYLES)[keyof typeof FEATURE_COLOR_STYLES]
)}
	<Inline gap="sm">
		{#if styles === undefined}
			<ProductIcon name={branch.icon} class="size-4 text-muted-foreground" />
		{:else}
			<div
				class={cn(
					'flex size-6 shrink-0 items-center justify-center rounded-md border',
					styles.iconWrapperClass
				)}
			>
				<ProductIcon name={branch.icon} class={cn('size-3.5', styles.iconClass)} />
			</div>
		{/if}
		<div>
			<h2 class="text-sm font-medium text-foreground">{branch.label} ({count})</h2>
			<p class="mt-0.5 max-w-2xl text-xs leading-relaxed text-muted-foreground">{branch.summary}</p>
		</div>
	</Inline>
{/snippet}

{#snippet emptyBranch(branch: ManifestSection, label: string)}
	<Stack gap="sm" align="center" justify="center" class="py-12 text-muted-foreground">
		<ProductIcon name={branch.icon} class="size-8 opacity-30" />
		<p class="text-xs">{label}</p>
	</Stack>
{/snippet}

{#snippet sourceLink(path: string)}
	<button
		type="button"
		class="flex items-center gap-1 text-micro text-brand hover:underline"
		onclick={() => onopenSource?.(path)}
	>
		<Icon icon="lucide:arrow-right-circle" class="size-3" />
		View source
	</button>
{/snippet}

{#snippet collectionsPanel(branch: ManifestSection, workspace: WorkspaceManifest)}
	<Scroll name="Collections panel" class="p-4 sm:p-6">
		<Stack gap="md">
			{@render panelHeading(branch, workspace.collections.length)}

			{#if workspace.collections.length === 0}
				{@render emptyBranch(branch, 'No collections declared')}
			{:else}
				<Grid minimum="card" gap="sm">
					{#each workspace.collections as entry (entry.name)}
						{@const hooks = entry.hooks?.length ?? 0}
						<Stack gap="sm" class="rounded-lg border border-border/60 bg-card p-4 shadow-card">
							<Inline gap="sm">
								<IconWrapper
									name={entry.icon ?? 'lucide:box'}
									class="size-4 shrink-0 text-muted-foreground"
								/>
								<span class="truncate font-mono text-xs font-normal text-foreground">
									{entry.name}
								</span>
								{#if entry.history}
									<span
										class="shrink-0 rounded-full bg-brand-100 px-1.5 py-px text-tiny font-semibold text-brand-700"
									>
										Versioned
									</span>
								{/if}
							</Inline>

							{#if entry.description}
								<p class="text-meta">{entry.description}</p>
							{/if}

							<Stack gap="xs" class="mt-auto text-micro text-muted-foreground">
								<Inline gap="xs">
									<ProductIcon name="models" class="size-3" />
									<span>{entry.fields.length} field{entry.fields.length === 1 ? '' : 's'}</span>
								</Inline>
								{#if hooks > 0}
									<Inline gap="xs">
										<ProductIcon name="hooks" class="size-3" />
										<span>{hooks} hook{hooks === 1 ? '' : 's'}</span>
									</Inline>
								{/if}
								{#if entry.relations.length > 0}
									<Inline gap="xs">
										<ProductIcon name="relations" class="size-3" />
										<span>
											{entry.relations.length} relation{entry.relations.length === 1 ? '' : 's'}
										</span>
									</Inline>
								{/if}
							</Stack>

							{#if entry.sourcePath !== undefined}
								{@render sourceLink(entry.sourcePath)}
							{/if}
						</Stack>
					{/each}
				</Grid>
			{/if}
		</Stack>
	</Scroll>
{/snippet}

{#snippet appsPanel(branch: ManifestSection, workspace: WorkspaceManifest)}
	<Scroll name="Apps panel" class="p-4 sm:p-6">
		<Stack gap="md">
			{@render panelHeading(branch, workspace.apps.length)}

			{#if workspace.apps.length === 0}
				{@render emptyBranch(branch, 'No apps defined')}
			{:else}
				<Grid minimum="card" gap="sm">
					{#each workspace.apps as app (app.name)}
						<Stack gap="sm" class="rounded-lg border border-border/60 bg-card p-4 shadow-card">
							<Inline gap="sm">
								<IconWrapper name="product:apps" class="size-4 text-muted-foreground" />
								<span class="truncate text-sm font-semibold text-foreground">{app.name}</span>
							</Inline>
							<p class="text-meta">
								{app.label === '' || app.label === app.name ? `/app/${app.name}` : app.label}
							</p>
						</Stack>
					{/each}
				</Grid>
			{/if}
		</Stack>
	</Scroll>
{/snippet}

{#snippet policiesPanel(branch: ManifestSection, workspace: WorkspaceManifest)}
	<Scroll name="Policies panel" class="p-4 sm:p-6">
		<Stack gap="md">
			{@render panelHeading(branch, workspace.policies.length)}

			{#if workspace.policies.length === 0}
				{@render emptyBranch(branch, 'No policies declared')}
			{:else}
				<Bound clip class="rounded-lg border border-border/60 bg-card">
					<Stack gap="none">
						{#each workspace.policies as policy (policy.name)}
							{@const path = `src/policies/+${policy.name}.policy.ts`}
							<Inline align="start" gap="md" class="border-b border-border/60 p-4 last:border-b-0">
								<ProductIcon name="policies" class="mt-0.5 size-4 shrink-0 text-muted-foreground" />
								<Stack gap="xs" grow>
									<Inline gap="sm">
										<h3 class="text-xs font-semibold text-foreground">{policy.name}</h3>
										<code class="text-micro text-muted-foreground">{path}</code>
									</Inline>
									<p class="text-micro text-muted-foreground">
										{policy.grants} grant{policy.grants === 1 ? '' : 's'}
									</p>
								</Stack>
								<!-- Offered only when the host is holding that file. The path is derived from the
								     naming convention the compiler enforces rather than read back from the manifest,
								     so an unconditional link would sometimes open an editor on nothing. -->
								{#if files.includes(path)}
									{@render sourceLink(path)}
								{/if}
							</Inline>
						{/each}
					</Stack>
				</Bound>
			{/if}
		</Stack>
	</Scroll>
{/snippet}

{#snippet automationsPanel(branch: ManifestSection, workspace: WorkspaceManifest)}
	<Scroll name="Automations panel" class="p-4 sm:p-6">
		<Stack gap="md">
			{@render panelHeading(branch, workspace.automations.length, AUTOMATION_STYLES)}

			{#if workspace.automations.length === 0}
				{@render emptyBranch(branch, 'No automations defined')}
			{:else}
				<Stack gap="sm">
					{#each workspace.automations as automation (automation.name)}
						{@const path = `src/automation/+${automation.name}.ts`}
						<Stack gap="sm" class="rounded-lg border border-border/60 bg-card p-4 shadow-card">
							<Inline align="start" justify="between" gap="sm">
								<Inline gap="sm" class="min-w-0">
									<div
										class={cn(
											'flex size-6 shrink-0 items-center justify-center rounded-md border',
											AUTOMATION_STYLES.iconWrapperClass
										)}
									>
										<ProductIcon
											name="automations"
											class={cn('size-3.5', AUTOMATION_STYLES.iconClass)}
										/>
									</div>
									<div class="min-w-0">
										<p class="truncate font-mono text-sm font-semibold text-foreground">
											{automation.name}
										</p>
									</div>
								</Inline>
								<Inline gap="sm" shrink={false}>
									<span
										class="rounded-full bg-emerald-100 px-2 py-0.5 text-tiny font-semibold text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300"
									>
										Declared
									</span>
									<Button
										size="sm"
										variant="outline"
										disabled={runs[automation.name]?.state === 'starting' ||
											runs[automation.name]?.state === 'running'}
										onclick={() => void runAutomation(automation.name)}
									>
										{runs[automation.name]?.state === 'starting' ||
										runs[automation.name]?.state === 'running'
											? 'Running…'
											: 'Run now'}
									</Button>
									{#if files.includes(path)}
										{@render sourceLink(path)}
									{/if}
								</Inline>
							</Inline>
							<p class="font-mono text-micro text-muted-foreground">{path}</p>
							{#if historyLoaded[automation.name] && history[automation.name] !== undefined}
								{@const rows = history[automation.name] ?? []}
								{#if rows.length === 0}
									<p class="text-micro text-muted-foreground">
										No runs recorded. This automation has not run on its schedule or by hand.
									</p>
								{:else}
									<Stack gap="xs" class="border-t border-border/60 pt-2">
										<p class="text-micro font-semibold text-muted-foreground">Recent runs</p>
										{#each rows as row (row.effect_id ?? row.created_at)}
											<Inline gap="sm" align="center" class="min-w-0">
												<span
													class={cn(
														'shrink-0 rounded-full px-1.5 py-0.5 text-micro font-semibold',
														row.status === 'failed'
															? 'bg-destructive/10 text-destructive'
															: row.status === 'done'
																? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-300'
																: 'bg-muted text-muted-foreground'
													)}>{row.status ?? 'pending'}</span
												>
												<span class="shrink-0 text-micro text-muted-foreground">
													{row.created_at
														? new Date(row.created_at).toLocaleString()
														: 'unknown time'}
												</span>
												{#if (row.attempts ?? 0) > 1}
													<span class="shrink-0 text-micro text-muted-foreground"
														>· {row.attempts} attempts</span
													>
												{/if}
												{#if row.error}
													<span class="min-w-0 truncate text-micro text-destructive"
														>· {row.error}</span
													>
												{/if}
											</Inline>
										{/each}
									</Stack>
								{/if}
							{/if}
							{#if runs[automation.name]}
								{@const run = runs[automation.name]}
								<!--
									The last run this session started, and what came of it.

									Deliberately says nothing about runs it did not start: the runtime reports a task
									by id and there is no history endpoint to read, so a panel claiming to be a log
									would be asserting a completeness it cannot have. "Nothing shown" here means
									"nothing pressed here", not "nothing has run".
								-->
								<p
									class={cn(
										'text-micro',
										run.state === 'failed' ? 'text-destructive' : 'text-muted-foreground'
									)}
								>
									{run.state === 'starting'
										? 'Starting…'
										: run.state === 'running'
											? `Running${run.taskId ? ` · task ${run.taskId.slice(0, 8)}` : ''}`
											: run.state === 'done'
												? `Finished at ${new Date(run.at).toLocaleTimeString()}`
												: `Failed: ${run.detail ?? 'the host reported no reason'}`}
								</p>
							{/if}
						</Stack>
					{/each}
				</Stack>
			{/if}
		</Stack>
	</Scroll>
{/snippet}

{#snippet remotesPanel(branch: ManifestSection)}
	<Scroll name="Remotes panel" class="p-4 sm:p-6">
		<Stack gap="md">
			{@render panelHeading(branch, 0, REMOTE_STYLES)}
			{@render emptyBranch(branch, 'No remotes declared')}
		</Stack>
	</Scroll>
{/snippet}

{#if manifest === undefined}
	<Stack gap="sm" fill align="center" justify="center" class="px-6 text-muted-foreground">
		<Icon icon="lucide:file-json" class="size-10 opacity-40" />
		<p class="text-sm font-medium text-foreground">No workspace manifest</p>
		<p class="max-w-sm text-center text-xs leading-relaxed">
			The tenant runtime answers for its own manifest, so this is what a workspace that is not
			routed, not built, or not readable by you looks like.
		</p>
	</Stack>
{:else if collection !== undefined}
	<CollectionDetail {collection} {manifest} {client} {onopenSource} />
{:else if section === undefined}
	<Stack gap="sm" fill align="center" justify="center" class="px-6 text-muted-foreground">
		<Icon icon="lucide:list-tree" class="size-10 opacity-40" />
		<p class="text-sm font-medium text-foreground">Nothing selected</p>
		<p class="max-w-sm text-center text-xs leading-relaxed">Choose a branch on the left.</p>
	</Stack>
{:else if kind === 'agents'}
	<AgentsPanel {agents} {command} {onopenSource} />
{:else if kind === 'environment'}
	<EnvironmentPane {section} entries={environment} failure={environmentError} />
{:else if kind === 'apps'}
	{@render appsPanel(section, manifest)}
{:else if kind === 'policies'}
	{@render policiesPanel(section, manifest)}
{:else if kind === 'automations'}
	{@render automationsPanel(section, manifest)}
{:else if kind === 'remotes'}
	{@render remotesPanel(section)}
{:else}
	{@render collectionsPanel(section, manifest)}
{/if}
