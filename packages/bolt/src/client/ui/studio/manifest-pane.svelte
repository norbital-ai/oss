<script lang="ts">
	import { Clock, Effect } from 'effect';
	import { FEATURE_COLOR_STYLES } from '@norbital-ai/ui/feature-colors';
	import type { SystemClientApi } from '#lib/client/system-client.js';

	const automationStyles = $derived(FEATURE_COLOR_STYLES.automations);
	const remoteStyles = $derived(FEATURE_COLOR_STYLES.applications);
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
		readonly state: 'starting' | 'running' | 'failed';
		readonly taskId?: string;
		readonly detail?: string;
		readonly at: number;
	}>;
	let runs = $state<Record<string, AutomationRun>>({});

	const runAutomation = (name: string): Effect.Effect<void> => {
		return Effect.gen(function* () {
			const existing = visibleRun(name);
			if (existing?.state === 'starting' || existing?.state === 'running') return;
			runs = { ...runs, [name]: { state: 'starting', at: yield* Clock.currentTimeMillis } };
			const started = yield* system.automations.start({ name, input: {} });
			const taskId = started.taskId;
			runs = {
				...runs,
				[name]: {
					state: 'running',
					at: yield* Clock.currentTimeMillis,
					...(taskId ? { taskId } : {})
				}
			};
			if (taskId === undefined) return;
		}).pipe(
			Effect.catch((cause) =>
				Effect.gen(function* () {
					runs = {
						...runs,
						[name]: {
							state: 'failed',
							at: yield* Clock.currentTimeMillis,
							detail: cause instanceof Error ? cause.message : String(cause)
						}
					};
				})
			)
		);
	};
	import Icon from '@iconify/svelte';
	import EnvoysPanel from './envoys-panel.svelte';
	import CollectionDetail from './collection-detail.svelte';
	import EnvironmentPane from './environment-pane.svelte';
	import { IconWrapper } from '@norbital-ai/ui/icon-wrapper';
	import { Bound, Grid, Inline, Scroll, Stack } from '@norbital-ai/ui/layout';
	import { ProductIcon } from '@norbital-ai/ui/product-icon';
	import { cn } from '@norbital-ai/ui/utils';
	import type { WorkspaceClient } from '#lib/client/ui/studio/workspace-client.js';
	import { Button } from '@norbital-ai/ui/button';
	import type {
		EnvironmentVariable,
		ManifestSection,
		StudioEnvoy,
		StudioTool,
		WorkspaceManifest
	} from '#lib/client/ui/studio/studio-state.js';

	/**
	 * The Manifest view's right-hand pane: one branch of the workspace, or one collection of it.
	 *
	 * Each kind is read in the shape that suits it rather than in one generic card grid — a
	 * collection is a thing you scan a wall of, a policy is a row you read a sentence of, an envoy is
	 * a page. The pane never invents a landing page: selecting "Apps" shows the apps.
	 */
	let {
		manifest,
		sections = [],
		selected = 'collections',
		client,
		files = [],
		envoys = [],
		tools = [],
		environment = [],
		environmentError,
		system,
		onopenSource
	}: {
		manifest?: WorkspaceManifest | undefined;
		sections?: ReadonlyArray<ManifestSection>;
		selected?: string;
		client?: WorkspaceClient | undefined;
		/** Authored source paths; a tool's name is only legible from its filename. */
		files?: ReadonlyArray<string>;
		envoys?: ReadonlyArray<StudioEnvoy>;
		tools?: ReadonlyArray<StudioTool>;
		environment?: ReadonlyArray<EnvironmentVariable>;
		environmentError?: string | undefined;
		system: SystemClientApi;
		onopenSource?: ((path: string) => void) | undefined;
	} = $props();

	const historyQueries = $derived(
		typeof window !== 'undefined'
			? (manifest?.automations ?? []).map((automation) => ({
					name: automation.name,
					query: system.automations.history({ name: automation.name, limit: 10 })
				}))
			: []
	);
	const historyQuery = (automation: string) =>
		historyQueries.find(({ name }) => name === automation)?.query;
	const statusQueries = $derived(
		Object.entries(runs).flatMap(([name, run]) =>
			run.state === 'running' && run.taskId !== undefined
				? [{ name, taskId: run.taskId, query: system.automations.status({ taskId: run.taskId }) }]
				: []
		)
	);
	const statusQuery = (automation: string) =>
		statusQueries.find(({ name }) => name === automation)?.query;
	const visibleRun = (automation: string) => {
		const run = runs[automation];
		if (run === undefined) return undefined;
		const query = statusQuery(automation);
		if (query?.error !== undefined)
			return {
				...run,
				state: 'failed' as const,
				detail: query.error instanceof Error ? query.error.message : String(query.error)
			};
		const status = query?.current;
		if (status?.status === 'done' || status?.status === 'failed')
			return {
				...run,
				state: status.status,
				...(status.error === undefined ? {} : { detail: status.error })
			};
		return run;
	};

	$effect(() => {
		const active = statusQueries.filter(({ query }) => {
			const state = query.current?.status;
			return state !== 'done' && state !== 'failed';
		});
		if (active.length === 0) return;
		const timer = setInterval(() => {
			for (const { query } of active) void query.refresh();
		}, 1_000);
		return () => clearInterval(timer);
	});

	const refreshedHistory = new Set<string>();
	$effect(() => {
		for (const { name, taskId, query } of statusQueries) {
			const status = query.current?.status;
			const key = `${name}:${taskId}`;
			if ((status !== 'done' && status !== 'failed') || refreshedHistory.has(key)) continue;
			refreshedHistory.add(key);
			void historyQuery(name)?.refresh();
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
			{@render panelHeading(branch, workspace.automations.length, automationStyles)}

			{#if workspace.automations.length === 0}
				{@render emptyBranch(branch, 'No automations defined')}
			{:else}
				<Stack gap="sm">
					{#each workspace.automations as automation (automation.name)}
						{@const path = `src/automation/+${automation.name}.ts`}
						{@const run = visibleRun(automation.name)}
						{@const automationHistory = historyQuery(automation.name)}
						<Stack gap="sm" class="rounded-lg border border-border/60 bg-card p-4 shadow-card">
							<Inline align="start" justify="between" gap="sm">
								<Inline gap="sm" class="min-w-0">
									<div
										class={cn(
											'flex size-6 shrink-0 items-center justify-center rounded-md border',
											automationStyles.iconWrapperClass
										)}
									>
										<ProductIcon
											name="automations"
											class={cn('size-3.5', automationStyles.iconClass)}
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
										disabled={run?.state === 'starting' || run?.state === 'running'}
										onclick={() => void Effect.runPromise(runAutomation(automation.name))}
									>
										{run?.state === 'starting' || run?.state === 'running' ? 'Running…' : 'Run now'}
									</Button>
									{#if files.includes(path)}
										{@render sourceLink(path)}
									{/if}
								</Inline>
							</Inline>
							<p class="font-mono text-micro text-muted-foreground">{path}</p>
							{#if automationHistory?.error !== undefined}
								<p class="text-micro text-destructive">
									Run history unavailable: {automationHistory.error instanceof Error
										? automationHistory.error.message
										: String(automationHistory.error)}
								</p>
							{:else if automationHistory?.current !== undefined}
								{@const rows = automationHistory.current.runs ?? []}
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
							{#if run}
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
			{@render panelHeading(branch, 0, remoteStyles)}
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
{:else if kind === 'envoys'}
	<EnvoysPanel {envoys} {tools} {system} {onopenSource} />
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
