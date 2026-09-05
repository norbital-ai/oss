<script lang="ts">
	import Icon from '@iconify/svelte';
	import { Badge } from '@norbital-ai/ui/badge';
	import { IconWrapper } from '@norbital-ai/ui/icon-wrapper';
	import { Cover, Inline, INSET_X_CLASS, Scroll, Stack } from '@norbital-ai/ui/layout';
	import { ProductIcon } from '@norbital-ai/ui/product-icon';
	import { Tabs, type TabConfig } from '@norbital-ai/ui/tabs';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import {
		canShowStudioSource,
		useStudioSourceEntitlement
	} from '#lib/client/ui/system/automation-presentation.js';
	import {
		hookSummaryKey,
		integrationBindingSummary,
		type ManifestCollection,
		type WorkspaceManifest
	} from '#lib/client/ui/studio/studio-state.js';

	let {
		collection,
		manifest,
		onopenSource
	}: {
		collection: ManifestCollection;
		manifest: WorkspaceManifest;
		onopenSource?: ((path: string) => void) | undefined;
	} = $props();
	const { t } = useI18n();
	const studioSource = useStudioSourceEntitlement();
	const canEnterStudio = $derived(canShowStudioSource(studioSource().canEnterStudio));

	let activeView = $state('model');
	const hooks = $derived(collection.hookDeclarations ?? []);
	const pipelines = $derived(collection.pipelines ?? []);
	const integrations = $derived(
		manifest.integrations.filter((integration) => integration.collection === collection.name)
	);
</script>

