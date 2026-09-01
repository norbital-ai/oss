<script lang="ts">
	import Icon from '@iconify/svelte';
	import { Button } from '@norbital-ai/ui/button';
	import { IconWrapper } from '@norbital-ai/ui/icon-wrapper';
	import { Cluster, Inline, Scroll, Stack } from '@norbital-ai/ui/layout';
	import { ProductIcon } from '@norbital-ai/ui/product-icon';
	import { cn } from '@norbital-ai/ui/utils';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import CollectionDetail from './collection-detail.svelte';
	import {
		canShowStudioSource,
		useStudioSourceEntitlement
	} from '#lib/client/ui/system/automation-presentation.js';
	import {
		MANIFEST_SECTION_MESSAGES,
		manifestInspectionState
	} from '#lib/client/ui/studio/studio-state.js';
	import type {
		EnvironmentVariable,
		ManifestDestination,
		ManifestSection,
		WorkspaceManifest
	} from '#lib/client/ui/studio/studio-state.js';

	let {
		manifest,
		loading = false,
		sections = [],
		selected = 'collections',
		envoys = [],
		environment = [],
		environmentError,
		onopenSource,
		onopenDestination,
		canOpenDestination,
		onretry
	}: {
		manifest?: WorkspaceManifest | undefined;
		loading?: boolean;
		sections?: ReadonlyArray<ManifestSection>;
		selected?: string;
		envoys?: WorkspaceManifest['envoys'];
		environment?: ReadonlyArray<EnvironmentVariable>;
		environmentError?: string | undefined;
		onopenSource?: ((path: string) => void) | undefined;
		onopenDestination?: ((destination: ManifestDestination) => void) | undefined;
		canOpenDestination?: ((destination: ManifestDestination) => boolean) | undefined;
		onretry?: (() => void) | undefined;
	} = $props();
	const { t } = useI18n();
	const studioSource = useStudioSourceEntitlement();
	const canEnterStudio = $derived(canShowStudioSource(studioSource().canEnterStudio));

	let expandedPolicies = $state<ReadonlyArray<string>>([]);
	let expandedDescriptions = $state<ReadonlyArray<string>>([]);

	const kind = $derived(selected.split(':')[0] ?? 'collections');
	const name = $derived(selected.slice(kind.length + 1));
	const section = $derived(sections.find((candidate) => candidate.id === kind));
	const collection = $derived(
		kind === 'collections' ? manifest?.collections.find((item) => item.name === name) : undefined
	);
	const projectedEnvironment = $derived(
		environment.map((entry) => {
			const declaration = manifest?.environment?.find((candidate) => candidate.name === entry.name);
			return {
				...entry,
				...(declaration?.sourcePath === undefined ? {} : { sourcePath: declaration.sourcePath }),
				...(declaration?.destination === undefined ? {} : { destination: declaration.destination }),
				...(declaration?.origin === undefined ? {} : { origin: declaration.origin })
			};
		})
	);
	type ListEntry = Readonly<{
		key?: string;
		name: string;
		label?: string;
		description?: string | undefined;
		detail?: string;
		icon?: string;
		origin?: 'authored' | 'system' | undefined;
		sourcePath?: string | undefined;
		destination?: ManifestDestination | undefined;
		versioned?: boolean;
	}>;

	const sectionLabel = (id: ManifestSection['id']): string => t(MANIFEST_SECTION_MESSAGES[id][0]);
	const sectionSummary = (id: ManifestSection['id']): string => t(MANIFEST_SECTION_MESSAGES[id][1]);
	const emptySectionLabel = (id: ManifestSection['id']): string =>
		t(MANIFEST_SECTION_MESSAGES[id][2]);
	const countLabel = (
		count: number,
		kind: 'fields' | 'relations' | 'hooks' | 'grants' | 'policies'
	): string => t(`bolt.studio.count.${kind}`, { count });
	const automationTrigger = (automation: WorkspaceManifest['automations'][number]): string => {
		if (automation.trigger._tag === 'Schedule')
			return t('bolt.studio.scheduledTrigger', { cron: automation.trigger.cron });
		if (automation.trigger._tag === 'Change') {
			return `${automation.trigger.collection} · ${automation.trigger.event}`;
		}
		return t('bolt.studio.manualTrigger');
	};
	const grantCount = (policy: WorkspaceManifest['policies'][number]): number =>
		policy.grants.length + Object.values(policy.capabilities).flat().length;
	const destinationLabel = (destination: ManifestDestination): string => {
		if (destination.kind === 'app') return t('bolt.studio.openApp');
		if (destination.surface === 'approvals') return t('bolt.studio.openApprovals');
		if (destination.surface === 'automations') return t('bolt.studio.openAutomations');
		if (destination.surface === 'envoys') return t('bolt.studio.configureEnvoy');
		if (destination.surface === 'environment') return t('bolt.studio.manageSecrets');
		return t('bolt.studio.openData');
	};
	const destinationAriaLabel = (destination: ManifestDestination, entity: string): string => {
		if (destination.kind === 'app') return t('bolt.studio.openEntityApp', { entity });
		if (destination.surface === 'envoys') return t('bolt.studio.configureNamedEnvoy', { entity });
		if (destination.surface === 'environment')
			return t('bolt.studio.manageNamedSecret', { entity });
		return `${destinationLabel(destination)}: ${entity}`;
	};
	const stableId = (prefix: string, value: string): string =>
		`${prefix}-${value.replaceAll(/[^a-zA-Z0-9_-]/g, '-')}`;
	const toggle = (values: ReadonlyArray<string>, value: string): ReadonlyArray<string> =>
		values.includes(value) ? values.filter((candidate) => candidate !== value) : [...values, value];
	const grantGroups = (policy: WorkspaceManifest['policies'][number]) => {
		const groups = new Map<
			string,
			Array<WorkspaceManifest['policies'][number]['grants'][number]>
		>();
		for (const grant of policy.grants) {
			groups.set(grant.collection, [...(groups.get(grant.collection) ?? []), grant]);
		}
		return [...groups.entries()].map(([collectionName, grants]) => ({ collectionName, grants }));
	};
	const listEntries = $derived.by<ReadonlyArray<ListEntry>>(() => {
		if (manifest === undefined) return [];
		if (kind === 'collections')
			return manifest.collections.map((entry) => ({
				name: entry.name,
				description: entry.description,
				detail: `${countLabel(entry.fields.length, 'fields')} · ${countLabel(entry.relations.length, 'relations')} · ${countLabel(entry.hookDeclarations?.length ?? 0, 'hooks')}`,
				icon: entry.icon ?? 'lucide:box',
				origin: entry.origin,
				sourcePath: entry.sourcePath,
				destination: entry.destination,
				versioned: entry.history
			}));
		if (kind === 'apps')
			return [...manifest.apps, ...(manifest.appGroups ?? [])].map((entry, index) => ({
				key: `${entry.name}:${index}`,
				name: entry.name,
				label: entry.label,
				description: entry.description,
				icon: entry.icon ?? 'product:apps',
				origin: entry.origin,
				sourcePath: entry.sourcePath,
				destination: entry.destination
			}));
		if (kind === 'envoys')
			return envoys.map((entry) => ({
				name: entry.name,
				detail: t('bolt.studio.envoyFacts', {
					transport: entry.transport,
					audience: entry.audience,
					delegation: entry.delegation
				}),
				origin: entry.origin,
				sourcePath: entry.sourcePath,
				destination: entry.destination
			}));
		if (kind === 'automations')
			return manifest.automations.map((entry) => ({
				name: entry.name,
				description: entry.description,
				detail: `${automationTrigger(entry)} · ${countLabel(entry.policies.length, 'policies')}`,
				origin: entry.origin,
				sourcePath: entry.sourcePath,
				destination: entry.destination
			}));
		if (kind === 'remotes')
			return (manifest.remotes ?? []).map((entry) => ({
				name: entry.name,
				origin: entry.origin,
				sourcePath: entry.sourcePath
			}));
		if (kind === 'environment')
			return projectedEnvironment.map((entry) => ({
				name: entry.name,
				description: entry.description,
				detail: `${t(entry.configured ? 'bolt.studio.set' : 'bolt.studio.notSet')} · ${entry.label}`,
				origin: entry.origin,
				sourcePath: entry.sourcePath,
				destination: entry.destination
			}));
		return [];
	});
