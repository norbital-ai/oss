<script lang="ts">
	import { switchOrganization } from './organization-switch.js';
	import Icon from '@iconify/svelte';
	import { onDestroy } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { ManifestContext } from '@norbital-ai/platform-utils/manifest/context';
	import { page, goto } from '$lib/client/router.svelte.js';
	import {
		PageSurfaceState,
		setPageSurfaceStateContext
	} from '$lib/client/page_surface_state.svelte.js';
	import type {
		CollectionClient,
		ErasedCollectionRegistry
	} from '@norbital-ai/platform-utils/collection';
	import type { DetailStackEntry } from '$lib/client/detail/detail_stack.js';
	import type { TenantWorkspaceShellData } from '$lib/client/workspace_shell_types.js';
	import CollectionRecordDetailFallback from './collection-record-detail-fallback.svelte';
	import DetailSurfaceStack from './detail-surface-stack.svelte';
	import * as Sheet from '@norbital-ai/ui/sheet';
	import {
		CollectionDetailActions,
		CollectionDetailPreferences,
		setCollectionClientContext,
		setCollectionTableNavigationContext,
		setCollectionSurfaceRuntime,
		type CollectionSurfaceRegistry
	} from '@norbital-ai/ui/collection-table';
	import {
		setDataRendererRuntimeContext,
		type CustomTypeRendererMap
	} from '@norbital-ai/ui/data-renderer';
	import {
		WorkspaceShell,
		type WorkspaceNavigationItem,
		type WorkspaceNavigationModel
	} from '@norbital-ai/ui/workspace-shell';
	import { FEATURE_COLOR_STYLES, type FeatureColorKey } from '@norbital-ai/ui/feature-colors';
	import { IconWrapper } from '@norbital-ai/ui/icon-wrapper';
	import { Bound, Center, Cover, Grid, Inline, Scroll, Stack } from '@norbital-ai/ui/layout';
	import { ProductIcon, productIconNameFromReference } from '@norbital-ai/ui/product-icon';
	import { cn } from '@norbital-ai/ui/utils';
	import { WorkspaceFileUploadClient } from '$lib/client/workspace-file-upload.svelte.js';
	import { workspaceRuntimeOperations, type WorkspaceAppLoader } from './client.js';
	import BillingBanner from './billing-banner.svelte';
	import HostPluginFrame from './host-plugin-frame.svelte';
	import { createPodCollectionTableNavigation } from './collection-table-navigation.js';
	import {
		appAccessAllowed,
		buildApplicationNavigation,
		resolveApplicationLandingAppId,
		resolveWorkspaceOrganizationOptions
	} from './workspace-navigation.js';

	let {
		apps,
		collectionSurfaces,
		customTypeRenderers,
		workspaceApi,
		data
	}: {
		apps: Readonly<Record<string, WorkspaceAppLoader>>;
		collectionSurfaces: CollectionSurfaceRegistry;
		customTypeRenderers: CustomTypeRendererMap;
		workspaceApi: CollectionClient<ErasedCollectionRegistry>;
		data: TenantWorkspaceShellData;
	} = $props();

	const manifestContext = $derived(new ManifestContext(data.initialWorkspaceLatest));
	const platformState = new PageSurfaceState({
		getManifestContext: () => manifestContext,
		getUser: () => data.user,
		getOrganization: () => data.organization,
		getPolicyGrants: () => data.policyGrants
	});
	setPageSurfaceStateContext(() => platformState);
	setCollectionTableNavigationContext(
		createPodCollectionTableNavigation({
			getCurrentUrl: () => page.url,
			getCurrentStack: () => platformState.state.navStack,
			navigation: platformState.navigation
		})
	);
	setCollectionClientContext(() => workspaceApi);
	setDataRendererRuntimeContext({
		autocompleteGeolocation: workspaceRuntimeOperations.autocompleteGeolocation,
		createFileUploadClient: () => new WorkspaceFileUploadClient(),
		renderStaticMap: workspaceRuntimeOperations.renderStaticMap,
		get customTypeRenderers() {
			return customTypeRenderers;
		}
	});
	const detailPreferences = new CollectionDetailPreferences();

	const appNames = $derived(Object.keys(apps));
	const currentPath = $derived(page.url.pathname);
	const activeOrganization = $derived({
		id: data.organization.id,
		name: data.organization.name,
		logoUrl: data.organization.logo_url
	});
	function searchForHostPlugin(pluginKey: string): string {
		return activeHostPlugin?.key === pluginKey ? page.url.search : '';
	}
	const requestedAppName = $derived.by(
		() =>
			[...appNames]
				.sort((left, right) => right.length - left.length)
				.find(
					(name) => currentPath === `/app/${name}` || currentPath.startsWith(`/app/${name}/`)
				) ??
			page.params.app ??
			''
	);
	const appName = $derived(
		resolveApplicationLandingAppId({
			requestedAppId: requestedAppName,
			appIds: appNames,
			apps: manifestContext.getAppsRecord(),
			accessibleAppNames: data.accessibleAppNames
		}) ?? requestedAppName
	);
	const activeCollectionViews = new Set<string>();
	setCollectionSurfaceRuntime({
		appId: () => appName,
		get surfaces() {
			return collectionSurfaces;
		},
		claimView(view) {
			if (activeCollectionViews.has(view)) {
				throw new Error(`Duplicate collection view "${view}"; provide a unique view prop.`);
			}
			activeCollectionViews.add(view);
			return () => activeCollectionViews.delete(view);
		}
	});
	const accessible = $derived(appName && appAccessAllowed(appName, data.accessibleAppNames));
	const loadableAppName = $derived(accessible ? appName : undefined);
	const loadedApps = new Map<
		string,
		{ loader: WorkspaceAppLoader; promise: ReturnType<WorkspaceAppLoader> }
	>();
	function loadWorkspaceApp(name: string): ReturnType<WorkspaceAppLoader> | undefined {
		const loader = apps[name];
		if (!loader) return undefined;
		const cached = loadedApps.get(name);
		if (cached?.loader === loader) return cached.promise;
		const promise = loader();
		loadedApps.set(name, { loader, promise });
		return promise;
	}
	const activeApp = $derived(loadableAppName ? loadWorkspaceApp(loadableAppName) : undefined);
	const activeAppManifest = $derived(appName ? manifestContext.findApp(appName) : undefined);
	const detailStack = $derived.by((): DetailStackEntry[] =>
		platformState.state.navStack.map((item) => ({
			routeKey: item.node_id,
			recordId: item.record_id,
			collectionName: item.collection_name
		}))
	);
	const topDetailFrame = $derived(platformState.state.navStack.at(-1) ?? null);
	const detailSheetOpen = $derived(
		detailStack.length > 0 && topDetailFrame?.viewMode === 'sidesheet'
	);
	const detailSheetFullScreen = $derived(
		topDetailFrame ? detailPreferences.isFullScreen(topDetailFrame.collection_name) : false
	);
	const sidebarHostPlugins = $derived(
		(data.hostPlugins?.apps ?? []).filter((plugin) => plugin.placement === 'sidebar')
	);
	const activeHostPlugin = $derived(
		sidebarHostPlugins.find(
			(plugin) => currentPath === plugin.route || currentPath.startsWith(`${plugin.route}/`)
		) ?? null
	);
	const prefetchedHostPluginKeys = new SvelteSet<string>();
	const mountedHostPlugins = $derived(
		sidebarHostPlugins.filter(
			(plugin) => plugin.key === activeHostPlugin?.key || prefetchedHostPluginKeys.has(plugin.key)
		)
	);

	function prefetchHostPlugin(href: string): void {
		const plugin = sidebarHostPlugins.find((candidate) => candidate.route === href);
		if (plugin) prefetchedHostPluginKeys.add(plugin.key);
	}
	const navigationModel = $derived.by((): WorkspaceNavigationModel => ({
		activeOrganization,
		organizations: resolveWorkspaceOrganizationOptions({
			activeOrganization,
			organizations: data.userOrganizations ?? []
		}),
		user: {
			name: data.user.user_name || data.user.email,
			email: data.user.email,
			role: data.user.role,
			avatarUrl: data.user.avatar_url,
			teamLabels: data.user.team_members.flatMap((team) => (team.name ? [team.name] : []))
		},
		system: [
			...(data.hostPlugins?.apps ?? [])
				.filter((plugin) => plugin.placement === 'sidebar')
				.map((plugin): WorkspaceNavigationItem => ({
					key: plugin.key,
					label: plugin.label,
					icon: plugin.icon,
					href: plugin.route,
					active: currentPath === plugin.route || currentPath.startsWith(`${plugin.route}/`),
					featureColor:
						plugin.key === 'agent'
							? 'agents'
							: plugin.key === 'workspace-studio'
								? 'workspaceStudio'
								: plugin.key === 'org-settings'
									? 'accessControl'
									: 'builtIn'
				})),
			...(data.hostPlugins?.opsAccess
				? [
						{
							key: 'ops',
							label: 'Command Center',
							icon: 'lucide:terminal',
							href: '/ops',
							active: false,
							featureColor: 'builtIn' as const
						}
					]
				: [])
		],
		applications: buildApplicationNavigation({
			appIds: appNames,
			apps: manifestContext.getAppsRecord(),
			accessibleAppNames: data.accessibleAppNames,
			currentPath
		})
	}));
	const overviewApplications = $derived(
		navigationModel.applications.map((item) => ({
			...item,
			description: manifestContext.findApp(item.key)?.description ?? null,
			thumbnail: manifestContext.findApp(item.key)?.thumbnail ?? null
		}))
	);

	const platformDescriptions: Readonly<Record<string, string>> = {
		agent: 'Chat with the workspace agent to explore and update your data.',
		'workspace-studio': 'Author and publish workspace schema, apps, and automations.',
		'org-settings': 'Manage workspace profiles, members, billing, and security.'
	};

	function pluginFeatureKey(key: string): FeatureColorKey {
		switch (key) {
			case 'agent':
				return 'agents';
			case 'workspace-studio':
				return 'workspaceStudio';
			case 'org-settings':
				return 'accessControl';
			default:
				return 'builtIn';
		}
	}

	function closeDetailSheet(): void {
		if (detailSheetOpen) platformState.navigation.pop(page.url);
	}

	function toggleDetailSheetFullscreen(): void {
		if (!topDetailFrame) return;
		detailPreferences.toggleFullScreen(topDetailFrame.collection_name);
	}

	function navigate(href: string): void {
		void goto(href);
	}

	onDestroy(() => platformState.destroy());
