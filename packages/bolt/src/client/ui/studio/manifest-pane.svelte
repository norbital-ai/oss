<script lang="ts">
	import { FEATURE_COLOR_STYLES } from '@norbital-ai/ui/feature-colors';
	import type { SystemClientApi } from '#lib/client/system-client.js';
	import Icon from '@iconify/svelte';
	import EnvoysPanel from './envoys-panel.svelte';
	import CollectionDetail from './collection-detail.svelte';
	import EnvironmentPane from './environment-pane.svelte';
	import { IconWrapper } from '@norbital-ai/ui/icon-wrapper';
	import { Cluster, Frame, Grid, Inline, Scroll, Stack } from '@norbital-ai/ui/layout';
	import { ProductIcon } from '@norbital-ai/ui/product-icon';
	import { cn } from '@norbital-ai/ui/utils';
	import { Button } from '@norbital-ai/ui/button';
	import type {
		EnvironmentVariable,
		ManifestSection,
		StudioEnvoy,
		StudioTool,
		WorkspaceManifest
	} from '#lib/client/ui/studio/studio-state.js';

	const automationStyles = $derived(FEATURE_COLOR_STYLES.automations);
	const remoteStyles = $derived(FEATURE_COLOR_STYLES.applications);

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
		files = [],
		envoys = [],
		tools = [],
		environment = [],
		environmentError,
		system,
		onopenSource,
		onviewRuns,
		onconfigureEnvoys
	}: {
		manifest?: WorkspaceManifest | undefined;
		sections?: ReadonlyArray<ManifestSection>;
		selected?: string;
		/** Authored source paths; a tool's name is only legible from its filename. */
		files?: ReadonlyArray<string>;
		envoys?: ReadonlyArray<StudioEnvoy>;
		tools?: ReadonlyArray<StudioTool>;
		environment?: ReadonlyArray<EnvironmentVariable>;
		environmentError?: string | undefined;
		system: SystemClientApi;
		onopenSource?: ((path: string) => void) | undefined;
		onviewRuns?: ((automation: string) => void) | undefined;
		onconfigureEnvoys?: (() => void) | undefined;
	} = $props();
	const automationTrigger = (automation: WorkspaceManifest['automations'][number]): string => {
		if (automation.trigger._tag === 'Schedule') return `Scheduled · ${automation.trigger.cron}`;
		if (automation.trigger._tag === 'Change') {
			return `${automation.trigger.collection} · ${automation.trigger.event}`;
		}
		return 'Manual only';
	};
	const grantCount = (policy: WorkspaceManifest['policies'][number]): number =>
		policy.grants.length + Object.values(policy.capabilities).flat().length;
	const grantScope = (grant: WorkspaceManifest['policies'][number]['grants'][number]): string =>
		grant.where === undefined ? 'All rows' : JSON.stringify(grant.where);

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
		class="text-micro text-brand hover:underline"
		onclick={() => onopenSource?.(path)}
	>
		<Inline as="span" gap="xs">
			<Icon icon="lucide:arrow-right-circle" class="size-3" />
			View source
		</Inline>
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
						{@const image = app.thumbnail ?? app.banner}
						<Stack
							gap="none"
							class="overflow-hidden rounded-lg border border-border/60 bg-card shadow-card"
						>
							<Frame ratio="banner" shrink={false} class="bg-muted/40">
								{#if image !== undefined}
									<img src={image} alt="" class="size-full object-cover" loading="lazy" />
								{:else}
									<Inline fill align="center" justify="center" aria-hidden="true">
										<IconWrapper
											name={app.icon ?? 'product:apps'}
											class="size-9 text-muted-foreground/60"
										/>
									</Inline>
								{/if}
							</Frame>
							<Stack gap="xs" class="p-4">
								<Inline gap="sm">
									<IconWrapper
										name={app.icon ?? 'product:apps'}
										class="size-4 shrink-0 text-muted-foreground"
									/>
									<h3 class="truncate text-sm font-semibold text-foreground">{app.label}</h3>
								</Inline>
								<code class="text-micro text-muted-foreground">/app/{app.name}</code>
								{#if app.description !== undefined}
									<p class="text-meta">{app.description}</p>
								{/if}
							</Stack>
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
				<Stack gap="sm">
					{#each workspace.policies as policy (policy.name)}
						{@const path = `src/policies/+${policy.name}.policy.ts`}
						{@const capabilities = Object.entries(policy.capabilities).flatMap(([kind, names]) =>
							names.map((name) => ({ kind, name }))
						)}
						<Stack as="article" gap="sm" class="rounded-lg border border-border/60 bg-card p-4">
							<Inline align="start" gap="sm">
								<ProductIcon name="policies" class="mt-0.5 size-4 shrink-0 text-muted-foreground" />
								<Stack gap="xs" grow class="min-w-0">
									<Inline gap="sm">
										<h3 class="truncate text-xs font-semibold text-foreground">{policy.name}</h3>
										<span class="text-micro text-muted-foreground">
											{grantCount(policy)} grant{grantCount(policy) === 1 ? '' : 's'}
										</span>
									</Inline>
									{#if policy.description !== ''}
										<p class="max-w-3xl text-meta">{policy.description}</p>
									{/if}
									<code class="truncate text-micro text-muted-foreground">{path}</code>
								</Stack>
								{#if files.includes(path)}
									{@render sourceLink(path)}
								{/if}
							</Inline>

							{#if policy.grants.length > 0}
								<Stack
									as="ul"
									gap="none"
									class="divide-y divide-border/50 border-y border-border/50"
								>
									{#each policy.grants as grant, index (`${grant.collection}:${grant.action}:${index}`)}
										<Inline as="li" align="start" gap="sm" class="py-2 text-micro">
											<span class="w-12 shrink-0 font-semibold uppercase text-foreground">
												{grant.action}
											</span>
											<code class="w-32 shrink-0 break-all text-foreground">{grant.collection}</code
											>
											<Stack gap="xs" grow class="min-w-0 text-muted-foreground">
												<span>
													{grant.fields === undefined
														? 'All fields'
														: `Fields: ${grant.fields.join(', ')}`}
												</span>
												<code
													class="break-all whitespace-pre-wrap text-micro text-muted-foreground"
												>
													{grantScope(grant)}
												</code>
												{#if grant.dependencies !== undefined}
													<span>Depends on: {grant.dependencies.join(', ')}</span>
												{/if}
											</Stack>
											<Cluster gap="xs" shrink={false}>
												{#if grant.authorization === true}
													<span
														class="rounded-full bg-muted px-2 py-0.5 font-medium text-foreground"
													>
														Authorized
													</span>
												{/if}
												{#if grant.approval === true}
													<span
														class="rounded-full bg-amber-500/10 px-2 py-0.5 font-medium text-amber-700 dark:text-amber-300"
													>
														Approval required
													</span>
												{/if}
											</Cluster>
										</Inline>
									{/each}
								</Stack>
							{/if}

							{#if capabilities.length > 0}
								<Cluster gap="xs" aria-label="Capability grants">
									{#each capabilities as capability (`${capability.kind}:${capability.name}`)}
										<span class="rounded-full bg-muted px-2 py-1 text-micro text-foreground">
											{capability.kind} · <code>{capability.name}</code>
										</span>
									{/each}
								</Cluster>
							{/if}
						</Stack>
					{/each}
				</Stack>
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
						{@const path = `src/automations/+${automation.name}.ts`}
						<Stack gap="sm" class="rounded-lg border border-border/60 bg-card p-4">
							<Inline align="start" gap="sm">
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
								<Stack gap="xs" grow class="min-w-0">
									<Inline gap="sm">
										<h3 class="truncate font-mono text-sm font-semibold text-foreground">
											{automation.name}
										</h3>
										<span class="rounded-full bg-muted px-2 py-0.5 text-micro text-foreground">
											{automationTrigger(automation)}
										</span>
									</Inline>
									<p class="max-w-3xl text-meta">
										{automation.description ?? 'No description declared.'}
									</p>
									<Inline gap="sm" class="text-micro text-muted-foreground">
										<code>{path}</code>
										<span>Runs as {automation.policies.join(', ')}</span>
									</Inline>
								</Stack>
							</Inline>
							<Cluster gap="sm" justify="end">
								{#if files.includes(path)}
									{@render sourceLink(path)}
								{/if}
								<Button size="sm" variant="outline" onclick={() => onviewRuns?.(automation.name)}>
									<Icon icon="lucide:history" class="size-3.5" />
									View runs
								</Button>
							</Cluster>
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
	<CollectionDetail {collection} {manifest} {onopenSource} />
{:else if section === undefined}
	<Stack gap="sm" fill align="center" justify="center" class="px-6 text-muted-foreground">
		<Icon icon="lucide:list-tree" class="size-10 opacity-40" />
		<p class="text-sm font-medium text-foreground">Nothing selected</p>
		<p class="max-w-sm text-center text-xs leading-relaxed">Choose a branch on the left.</p>
	</Stack>
{:else if kind === 'envoys'}
	<EnvoysPanel {envoys} {tools} {system} {onopenSource} onconfigure={onconfigureEnvoys} />
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