</script>

{#snippet panelHeading(branch: ManifestSection, count: number)}
	<Inline gap="sm" align="start">
		<ProductIcon name={branch.icon} class="mt-0.5 size-4 text-muted-foreground" />
		<Stack gap="xs" class="min-w-0">
			<h2 class="text-sm font-medium text-foreground">{sectionLabel(branch.id)} ({count})</h2>
			<p class="max-w-2xl text-meta">{sectionSummary(branch.id)}</p>
		</Stack>
	</Inline>
{/snippet}

{#snippet emptyBranch(branch: ManifestSection, label: string)}
	<Stack gap="sm" align="center" justify="center" class="py-12 text-muted-foreground">
		<ProductIcon name={branch.icon} class="size-8 opacity-30" />
		<p class="text-xs">{label}</p>
	</Stack>
{/snippet}

{#snippet systemMarker(origin: 'authored' | 'system' | undefined)}
	{#if origin === 'system'}
		<span class="shrink-0 rounded-full bg-muted px-2 py-0.5 text-micro text-muted-foreground">
			{t('bolt.studio.system')}
		</span>
	{/if}
{/snippet}

{#snippet description(text: string, key: string)}
	{@const open = expandedDescriptions.includes(key)}
	{@const regionId = stableId('manifest-description', key)}
	<Stack gap="xs">
		<p id={regionId} class={cn('max-w-3xl text-meta', !open && 'line-clamp-2')}>{text}</p>
		{#if text.length > 80}
			<button
				type="button"
				class="w-fit text-micro text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
				aria-expanded={open}
				aria-controls={regionId}
				onclick={() => (expandedDescriptions = toggle(expandedDescriptions, key))}
			>
				{t(open ? 'bolt.studio.showLess' : 'bolt.studio.showFullDescription')}
			</button>
		{/if}
	</Stack>
{/snippet}

{#snippet sourceAction(path: string | undefined, entity: string)}
	{#if canEnterStudio}
		<button
			type="button"
			class="shrink-0 text-micro text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
			aria-label={t('bolt.studio.openEntitySource', { entity })}
			title={path}
			onclick={() => {
				if (path !== undefined && path.trim() !== '') onopenSource?.(path);
			}}
		>
			<Inline as="span" gap="xs">
				<Icon icon="lucide:arrow-right-circle" class="size-3" />
				{t('bolt.studio.source')}
			</Inline>
		</button>
	{/if}
{/snippet}

{#snippet destinationAction(destination: ManifestDestination | undefined, entity: string)}
	{#if destination !== undefined && (canOpenDestination?.(destination) ?? true)}
		<Button
			type="button"
			size="sm"
			variant="outline"
			class="h-7 px-2 text-micro"
			aria-label={destinationAriaLabel(destination, entity)}
			onclick={() => onopenDestination?.(destination)}
		>
			<Icon icon="lucide:external-link" class="size-3" />
			{destinationLabel(destination)}
		</Button>
	{/if}
{/snippet}

{#snippet listPanel(branch: ManifestSection, entries: ReadonlyArray<ListEntry>)}
	<Scroll name={sectionLabel(branch.id)} class="p-4 sm:p-6">
		<Stack gap="md">
			{@render panelHeading(branch, entries.length)}
			{#if kind === 'environment' && environmentError !== undefined}
				<p class="text-xs text-destructive" role="alert">
					{t('bolt.studio.vaultUnavailable', { error: environmentError })}
				</p>
			{:else if entries.length === 0}
				{@render emptyBranch(branch, emptySectionLabel(branch.id))}
			{:else}
				<Stack gap="none" class="divide-y divide-border/50 border-y border-border/50">
					{#each entries as entry (entry.key ?? entry.name)}
						<Inline as="article" align="start" gap="sm" class="flex-wrap py-3 sm:flex-nowrap">
							<IconWrapper
								name={entry.icon ??
									(kind === 'collections' ? 'lucide:box' : `product:${branch.icon}`)}
								class="mt-0.5 size-4 shrink-0 text-muted-foreground"
							/>
							<Stack gap="xs" grow class="min-w-0">
								<Cluster gap="xs">
									<h3
										class={cn(
											'text-xs font-medium text-foreground',
											kind !== 'apps' && 'font-mono'
										)}
									>
										{entry.label ?? entry.name}
									</h3>
									{@render systemMarker(entry.origin)}
									{#if entry.versioned}<span class="text-micro text-muted-foreground"
											>{t('bolt.studio.versioned')}</span
										>{/if}
								</Cluster>
								{#if entry.description !== undefined}
									{@render description(entry.description, `${kind}-${entry.name}`)}
								{/if}
								{#if entry.detail !== undefined}<p class="text-micro text-muted-foreground">
										{entry.detail}
									</p>{/if}
							</Stack>
							<Cluster gap="sm" shrink={false} class="w-full justify-end sm:w-auto">
								{@render destinationAction(entry.destination, entry.name)}
								{@render sourceAction(entry.sourcePath, entry.name)}
							</Cluster>
						</Inline>
					{/each}
				</Stack>
			{/if}
		</Stack>
	</Scroll>
{/snippet}

{#snippet policiesPanel(branch: ManifestSection, workspace: WorkspaceManifest)}
	<Scroll name={t('bolt.studio.section.policies')} class="p-4 sm:p-6">
		<Stack gap="md">
			{@render panelHeading(branch, workspace.policies.length)}
			{#if workspace.policies.length === 0}
				{@render emptyBranch(branch, t('bolt.studio.noPolicies'))}
			{:else}
				<Stack gap="none" class="divide-y divide-border/50 border-y border-border/50">
					{#each workspace.policies as policy (policy.name)}
						{@const open = expandedPolicies.includes(policy.name)}
						{@const regionId = stableId('policy-details', policy.name)}
						{@const capabilities = Object.entries(policy.capabilities).flatMap(
							([capabilityKind, names]) =>
								names.map((capabilityName) => ({ capabilityKind, capabilityName }))
						)}
						<Stack as="article" gap="sm" class="py-3">
							<Inline align="start" gap="sm" class="flex-wrap sm:flex-nowrap">
								<ProductIcon name="policies" class="mt-0.5 size-4 shrink-0 text-muted-foreground" />
								<Stack gap="xs" grow class="min-w-0">
									<Cluster gap="xs">
										<h3 class="text-xs font-medium text-foreground">{policy.name}</h3>
										{@render systemMarker(policy.origin)}
										<span class="text-micro text-muted-foreground">
											{countLabel(grantCount(policy), 'grants')}
										</span>
										{#if policy.grants.some((grant) => grant.approval === true)}
											<span class="text-micro text-amber-700 dark:text-amber-300">
												{t('bolt.studio.approvalRequired')}
											</span>
										{/if}
									</Cluster>
									{#if policy.description !== ''}
										{@render description(policy.description, `policy-${policy.name}`)}
									{/if}
								</Stack>
								<Cluster gap="sm" shrink={false} class="w-full justify-end sm:w-auto">
									{@render destinationAction(policy.destination, policy.name)}
									{@render sourceAction(policy.sourcePath, policy.name)}
									<Button
										type="button"
										size="sm"
										variant="ghost"
										class="h-7 px-2 text-micro"
										aria-expanded={open}
										aria-controls={regionId}
										onclick={() => (expandedPolicies = toggle(expandedPolicies, policy.name))}
									>
										<Icon
											icon={open ? 'lucide:chevron-up' : 'lucide:chevron-down'}
											class="size-3"
										/>
										{t(open ? 'bolt.studio.hideDetails' : 'bolt.studio.details')}
									</Button>
								</Cluster>
							</Inline>

							{#if open}
								<Stack id={regionId} gap="md" class="ml-6 border-t border-border/50 pt-3">
									{#each grantGroups(policy) as group (group.collectionName)}
										<Stack gap="xs">
											<h4 class="font-mono text-micro font-semibold text-foreground">
												{group.collectionName}
											</h4>
											<ul class="divide-y divide-border/40">
												{#each group.grants as grant, index (`${grant.action}-${index}`)}
													<li class="grid gap-2 py-2 text-micro sm:grid-cols-[5rem_1fr]">
														<span class="font-semibold uppercase text-foreground"
															>{grant.action}</span
														>
														<Stack gap="xs" class="min-w-0 text-muted-foreground">
															<span>
																{grant.fields === undefined
																	? t('bolt.studio.allFields')
																	: grant.fields.join(', ')}
															</span>
															{#if grant.dependencies !== undefined}
																<span>
																	{t('bolt.studio.dependsOn', {
																		dependencies: grant.dependencies.join(', ')
																	})}
																</span>
															{/if}
															{#if grant.approval === true}
																<span>{t('bolt.studio.approvalRequired')}</span>
															{/if}
															{#if grant.authorization === true}
																<span>{t('bolt.studio.authorizationRequired')}</span>
															{/if}
															{#if grant.where !== undefined}
																<pre
																	class="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/50 p-2 font-mono text-micro text-foreground">{JSON.stringify(
																		grant.where,
																		null,
																		2
																	)}</pre>
															{/if}
														</Stack>
													</li>
												{/each}
											</ul>
										</Stack>
									{/each}
									{#if capabilities.length > 0}
										<Cluster gap="xs" aria-label={t('bolt.studio.capabilityGrants')}>
											{#each capabilities as capability (`${capability.capabilityKind}:${capability.capabilityName}`)}
												<span class="rounded-full bg-muted px-2 py-1 text-micro text-foreground">
													{capability.capabilityKind} · <code>{capability.capabilityName}</code>
												</span>
											{/each}
										</Cluster>
									{/if}
								</Stack>
							{/if}
						</Stack>
					{/each}
				</Stack>
			{/if}
		</Stack>
	</Scroll>
{/snippet}

{#if manifest === undefined && loading}
	<Stack gap="md" class="p-4 sm:p-6" aria-label={t('bolt.studio.loadingManifest')}>
		<div class="h-8 w-48 rounded-md bg-muted motion-safe:animate-pulse"></div>
		<div class="h-16 rounded-md bg-muted/70 motion-safe:animate-pulse"></div>
		<div class="h-16 rounded-md bg-muted/70 motion-safe:animate-pulse"></div>
		<div class="h-16 rounded-md bg-muted/70 motion-safe:animate-pulse"></div>
	</Stack>
{:else if manifest === undefined}
	<Stack gap="sm" fill align="center" justify="center" class="px-6 text-muted-foreground">
		<Icon icon="lucide:file-warning" class="size-9 opacity-40" />
		<p class="text-sm font-medium text-foreground">{t('bolt.studio.manifestUnavailable')}</p>
		<Button type="button" size="sm" variant="outline" onclick={() => onretry?.()}>
			<Icon icon="lucide:refresh-cw" class="size-3.5" />
			{t('bolt.studio.retry')}
		</Button>
	</Stack>
{:else if manifestInspectionState(manifest) === 'rebuild_required'}
	<Stack
		gap="sm"
		fill
		align="center"
		justify="center"
		class="px-6 text-center text-muted-foreground"
	>
		<Icon icon="lucide:refresh-cw" class="size-9 opacity-40" />
		<p class="text-sm font-medium text-foreground">{t('bolt.studio.rebuildRequired')}</p>
		<p class="max-w-sm text-meta">
			{t('bolt.studio.rebuildDescription')}
		</p>
	</Stack>
{:else if collection !== undefined}
	<CollectionDetail {collection} {manifest} {onopenSource} />
{:else if section === undefined}
	<Stack gap="sm" fill align="center" justify="center" class="px-6 text-muted-foreground">
		<Icon icon="lucide:list-tree" class="size-9 opacity-40" />
		<p class="text-sm font-medium text-foreground">{t('bolt.studio.nothingSelected')}</p>
	</Stack>
{:else if kind === 'policies'}
	{@render policiesPanel(section, manifest)}
{:else}
	{@render listPanel(section, listEntries)}
{/if}
