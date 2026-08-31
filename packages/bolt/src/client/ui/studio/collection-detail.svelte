<script lang="ts">
	import Icon from '@iconify/svelte';
	import { Badge } from '@norbital-ai/ui/badge';
	import { Button } from '@norbital-ai/ui/button';
	import { IconWrapper } from '@norbital-ai/ui/icon-wrapper';
	import { Cover, Inline, INSET_X_CLASS, Scroll, Stack } from '@norbital-ai/ui/layout';
	import { ProductIcon } from '@norbital-ai/ui/product-icon';
	import { cn } from '@norbital-ai/ui/utils';
	import { Tabs, type TabConfig } from '@norbital-ai/ui/tabs';
	import type {
		ManifestCollection,
		WorkspaceManifest
	} from '#lib/client/ui/studio/studio-state.js';

	/**
	 * One collection, read through its four declared faces: model, hooks, pipelines and integrations.
	 *
	 * The manifest is the authorized view: declared kind, enum members, searchable columns and the
	 * authored source path. Runtime records belong to the apps that operate on them; Manifest stays a
	 * description rather than becoming a second data browser.
	 */
	let {
		collection,
		manifest,
		onopenSource
	}: {
		collection: ManifestCollection;
		manifest: WorkspaceManifest;
		// `exactOptionalPropertyTypes`: the parent forwards its own optional handler, so the prop has
		// to accept an explicit `undefined` and not merely tolerate being omitted.
		onopenSource?: ((path: string) => void) | undefined;
	} = $props();

	// The reader's chosen declaration face survives while comparing collections.
	let activeView = $state('model');
	const hooks = $derived(collection.hooks ?? []);

	/**
	 * The two record pipelines every collection has, because the runtime dispatches them by name.
	 *
	 * They are not authored: `+pipelines.ts` is an authoring type this compiler never globs, so no
	 * workspace can add a third or describe these two in its own words.
	 */
	const RUNTIME_PIPELINES = ['collections.export', 'collections.import'] as const;
</script>