{#snippet sourceLink(path: string | undefined, label: string)}
	{#if canEnterStudio}
		<button
			type="button"
			class="shrink-0 text-micro text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
			aria-label={t('bolt.studio.openEntitySource', { entity: label })}
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

{#snippet modelView()}
	<Scroll name={t('bolt.studio.model')}>
		<Stack gap="sm">
			<Stack as="section" gap="xs">
				<h3 class="text-xs font-semibold text-foreground">{t('bolt.studio.columns')}</h3>
				<Scroll name="Collection record" axis="x" class="max-w-full">
					<Stack
						as="div"
						gap="none"
						class="divide-y divide-border/50 border-y border-border/50"
						style="min-width: 42rem"
					>
						<Inline gap="sm" class="px-1 py-1 text-micro text-muted-foreground">
							<span class="min-w-0 flex-1">{t('bolt.studio.field')}</span>
							<span class="w-20 shrink-0">{t('bolt.studio.type')}</span>
							<span class="w-20 shrink-0">{t('bolt.studio.nullability')}</span>
							<span class="w-16 shrink-0">{t('bolt.studio.readOnly')}</span>
							<span class="w-16 shrink-0">{t('bolt.studio.searchable')}</span>
							<span class="min-w-0 flex-1">{t('bolt.studio.members')}</span>
						</Inline>
						{#each collection.fields as field (field.name)}
							<Inline gap="sm" align="start" class="px-1 py-1 text-xs">
								<span class="min-w-0 flex-1 break-all font-mono text-foreground">{field.name}</span>
								<span class="w-20 shrink-0 text-muted-foreground">{field.type}</span>
								<span class="w-20 shrink-0 text-muted-foreground">
									{t(field.required ? 'bolt.studio.required' : 'bolt.studio.optional')}
								</span>
								<span class="w-16 shrink-0 text-muted-foreground">
									{field.generated ? t('bolt.studio.computed') : '—'}
								</span>
								<span class="w-16 shrink-0 text-muted-foreground">
									{t(field.search === true ? 'bolt.studio.yes' : 'bolt.studio.no')}
								</span>
								<span class="min-w-0 flex-1 break-all text-muted-foreground">
									{field.values?.join(', ') ?? field.customType ?? '—'}
								</span>
							</Inline>
						{/each}
						{#if collection.fields.length === 0}
							<p class="px-1 py-2 text-meta">{t('bolt.studio.noFields')}</p>
						{/if}
					</Stack>
				</Scroll>
			</Stack>
			<Stack as="section" gap="xs">
				<h3 class="text-xs font-semibold text-foreground">{t('bolt.studio.relations')}</h3>
				{#if collection.relations.length === 0}
					<p class="text-meta">{t('bolt.studio.noRelations')}</p>
				{:else}
					<Stack as="ul" gap="none" class="divide-y divide-border/50 border-y border-border/50">
						{#each collection.relations as relation (relation.name)}
							<Inline as="li" gap="sm" align="baseline" class="px-1 py-1 text-xs">
								<span class="font-medium text-foreground">{relation.name}</span>
								<span class="text-muted-foreground">{relation.cardinality}</span>
								<span class="font-mono text-muted-foreground">{relation.target}</span>
							</Inline>
						{/each}
					</Stack>
				{/if}
			</Stack>
		</Stack>
	</Scroll>
{/snippet}

{#snippet hooksView()}
	<Stack gap="sm">
		{#if hooks.length === 0}
			<p class="text-meta">{t('bolt.studio.noHooks')}</p>
		{:else}
			<Stack as="ul" gap="none" class="divide-y divide-border/50 border-y border-border/50">
				{#each hooks as hook (hook.name)}
					<Inline as="li" gap="sm" align="start" class="flex-wrap px-1 py-2 text-xs sm:flex-nowrap">
						<ProductIcon name="hooks" class="size-3.5 shrink-0 text-muted-foreground" />
						<Stack gap="none" grow class="min-w-0">
							<span class="font-mono font-medium text-foreground">{hook.name}</span>
							{@const summaryKey = hookSummaryKey(hook.name)}
							{#if hook.description !== undefined || summaryKey !== undefined}
								<span class="text-meta"
									>{hook.description ?? (summaryKey === undefined ? '' : t(summaryKey))}</span
								>
							{/if}
						</Stack>
						{@render sourceLink(hook.sourcePath, hook.name)}
					</Inline>
				{/each}
			</Stack>
		{/if}
	</Stack>
{/snippet}

{#snippet pipelinesView()}
	{#if pipelines.length === 0}
		<p class="text-meta">{t('bolt.studio.noPipelines')}</p>
	{:else}
		<Stack as="ul" gap="none" class="divide-y divide-border/50 border-y border-border/50">
			{#each pipelines as pipeline (pipeline.name)}
				<Inline as="li" gap="sm" align="start" class="flex-wrap px-1 py-2 text-xs sm:flex-nowrap">
					<ProductIcon name="pipelines" class="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
					<Stack gap="none" grow class="min-w-0">
						<span class="font-mono font-medium text-foreground">{pipeline.name}</span>
						{#if pipeline.description !== undefined}
							<span class="text-meta">{pipeline.description}</span>
						{/if}
					</Stack>
					{@render sourceLink(pipeline.sourcePath, pipeline.name)}
				</Inline>
			{/each}
		</Stack>
	{/if}
{/snippet}

{#snippet integrationsView()}
	{#if integrations.length === 0}
		<p class="text-meta">{t('bolt.studio.noIntegrations')}</p>
	{:else}
		<Stack as="ul" gap="none" class="divide-y divide-border/50 border-y border-border/50">
			{#each integrations as integration (integration.name)}
				<Inline as="li" gap="sm" align="start" class="flex-wrap px-1 py-2 text-xs sm:flex-nowrap">
					<ProductIcon name="integrations" class="size-3.5 shrink-0 text-muted-foreground" />
					<Stack gap="none" grow class="min-w-0">
						<span class="truncate font-medium text-foreground">{integration.name}</span>
						{#if integration.description !== undefined}
							<span class="text-meta">{integration.description}</span>
						{/if}
						{#each integration.bindings ?? [] as binding (binding.name)}
							<span class="text-micro text-muted-foreground">
								{binding.direction} · {integrationBindingSummary(binding)}
								{#if binding.targetCollection !== undefined}
									· {binding.targetCollection}{/if}
							</span>
						{/each}
					</Stack>
					{@render sourceLink(integration.sourcePath, integration.name)}
				</Inline>
			{/each}
		</Stack>
	{/if}
{/snippet}

<Cover gap="none">
	{#snippet top()}
		<Inline
			gap="sm"
			as="header"
			align="center"
			class="flex-wrap border-b border-border/60 py-2.5 sm:flex-nowrap {INSET_X_CLASS}"
		>
			<IconWrapper name={collection.icon ?? 'lucide:box'} class="size-5 text-muted-foreground" />
			<Stack gap="none" grow class="min-w-0">
				{#if collection.description}
					<p class="max-w-3xl text-micro leading-4 text-muted-foreground">
						{collection.description}
					</p>
				{/if}
				<Inline gap="sm" align="center">
					<h2 class="truncate text-sm leading-5 font-semibold text-foreground">
						{collection.name}
					</h2>
					{#if collection.history}
						<Badge variant="outline" class="shrink-0">{t('bolt.studio.versioned')}</Badge>
					{/if}
					{#if collection.origin === 'system'}
						<Badge variant="outline" class="shrink-0">{t('bolt.studio.system')}</Badge>
					{/if}
				</Inline>
			</Stack>
			{@render sourceLink(collection.sourcePath, collection.name)}
		</Inline>
	{/snippet}

	<Tabs
		bind:value={activeView}
		class="h-full"
		variant="chip"
		listClass="mx-4 shrink-0 sm:mx-6"
		keepAlive
		animate={false}
		config={[
			{ name: 'model', label: t('bolt.studio.model'), icon: 'product:models', content: modelView },
			{ name: 'hooks', label: t('bolt.studio.hooks'), icon: 'product:hooks', content: hooksView },
			{
				name: 'pipelines',
				label: t('bolt.studio.pipelines'),
				icon: 'product:pipelines',
				content: pipelinesView
			},
			{
				name: 'integrations',
				label: t('bolt.studio.integrations'),
				icon: 'product:integrations',
				content: integrationsView
			}
		] satisfies TabConfig[]}
	/>
</Cover>