</script>

{#snippet detailSheetToolbar()}
	<CollectionDetailActions
		fullScreen={detailSheetFullScreen}
		onToggleFullScreen={toggleDetailSheetFullscreen}
		onClose={closeDetailSheet}
	/>
{/snippet}

{#snippet platformDetailFallback({ entry }: { entry: DetailStackEntry })}
	<CollectionRecordDetailFallback
		{entry}
		{manifestContext}
		{collectionSurfaces}
		close={closeDetailSheet}
		actions={detailSheetToolbar}
	/>
{/snippet}

{#snippet activeAppBanner()}
	{#if activeAppManifest?.banner}
		<!-- stupidity:allow UI5 -- organization hero banner clips its backdrop image -->
		<div class="relative h-[clamp(8rem,24vh,18rem)] w-full overflow-clip border-b bg-muted">
			<img src={activeAppManifest.banner} alt="" class="size-full object-cover" />
		</div>
	{/if}
{/snippet}

<WorkspaceShell
	model={navigationModel}
	onNavigate={(href: string) => {
		if (href === '/ops') {
			window.parent.location.assign(
				'/ops?returnUrl=' + encodeURIComponent(window.parent.location.href)
			);
			return;
		}
		navigate(href);
	}}
	onPrefetch={prefetchHostPlugin}
	onOrganizationChange={switchOrganization}
	onSignOut={async () => {
		const response = await fetch('/api/auth/sign-out', {
			method: 'POST',
			credentials: 'include'
		});
		if (!response.ok) throw new Error('Unable to sign out');
		window.location.assign('/login');
	}}
>
	<Bound size="full" clip class="relative flex-1">
		<BillingBanner billing={data.billing} isAdmin={data.user.role === 'admin'} {navigate} />
		{#each mountedHostPlugins as plugin (plugin.key)}
			<div
				class={activeHostPlugin?.key === plugin.key ? 'h-full min-h-0 min-w-0' : 'hidden'}
				aria-hidden={activeHostPlugin?.key === plugin.key ? undefined : 'true'}
				inert={activeHostPlugin?.key === plugin.key ? undefined : true}
			>
				<HostPluginFrame
					entry={plugin.entry}
					label={plugin.label}
					pluginKey={plugin.key}
					search={searchForHostPlugin(plugin.key)}
				/>
			</div>
		{/each}
		{#if currentPath === '/'}
			<Scroll name="Workspace overview" axis="y">
				<Center measure="wide" class="p-4 sm:p-6 lg:p-8">
					<Stack gap="xl">
						<Stack as="header" gap="xs">
							<h1 class="text-base font-semibold text-foreground">{data.organization.name}</h1>
							<p class="text-xs text-muted-foreground">
								Pick an application or platform tool to get started.
							</p>
						</Stack>

						<Stack gap="xs">
							<h2 class="text-tiny font-medium tracking-wide text-muted-foreground uppercase">
								Applications
							</h2>
							{#if overviewApplications.length === 0}
								<Stack
									gap="xs"
									class="items-center justify-center rounded-lg border border-dashed p-8"
								>
									<Icon icon="lucide:layout-dashboard" class="size-8 text-muted-foreground" />
									<span class="text-xs text-muted-foreground">No applications yet</span>
									<span class="max-w-72 text-center text-micro text-muted-foreground">
										Use Workspace Studio to author apps in the tenant workspace.
									</span>
								</Stack>
							{:else}
								<Grid minimum="card" gap="sm">
									{#each overviewApplications as app (app.key)}
										<a
											href={app.href}
											class="group min-w-0 overflow-hidden rounded-xl border bg-card shadow-card outline-none transition-colors duration-150 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
											onclick={(event) => {
												event.preventDefault();
												navigate(app.href);
											}}
										>
											{#if app.thumbnail}
												<div class="aspect-[16/9] w-full overflow-hidden border-b bg-muted">
													<img
														src={app.thumbnail}
														alt=""
														loading="lazy"
														decoding="async"
														class="size-full object-cover"
													/>
												</div>
											{/if}
											<Inline align="start" gap="sm" class="p-3">
												<div
													class="flex size-8 shrink-0 items-center justify-center rounded-md border border-input bg-background text-foreground shadow-xs"
												>
													<IconWrapper name={app.icon ?? 'lucide:file-text'} class="size-4" />
												</div>
												<Stack gap="none" class="flex-1">
													<p class="truncate text-xs font-semibold text-foreground">{app.label}</p>
													{#if app.description}
														<p class="line-clamp-2 text-micro leading-4 text-muted-foreground">
															{app.description}
														</p>
													{/if}
												</Stack>
											</Inline>
										</a>
									{/each}
								</Grid>
							{/if}
						</Stack>

						{#if navigationModel.system.length > 0}
							<Stack gap="xs">
								<h2 class="text-tiny font-medium tracking-wide text-muted-foreground uppercase">
									Platform
								</h2>
								<Grid minimum="card" gap="sm">
									{#each navigationModel.system as item (item.key)}
										{@const featureStyles = FEATURE_COLOR_STYLES[pluginFeatureKey(item.key)]}
										{@const productIconName = productIconNameFromReference(item.icon)}
										<a
											href={item.href}
											class="group min-w-0 rounded-lg border bg-card p-3 shadow-card outline-none transition-colors duration-150 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
											onclick={(event) => {
												event.preventDefault();
												navigate(item.href);
											}}
										>
											<Inline align="start" gap="sm">
												<div
													class={cn(
														'flex size-8 shrink-0 items-center justify-center rounded-md border shadow-xs',
														featureStyles.iconWrapperClass
													)}
												>
													{#if productIconName}
														<ProductIcon
															name={productIconName}
															class={cn('size-4', featureStyles.iconClass)}
														/>
													{:else}
														<IconWrapper
															name={item.icon ?? featureStyles.icon}
															class={cn('size-4', featureStyles.iconClass)}
														/>
													{/if}
												</div>
												<Stack gap="none" class="flex-1">
													<p class="truncate text-xs font-semibold text-foreground">{item.label}</p>
													<p class="line-clamp-2 text-micro leading-4 text-muted-foreground">
														{platformDescriptions[item.key] ??
															'Platform tool provided by the host.'}
													</p>
												</Stack>
											</Inline>
										</a>
									{/each}
								</Grid>
							</Stack>
						{/if}
					</Stack>
				</Center>
			</Scroll>
		{:else if !activeHostPlugin && activeApp && accessible}
			<Bound size="full" clip data-workspace-app-region>
				<Cover gap="none" top={activeAppBanner}>
					<Bound size="full" clip data-workspace-app-surface class="[container-name:pod-app]">
						{#await activeApp}
							<div class="grid h-full min-h-0 place-items-center text-sm text-muted-foreground">
								Loading application…
							</div>
						{:then ActiveApp}
							<ActiveApp />
						{:catch error}
							<div class="grid h-full min-h-0 place-items-center p-6 text-sm text-destructive">
								{error instanceof Error ? error.message : String(error)}
							</div>
						{/await}
					</Bound>
				</Cover>
			</Bound>
		{:else if !activeHostPlugin && appName && !accessible}
			<div class="grid min-h-0 flex-1 place-items-center p-6 text-sm text-destructive">
				Access denied
			</div>
		{:else if !activeHostPlugin}
			<div class="grid min-h-0 flex-1 place-items-center p-6 text-sm text-muted-foreground">
				Workspace application not found
			</div>
		{/if}
	</Bound>
</WorkspaceShell>

<Sheet.Root open={detailSheetOpen} onOpenChange={(open) => !open && closeDetailSheet()}>
	<Sheet.Content
		flush
		contained
		portalTarget="[data-slot='sidebar-inset']"
		side="right"
		class="w-[520px] sm:max-w-[520px]"
		showCloseButton={false}
		fullScreen={detailSheetFullScreen}
		preventBackgroundClick="narrow"
		onOpenAutoFocus={(event) => event.preventDefault()}
		onCloseAutoFocus={(event) => event.preventDefault()}
		onEscapeKeydown={(event) => {
			event.preventDefault();
			closeDetailSheet();
		}}
	>
		<Bound size="full" clip class="relative">
			<DetailSurfaceStack
				stack={detailStack}
				resolveSurface={(routeKey: string, parentRouteKey?: string) =>
					platformState.navigation.resolve(routeKey, parentRouteKey)}
				unresolvedFallback={platformDetailFallback}
				actions={detailSheetToolbar}
			/>
		</Bound>
	</Sheet.Content>
</Sheet.Root>
