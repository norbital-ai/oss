<script lang="ts">
	import Icon from '@iconify/svelte';
	import { onDestroy } from 'svelte';
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
	import { WorkspaceShell, type WorkspaceNavigationModel } from '@norbital-ai/ui/workspace-shell';
	import { IconWrapper } from '@norbital-ai/ui/icon-wrapper';
	import { Bound, Cover } from '@norbital-ai/ui/layout';
	import { WorkspaceFileUploadClient } from '$lib/client/workspace-file-upload.svelte.js';
	import { workspaceRuntimeOperations, type WorkspaceAppLoader } from './client.js';
	import BillingBanner from './billing-banner.svelte';
	import NotificationsMenu from './notifications-menu.svelte';
	import { createPodCollectionTableNavigation } from './collection-table-navigation.js';
	import {
		appAccessAllowed,
		buildApplicationNavigation,
		buildSystemNavigation,
		hostAuthorizesAgentSurface,
		isHostPluginEntry,
		resolveApplicationLandingAppId,
		resolveWorkspaceOrganizationOptions,
		WORKSPACE_SETTINGS_PATH
	} from './workspace-navigation.js';
	import WorkspaceSettingsSurface from './workspace-settings-surface.svelte';
	import { workspaceSettingsApi } from './workspace-settings-api.js';
	import AgentChatPanel from './agent/agent-chat-panel.svelte';

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
		system: buildSystemNavigation({
			plugins: data.hostPlugins ?? [],
			isAdmin: data.user.role === 'admin',
			currentPath
		}),
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
	const agentSurfaceAllowed = $derived(
		hostAuthorizesAgentSurface(currentPath, data.hostPlugins ?? [])
	);

	function closeDetailSheet(): void {
		if (detailSheetOpen) platformState.navigation.pop(page.url);
	}

	function toggleDetailSheetFullscreen(): void {
		if (!topDetailFrame) return;
		detailPreferences.toggleFullScreen(topDetailFrame.collection_name);
	}

	function navigate(href: string): void {
		if (isHostPluginEntry(href, data.hostPlugins ?? [])) {
			window.location.assign(href);
			return;
		}
		void goto(href);
	}

	/**
	 * Sign out through Pod's own endpoint.
	 *
	 * The sidebar renders this control `disabled` when no handler is passed, so omitting it did not
	 * break anything visibly — it simply left a workspace nobody could sign out of, which matters now
	 * that Pod owns authentication rather than deferring to a host's `/api/auth/sign-out`.
	 *
	 * POST, because `/logout` refuses anything else: a cross-site `<img src="/logout">` would otherwise
	 * end a session on sight. The endpoint clears the cookie and answers with a redirect, but this is
	 * `fetch`, so nothing follows it on the caller's behalf — the assignment below is what actually
	 * leaves the page, and it is a full document load so the replica is torn down with the session.
	 */
	async function onSignOut(): Promise<void> {
		const response = await fetch('/logout', { method: 'POST', credentials: 'include' });
		if (!response.ok && !response.redirected) throw new Error('Unable to sign out');
		window.location.assign('/login');
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
		<div class="relative h-[clamp(8rem,24vh,18rem)] w-full overflow-clip border-b bg-muted">
			<img src={activeAppManifest.banner} alt="" class="size-full object-cover" />
		</div>
	{/if}
{/snippet}

{#snippet notifications({ expanded }: { expanded: boolean })}
	<NotificationsMenu
		{workspaceApi}
		userId={data.user.norbital_id}
		{expanded}
		onNavigate={navigate}
	/>
{/snippet}

<WorkspaceShell model={navigationModel} onNavigate={navigate} {notifications} {onSignOut}>
	<div class="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
		<BillingBanner billing={data.billing} isAdmin={data.user.role === 'admin'} {navigate} />
		{#if currentPath === '/'}
			<div class="min-h-0 flex-1 overflow-y-auto overscroll-contain">
				<div class="mx-auto flex w-full max-w-5xl flex-col gap-8 p-4 sm:p-6 lg:p-8">
					<header class="flex flex-col gap-1">
						<h1 class="text-base font-semibold text-foreground">{data.organization.name}</h1>
						<p class="text-xs text-muted-foreground">Pick an application to get started.</p>
					</header>

					<section class="flex min-w-0 flex-col gap-2">
						<h2 class="text-tiny font-medium tracking-wide text-muted-foreground uppercase">
							Applications
						</h2>
						{#if overviewApplications.length === 0}
							<div
								class="flex flex-col items-center justify-center gap-1 rounded-lg border border-dashed p-8"
							>
								<Icon icon="lucide:layout-dashboard" class="size-8 text-muted-foreground" />
								<span class="text-xs text-muted-foreground">No applications yet</span>
								<span class="max-w-72 pt-1 text-center text-micro text-muted-foreground">
									Author an app in the tenant workspace source to make it available here.
								</span>
							</div>
						{:else}
							<div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
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
										<div class="flex items-start gap-2.5 p-3">
											<div
												class="flex size-8 shrink-0 items-center justify-center rounded-md border border-input bg-background text-foreground shadow-xs"
											>
												<IconWrapper name={app.icon ?? 'lucide:file-text'} class="size-4" />
											</div>
											<div class="min-w-0 flex-1">
												<p class="truncate text-xs font-semibold text-foreground">{app.label}</p>
												{#if app.description}
													<p class="mt-0.5 line-clamp-2 text-micro leading-4 text-muted-foreground">
														{app.description}
													</p>
												{/if}
											</div>
										</div>
									</a>
								{/each}
							</div>
						{/if}
					</section>
				</div>
			</div>
		{:else if currentPath === WORKSPACE_SETTINGS_PATH || currentPath.startsWith(`${WORKSPACE_SETTINGS_PATH}/`)}
			<!-- Pod's own administration surface, not a host plugin: a workspace on `pod start` has no
			     host and still has to be able to add people to itself. -->
			<WorkspaceSettingsSurface {workspaceApi} user={data.user} api={workspaceSettingsApi} />
		{:else if agentSurfaceAllowed}
			<Bound size="full" clip class="flex-1 p-4 sm:p-6">
				<AgentChatPanel />
			</Bound>
		{:else if activeApp && accessible}
			<Bound size="full" clip class="flex-1" data-workspace-app-region>
				<Cover gap="none" top={activeAppBanner}>
					<div
						data-workspace-app-surface
						class="h-full max-h-full min-h-0 min-w-0 overflow-clip [container-name:pod-app] [container-type:inline-size]"
					>
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
					</div>
				</Cover>
			</Bound>
		{:else if appName && !accessible}
			<div class="grid min-h-0 flex-1 place-items-center p-6 text-sm text-destructive">
				Access denied
			</div>
		{:else}
			<div class="grid min-h-0 flex-1 place-items-center p-6 text-sm text-muted-foreground">
				Workspace application not found
			</div>
		{/if}
	</div>
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
		<Bound size="full" clip class="relative w-full">
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