{#snippet modelView()}
	<Scroll name="Collection model">
		<Stack gap="sm">
			<Stack as="section" gap="xs">
				<h3 class="text-xs font-semibold text-foreground">Columns</h3>
				<Stack as="div" gap="none" class="divide-y divide-border/50 border-y border-border/50">
					<Inline gap="sm" class="px-1 py-1 text-micro text-muted-foreground">
						<span class="min-w-0 flex-1">Field</span>
						<span class="w-20 shrink-0">Type</span>
						<span class="w-20 shrink-0">Nullability</span>
						<span class="w-16 shrink-0">Read-only</span>
						<span class="w-16 shrink-0">Searchable</span>
						<span class="min-w-0 flex-1">Members</span>
					</Inline>
					{#each collection.fields as field (field.name)}
						<Inline gap="sm" align="start" class="px-1 py-1 text-xs">
							<span class="min-w-0 flex-1 break-all font-mono text-foreground">{field.name}</span>
							<span class="w-20 shrink-0 text-muted-foreground">{field.type}</span>
							<span class="w-20 shrink-0 text-muted-foreground">
								{field.required ? 'Required' : 'Optional'}
							</span>
							<span class="w-16 shrink-0 text-muted-foreground">
								{field.generated ? 'Computed' : '—'}
							</span>
							<span class="w-16 shrink-0 text-muted-foreground">
								{field.search === true ? 'Yes' : 'No'}
							</span>
							<span class="min-w-0 flex-1 break-all text-muted-foreground">
								{field.values?.join(', ') ?? field.customType ?? '—'}
							</span>
						</Inline>
					{/each}
				</Stack>
			</Stack>
			<Stack as="section" gap="xs">
				<h3 class="text-xs font-semibold text-foreground">Relations</h3>
				{#if collection.relations.length === 0}
					<p class="text-meta">This collection references no other.</p>
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
		<Inline justify="between" align="center" gap="sm" class="min-h-7">
			<p class="text-meta">
				{hooks.length} registered hook{hooks.length === 1 ? '' : 's'}
			</p>
			{#if collection.sourcePath !== undefined && hooks.length > 0}
				<Button
					type="button"
					size="sm"
					variant="ghost"
					class="h-6 px-2 text-micro"
					onclick={() => onopenSource?.(collection.sourcePath ?? '')}
				>
					View source
				</Button>
			{/if}
		</Inline>
		{#if hooks.length === 0}
			<p class="text-meta">None.</p>
		{:else}
			<Stack as="ul" gap="none" class="divide-y divide-border/50 border-y border-border/50">
				{#each hooks as hook (hook)}
					<Inline as="li" gap="sm" align="center" class="px-1 py-1 text-xs">
						<ProductIcon name="hooks" class="size-3.5 shrink-0 text-muted-foreground" />
						<span class="font-mono font-medium text-foreground">{hook}</span>
					</Inline>
				{/each}
			</Stack>
		{/if}
	</Stack>
{/snippet}

{#snippet pipelinesView()}
	<Stack as="ul" gap="none" class="divide-y divide-border/50 border-y border-border/50">
		{#each RUNTIME_PIPELINES as pipeline (pipeline)}
			<Inline as="li" gap="sm" align="center" class="px-1 py-1 text-xs">
				<ProductIcon name="pipelines" class="size-3.5 shrink-0 text-muted-foreground" />
				<span class="font-mono font-medium text-foreground">{pipeline}</span>
			</Inline>
		{/each}
	</Stack>
{/snippet}

{#snippet integrationsView()}
	{#if manifest.integrations.length === 0}
		<p class="text-meta">None.</p>
	{:else}
		<Stack as="ul" gap="none" class="divide-y divide-border/50 border-y border-border/50">
			{#each manifest.integrations as integration (integration.name)}
				<Inline as="li" gap="sm" align="center" class="px-1 py-1 text-xs">
					<ProductIcon name="integrations" class="size-3.5 shrink-0 text-muted-foreground" />
					<span class="min-w-0 flex-1 truncate font-medium text-foreground">
						{integration.name}
					</span>
				</Inline>
			{/each}
		</Stack>
	{/if}
{/snippet}

<Cover gap="none">
	{#snippet top()}
		<!--
			Same type scale as the record detail sheet's header: description above at `text-micro`,
			name below at `text-sm leading-5 font-semibold`. Inventing a scale here is what makes the
			Studio's banner read a size apart from the identical header elsewhere in the product.
		-->
		<Inline
			gap="sm"
			as="header"
			align="center"
			class={cn('border-b border-border/60 py-2.5', INSET_X_CLASS)}
		>
			<IconWrapper name={collection.icon ?? 'lucide:box'} class="size-5 text-muted-foreground" />
			<Stack gap="none" grow class="min-w-0">
				{#if collection.description}
					<p class="truncate text-micro leading-4 text-muted-foreground">
						{collection.description}
					</p>
				{/if}
				<Inline gap="sm" align="center">
					<h2 class="truncate text-sm leading-5 font-semibold text-foreground">
						{collection.name}
					</h2>
					{#if collection.history}
						<Badge variant="outline" class="shrink-0">Versioned</Badge>
					{/if}
				</Inline>
			</Stack>
			{#if collection.sourcePath !== undefined}
				<button
					type="button"
					class="shrink-0 text-xs text-primary hover:underline"
					onclick={() => onopenSource?.(collection.sourcePath ?? '')}
				>
					<Inline as="span" gap="xs">
						<Icon icon="lucide:arrow-right-circle" class="size-3" />
						View model
					</Inline>
				</button>
			{/if}
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
			{ name: 'model', label: 'Model', icon: 'product:models', content: modelView },
			{ name: 'hooks', label: 'Hooks', icon: 'product:hooks', content: hooksView },
			{
				name: 'pipelines',
				label: 'Pipelines',
				icon: 'product:pipelines',
				content: pipelinesView
			},
			{
				name: 'integrations',
				label: 'Integrations',
				icon: 'product:integrations',
				content: integrationsView
			}
		] satisfies TabConfig[]}
	/>
</Cover>
