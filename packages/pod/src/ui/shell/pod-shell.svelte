<script lang="ts">
	import Icon from '@iconify/svelte';
	import { onDestroy, onMount, tick } from 'svelte';
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import { ManifestContext } from '@norbital-ai/platform-utils/manifest/context';
	import { page, goto } from '$lib/ui/state/router.svelte.js';
	import {
		PageSurfaceState,
		setPageSurfaceStateContext
	} from '$lib/ui/state/page_surface_state.svelte.js';
	import type {
		CollectionClient,
		ErasedCollectionRegistry
	} from '@norbital-ai/platform-utils/collection';
	import type { DetailStackEntry } from '$lib/ui/collection/detail/detail_stack.js';
	import type { TenantWorkspaceShellData } from '$lib/ui/state/workspace_shell_types.js';
	import CollectionRecordDetailFallback from '../collection/collection-record-detail-fallback.svelte';
	import DetailSurfaceStack from '../collection/detail-surface-stack.svelte';
	import * as Sheet from '@norbital-ai/ui/sheet';
	import { Button } from '@norbital-ai/ui/button';
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
	import { detectShortcutModifier, formatShortcut, shortcut } from '@norbital-ai/ui/keybindings';
	import {
		WorkspaceShell,
		type WorkspaceNavigationItem,
		type WorkspaceNavigationModel
	} from '@norbital-ai/ui/workspace-shell';
	import { IconWrapper } from '@norbital-ai/ui/icon-wrapper';
	import { AppMediaHeader } from '@norbital-ai/ui/media-banner';
	import { Bound, Center, Cover, Frame, Inline, Scroll, Stack } from '@norbital-ai/ui/layout';
	import { WorkspaceFileUploadClient } from '$lib/ui/state/workspace-file-upload.svelte.js';
	import { workspaceRuntimeOperations, type WorkspaceAppLoader } from '../state/client.js';
	import BillingBanner from './billing-banner.svelte';
	import NotificationsMenu from './notifications-menu.svelte';
	import { switchOrganization } from './organization-switch.js';
	import { createPodCollectionTableNavigation } from '../collection/collection-table-navigation.js';
	import {
		appAccessAllowed,
		buildApplicationNavigation,
		buildSystemNavigation,
		resolveAppHeaderDescription,
		resolveAppHeaderTitle,
		resolveBillingSettingsHref,
		hostPluginSurfaceHref,
		loadWorkspaceApplication,
		resolveHostPluginSurface,
		resolveApplicationLandingAppId,
		resolveWorkspaceOrganizationOptions,
		workspaceAuthorizesAgentSurface,
		workspaceProvidesAgentSurface,
		WORKSPACE_SETTINGS_PATH
	} from './workspace-navigation.js';
	import WorkspaceSettingsSurface from './workspace-settings-surface.svelte';
	import {
		setAppHeaderActionsSlot,
		type AppHeaderActionsSlot
	} from './app-header-actions.svelte.js';
	import { workspaceSettingsApi } from './workspace-settings-api.js';
	import AgentChatPanel from '../agent/agent-chat-panel.svelte';
	import NorbitalThinkingOrb from '../agent/norbital-thinking-orb.svelte';
	import { getAgentSurface } from '../agent/agent-activity-state.svelte.js';
	import { agentOrbState, agentOrbStatusKey } from '../agent/agent-orb-state.js';
	import { requestAgentComposerFocus, type AgentComposerSeed } from '../agent/composer-chrome.js';
	import OmniFinder from './omni-finder.svelte';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import { cn } from '@norbital-ai/ui/utils';
	import { writeImpersonationTeamIds } from './workspace-impersonation.js';

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
	// Open key type on purpose: the app-title chokepoint resolves `app.<id>.title`,
	// which lives in the tenant catalog and is not a compile-time pod key.
	const { t, has } = useI18n();
	const i18nResolver = { t, has };
	const platformState = new PageSurfaceState({
		getManifestContext: () => manifestContext,
		getUser: () => data.user,
		getOrganization: () => data.organization,
		getPolicyGrants: () => data.policyGrants
	});
	setPageSurfaceStateContext(() => platformState);
	const recordNavigation = createPodCollectionTableNavigation({
		getCurrentUrl: () => page.url,
		getCurrentStack: () => platformState.state.navStack,
		navigation: platformState.navigation
	});
	setCollectionTableNavigationContext(recordNavigation);

	setCollectionClientContext(() => workspaceApi);
	setDataRendererRuntimeContext({
		autocompleteGeolocation: workspaceRuntimeOperations.autocompleteGeolocation,
		/** Create a workspace-scoped file upload client for the data renderer. */
		createFileUploadClient: () => new WorkspaceFileUploadClient({ t }), // stupidity:allow Q4 -- named helper
		renderStaticMap: workspaceRuntimeOperations.renderStaticMap,
		/** Live custom-type renderer map for the data-renderer runtime. */
		get customTypeRenderers() {
			// stupidity:allow Q4 -- named helper
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
	const activeCollectionViews = new SvelteSet<string>();
	setCollectionSurfaceRuntime({
		/** Current app id that owns mounted collection views. */
		appId: () => appName, // stupidity:allow Q4 -- named helper
		/** Live collection-surface registry for the table runtime. */
		get surfaces() {
			// stupidity:allow Q4 -- named helper
			return collectionSurfaces;
		},
		/** Register a collection view key so two tables cannot claim the same view. */
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
	const activeApp = $derived(
		loadableAppName ? loadWorkspaceApplication(apps, loadableAppName) : undefined
	);
	const prefetchedSurfaces = new SvelteSet<string>();
	/** Prefetch an app module or host-plugin document so the next navigation is warm. */
	function prefetchWorkspaceSurface(href: string): void {
		if (prefetchedSurfaces.has(href)) return;
		prefetchedSurfaces.add(href);
		if (href.startsWith('/app/')) {
			const requested = decodeURIComponent(href.slice('/app/'.length).split(/[?#]/, 1)[0] ?? '');
			const name = resolveApplicationLandingAppId({
				requestedAppId: requested,
				appIds: appNames,
				apps: manifestContext.getAppsRecord(),
				accessibleAppNames: data.accessibleAppNames
			});
			if (name) void loadWorkspaceApplication(apps, name)?.catch(() => undefined);
			return;
		}
		const plugin = (data.hostPlugins ?? []).find(
			(candidate) => hostPluginSurfaceHref(candidate.key) === href
		);
		if (!plugin || typeof document === 'undefined') return;
		const link = document.createElement('link');
		link.rel = 'prefetch';
		link.as = 'document';
		link.href = plugin.entry;
		document.head.append(link);
	}
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
	let agentSheetOpen = $state(false);
	const latestPersonalAgentSession = $derived(
		workspaceApi.db.chat_session?.findFirst({
			where: { user_id: data.user.norbital_id, visibility: 'personal' },
			orderBy: { norbital_updated_at: 'desc' }
		})
	);
	const agentSurface = getAgentSurface();
	const selectedAgentSession = $derived(
		agentSurface.chatId
			? workspaceApi.db.chat_session?.findFirst({
					where: { norbital_id: agentSurface.chatId }
				})
			: undefined
	);
	const fabAgentState = $derived.by(() => {
		if (agentSurface.failed) return agentOrbState({ failed: true });
		if (agentSurface.composingNew) {
			return agentOrbState({ pending: agentSurface.pending });
		}
		const row = agentSurface.chatId
			? selectedAgentSession?.current
			: latestPersonalAgentSession?.current;
		return agentOrbState({
			pending: agentSurface.pending,
			messages: Array.isArray(row?.messages) ? row.messages : [],
			turns: Array.isArray(row?.turns) ? row.turns : []
		});
	});
	let omniOpen = $state(false);
	const failedThumbnails = new SvelteSet<string>();
	const thumbnailAttempts = new SvelteMap<string, number>();
	const thumbnailRetryTimers = new SvelteMap<string, ReturnType<typeof setTimeout>>();

	const activeAppHeaderTitle = $derived(
		appName && activeAppManifest
			? resolveAppHeaderTitle(
					i18nResolver,
					appName,
					activeAppManifest.label ?? activeAppManifest.name
				)
			: null
	);
	const activeAppHeaderDescription = $derived(
		appName && activeAppManifest
			? resolveAppHeaderDescription(i18nResolver, appName, activeAppManifest.description)
			: null
	);

	/**
	 * The running app's contribution to its own header chrome — a scope picker, usually.
	 *
	 * The shell owns app identity and paints it once on the media header. Anything that depends on
	 * app state cannot come from the manifest, so the app writes it here through `AppHeaderActions`
	 * and the header renders it at the trailing edge.
	 */
	const appHeaderActions: AppHeaderActionsSlot = $state({ current: null });
	setAppHeaderActionsSlot(appHeaderActions);

	/**
	 * Cmd+K and the FAB are the same gesture: open the agent, then hand the composer focus.
	 *
	 * The full-page /agent surface and an already-open sheet only need the focus half. A sheet
	 * mount is the slow half — its content appears in the DOM on open, but the composer sits
	 * inside a portal, so the focus request must land after the panel has mounted; `tick` is that
	 * boundary. The panel itself owns caret placement; the shell only asks for focus.
	 */
	function openAgent(seed?: AgentComposerSeed): void {
		if (agentSurfaceAllowed || agentSheetOpen) {
			requestAgentComposerFocus(seed);
			return;
		}
		agentSheetOpen = true;
		void tick().then(() => requestAgentComposerFocus(seed));
	}

	/** Cmd+/ toggles the omni finder; the finder clears its query as it closes. */
	function toggleOmniFinder(): void {
		// stupidity:allow Q4 -- template handler
		omniOpen = !omniOpen;
	}
	let shortcutModifier = $state(detectShortcutModifier());
	onMount(() => {
		shortcutModifier = detectShortcutModifier();
		for (const plugin of data.hostPlugins ?? []) {
			prefetchWorkspaceSurface(hostPluginSurfaceHref(plugin.key));
		}
	});
	const agentShortcut = $derived(formatShortcut(shortcutModifier, 'K'));
	const searchShortcut = $derived(formatShortcut(shortcutModifier, '/'));
	const impersonation = $derived(
		data.impersonation
			? {
					isAdmin: data.impersonation.isAdmin,
					isActive: data.impersonation.isActive,
					activeTeamIds: data.impersonation.activeTeamIds,
					teams: data.impersonation.teams.map((team) => ({
						id: team.norbital_id,
						name: team.name
					}))
				}
			: undefined
	);
	const applicationNavigation = $derived(
		buildApplicationNavigation({
			appIds: appNames,
			apps: manifestContext.getAppsRecord(),
			accessibleAppNames: data.accessibleAppNames,
			currentPath,
			i18n: i18nResolver
		})
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
			currentPath,
			i18n: i18nResolver
		}),
		applications: applicationNavigation,
		applicationsHref: '/'
	}));
	type OverviewApplication = Omit<WorkspaceNavigationItem, 'children'> & {
		readonly description: string | null;
		readonly thumbnail: string | null;
		readonly children: readonly OverviewApplication[];
	};

	/**
	 * The overview keeps the navigation tree intact. A group is an application holder, not an
	 * application in its own right, so only leaves receive a launch card and media treatment.
	 */
	function overviewApplication(item: WorkspaceNavigationItem): OverviewApplication {
		const manifest = manifestContext.findApp(item.key);
		const descriptionKey = `app.${item.key}.description`;
		return {
			...item,
			description: i18nResolver.has(descriptionKey)
				? i18nResolver.t(descriptionKey)
				: (manifest?.description ?? null),
			thumbnail: manifest?.thumbnail ?? null,
			children: (item.children ?? []).map(overviewApplication)
		};
	}
	const overviewApplications = $derived.by(() => applicationNavigation.map(overviewApplication));
	const agentSurfaceAllowed = $derived(workspaceAuthorizesAgentSurface(currentPath));
	/** Every tenant workspace gets the interactive agent surface; authored `+agent.ts` only customizes it. */
	const agentAvailable = $derived(workspaceProvidesAgentSurface());
	const activeHostPlugin = $derived(resolveHostPluginSurface(currentPath, data.hostPlugins ?? []));
	const billingSettingsHref = $derived(resolveBillingSettingsHref(data.hostPlugins ?? []));

	/** Pop the sidesheet detail stack when the sheet is dismissed. */
	function closeDetailSheet(): void {
		// stupidity:allow Q4 -- template handler
		if (detailSheetOpen) platformState.navigation.pop(page.url);
	}

	/** Toggle the collection-detail sidesheet between docked and fullscreen. */
	function toggleDetailSheetFullscreen(): void {
		// stupidity:allow Q3 -- template handler; stupidity:allow Q4 -- template handler
		if (!topDetailFrame) return;
		detailPreferences.toggleFullScreen(topDetailFrame.collection_name);
	}

	/** Prefetch the destination, then client-navigate without a full reload. */
	function navigate(href: string): void {
		// stupidity:allow Q4 -- template handler
		const path = href.split(/[?#]/, 1)[0] ?? href;
		if (!resolveHostPluginSurface(path, data.hostPlugins ?? [])) {
			prefetchWorkspaceSurface(href);
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
	/** End the workspace session through Pod's POST /logout. */
	async function onSignOut(): Promise<void> {
		// stupidity:allow Q3 -- template handler
		const response = await fetch('/logout', { method: 'POST', credentials: 'include' });
		if (!response.ok && !response.redirected) throw new Error('Unable to sign out');
		window.location.assign('/login');
	}

	/**
	 * Switching the impersonation scope is a cookie write and a reload: Core resolves the simulated
	 * teams from the cookie on the next request, so there is no intermediate state to keep the shell
	 * in — the reloaded shell data carries the new scope and the account menu reflects it.
	 */
	function impersonate(teamId: string): void {
		// stupidity:allow Q3 -- template handler; stupidity:allow Q4 -- template handler
		writeImpersonationTeamIds([teamId]);
		window.location.reload();
	}

	/** Clear the impersonation cookie and reload so Core drops the simulated teams. */
	function stopImpersonating(): void {
		// stupidity:allow Q3 -- template handler; stupidity:allow Q4 -- template handler
		writeImpersonationTeamIds([]);
		window.location.reload();
	}

	onDestroy(() => {
		for (const timer of thumbnailRetryTimers.values()) clearTimeout(timer);
		platformState.destroy();
	});
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
	<!--
		Rendered for a banner, and also for an app that has no banner but did register header
		actions — otherwise the picker an app handed us would have nowhere to land. A bannerless app
		that contributes nothing still gets no chrome.
	-->
	{#if activeAppManifest?.banner || appHeaderActions.current}
		<AppMediaHeader
			src={activeAppManifest?.banner ?? null}
			icon={activeAppManifest?.icon}
			title={activeAppHeaderTitle}
			description={activeAppHeaderDescription}
			actions={appHeaderActions.current ?? undefined}
		/>
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

{#snippet applicationCard({
	app,
	priority = false
}: {
	app: OverviewApplication;
	priority?: boolean;
})}
	{@const resolvedThumbnail = (() => {
		if (!app.thumbnail) return null;
		const attempt = thumbnailAttempts.get(app.key) ?? 0;
		if (attempt === 0) return app.thumbnail;
		const url = new URL(app.thumbnail, page.url);
		url.searchParams.set('pod-media-retry', String(attempt));
		return `${url.pathname}${url.search}${url.hash}`;
	})()}
	<a
		href={app.href}
		class="group w-[17rem] shrink-0 snap-start overflow-hidden rounded-xl border bg-card shadow-card outline-none transition-colors duration-150 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
		onclick={(event) => {
			event.preventDefault();
			navigate(app.href);
		}}
	>
		<Stack gap="none">
			{#if resolvedThumbnail && !failedThumbnails.has(app.key)}
				<Frame ratio="banner" shrink={false} class="bg-muted">
					<!--
						The directory already limits every group to one horizontal row. Native lazy
						loading has an observable blind spot when a card is below a nested vertical
						scroller and outside that row's horizontal viewport: Chromium may never request
						it after the user reaches the row. App media is deliberately compact (the HR
						directory is under 1 MiB in total), so start every request immediately and use
						fetch priority only to decide which four should win the connection first.
					-->
					<img
						src={resolvedThumbnail}
						alt=""
						loading="eager"
						fetchpriority={priority ? 'high' : 'auto'}
						decoding="async"
						width="544"
						height="272"
						class="size-full object-cover"
						onload={() => failedThumbnails.delete(app.key)}
						onerror={() => {
							const attempt = thumbnailAttempts.get(app.key) ?? 0;
							if (attempt >= 4) {
								failedThumbnails.add(app.key);
								return;
							}
							const existing = thumbnailRetryTimers.get(app.key);
							if (existing !== undefined) clearTimeout(existing);
							thumbnailRetryTimers.set(
								app.key,
								setTimeout(
									() => {
										thumbnailRetryTimers.delete(app.key);
										thumbnailAttempts.set(app.key, attempt + 1);
									},
									250 * 2 ** attempt
								)
							);
						}}
					/>
				</Frame>
			{:else}
				<Frame
					ratio="banner"
					shrink={false}
					class="bg-linear-to-br from-muted via-background to-brand/10"
				>
					<Inline fill justify="center" align="center" aria-hidden="true">
						<IconWrapper name={app.icon ?? 'lucide:layout-grid'} class="size-10 text-brand/45" />
					</Inline>
				</Frame>
			{/if}
			<Inline align="start" gap="sm" class="p-3">
				<Inline
					shrink={false}
					justify="center"
					align="center"
					class="size-8 rounded-md border border-input bg-background text-foreground shadow-xs"
				>
					<IconWrapper name={app.icon ?? 'lucide:file-text'} class="size-4" />
				</Inline>
				<Stack gap="xs" grow class="min-w-0">
					<p class="truncate text-xs font-semibold text-foreground">{app.label}</p>
					<p class="line-clamp-2 min-h-8 text-micro leading-4 text-muted-foreground">
						{app.description ?? ''}
					</p>
				</Stack>
			</Inline>
		</Stack>
	</a>
{/snippet}

{#snippet applicationRow({
	apps,
	priority = false
}: {
	apps: readonly OverviewApplication[];
	priority?: boolean;
})}
	<Scroll
		axis="x"
		name="overview-apps"
		layout="inline"
		gap="sm"
		class="-mx-1 snap-x snap-mandatory px-1 pb-2"
	>
		{#each apps as app, index (app.key)}
			{@render applicationCard({ app, priority: priority && index < 4 })}
		{/each}
	</Scroll>
{/snippet}

{#snippet applicationHierarchy({
	app,
	nested = false
}: {
	app: OverviewApplication;
	nested?: boolean;
})}
	{#if app.children.length === 0}
		{@render applicationCard({ app })}
	{:else}
		{@const leafApps = app.children.filter((child) => child.children.length === 0)}
		{@const childGroups = app.children.filter((child) => child.children.length > 0)}
		<Stack
			as="section"
			gap="md"
			class={nested
				? 'border-s border-border/70 ps-4'
				: 'col-span-full border-s-2 border-brand/55 ps-4'}
		>
			<Inline align="start" gap="sm">
				<Inline
					shrink={false}
					justify="center"
					align="center"
					class="size-9 rounded-md border border-border bg-background text-foreground shadow-xs"
				>
					<IconWrapper name={app.icon ?? 'lucide:folder-kanban'} class="size-4" />
				</Inline>
				<Stack gap="xs" class="min-w-0">
					<h3 class="text-sm font-semibold text-foreground">{app.label}</h3>
					{#if app.description}
						<p class="text-xs leading-5 text-muted-foreground">{app.description}</p>
					{/if}
				</Stack>
			</Inline>
			{#if leafApps.length > 0}
				{@render applicationRow({ apps: leafApps, priority: !nested })}
			{/if}
			{#each childGroups as child (child.key)}
				{@render applicationHierarchy({ app: child, nested: true })}
			{/each}
		</Stack>
	{/if}
{/snippet}

<WorkspaceShell
	model={navigationModel}
	onNavigate={navigate}
	onOrganizationChange={switchOrganization}
	onPrefetch={prefetchWorkspaceSurface}
	onSearch={toggleOmniFinder}
	searchLabel={t('pod.shell.omniTitle')}
	{searchShortcut}
	{notifications}
	{onSignOut}
	{impersonation}
	onImpersonate={impersonate}
	onStopImpersonating={stopImpersonating}
>
	<Bound size="full" clip grow>
		{#if currentPath === '/'}
			<!-- stupidity:allow UI16 -- nested Scroll is the axis=x overview-apps reel -->
			<Scroll name="Workspace overview" inset>
				<Center measure="wide">
					<Stack gap="xl" class="py-2 sm:py-4 lg:py-6">
						<Stack as="header" gap="xs">
							<h1 class="text-base font-semibold text-foreground">{data.organization.name}</h1>
							<p class="text-xs text-muted-foreground">{t('pod.shell.pickApplication')}</p>
						</Stack>

						<Stack as="section" gap="sm">
							<h2 class="text-tiny font-medium tracking-wide text-muted-foreground uppercase">
								{t('pod.shell.applications')}
							</h2>
							{#if overviewApplications.length === 0}
								<Stack
									align="center"
									justify="center"
									gap="xs"
									class="rounded-lg border border-dashed p-8"
								>
									<Icon icon="lucide:layout-dashboard" class="size-8 text-muted-foreground" />
									<span class="text-xs text-muted-foreground">{t('pod.shell.noApplications')}</span>
									<span class="max-w-72 pt-1 text-center text-micro text-muted-foreground">
										{t('pod.shell.noApplicationsHint')}
									</span>
								</Stack>
							{:else}
								<Stack gap="xl">
									{@const rootApps = overviewApplications.filter(
										(app) => app.children.length === 0
									)}
									{#if rootApps.length > 0}
										{@render applicationRow({ apps: rootApps, priority: true })}
									{/if}
									{#each overviewApplications.filter((app) => app.children.length > 0) as app (app.key)}
										{@render applicationHierarchy({ app })}
									{/each}
								</Stack>
							{/if}
						</Stack>
					</Stack>
				</Center>
			</Scroll>
		{:else if currentPath === WORKSPACE_SETTINGS_PATH || currentPath.startsWith(`${WORKSPACE_SETTINGS_PATH}/`)}
			<!-- Pod's own administration surface, not a host plugin: a workspace on `pod start` has no
			     host and still has to be able to add people to itself. -->
			<WorkspaceSettingsSurface {workspaceApi} user={data.user} api={workspaceSettingsApi} />
		{:else if agentSurfaceAllowed}
			<Bound size="full" clip grow class="p-4 sm:p-6">
				<AgentChatPanel />
			</Bound>
		{:else if activeHostPlugin}
			{#key activeHostPlugin.key}
				<iframe
					title={navigationModel.system.find((item) => item.key === activeHostPlugin.key)?.label ??
						t('pod.shell.hostSurfaceTitle')}
					src={`${activeHostPlugin.entry}${page.url.search}`}
					class="h-full min-h-0 w-full border-0 bg-background"
					data-testid="host-plugin-surface"
				></iframe>
			{/key}
		{:else if activeApp && accessible}
			<Bound size="full" clip grow data-workspace-app-region>
				<Cover gap="none" top={activeAppBanner}>
					<div
						data-workspace-app-surface
						class={cn(
							'h-full max-h-full min-h-0 min-w-0 overflow-clip [container-name:pod-app] [container-type:inline-size]',
							(activeAppManifest?.banner || appHeaderActions.current) && 'pt-2 sm:pt-3'
						)}
					>
						{#key loadableAppName}
							{#await activeApp}
								<Stack fill justify="center" align="center" class="text-sm text-muted-foreground">
									{t('pod.shell.loadingApplication')}
								</Stack>
							{:then ActiveApp}
								<ActiveApp />
							{:catch error}
								<Stack fill justify="center" align="center" class="p-6 text-sm text-destructive">
									{error instanceof Error ? error.message : String(error)}
								</Stack>
							{/await}
						{/key}
					</div>
				</Cover>
			</Bound>
		{:else if appName && !accessible}
			<Stack grow fill justify="center" align="center" class="p-6 text-sm text-destructive">
				{t('pod.shell.accessDenied')}
			</Stack>
		{:else}
			<Stack grow fill justify="center" align="center" class="p-6 text-sm text-muted-foreground">
				{t('pod.shell.appNotFound')}
			</Stack>
		{/if}
	</Bound>
</WorkspaceShell>

<svelte:window
	use:shortcut={[
		{
			ctrl: true,
			key: 'k',
			callback: () => openAgent(),
			exactMatch: true
		},
		{
			ctrl: true,
			key: 'forward slash',
			callback: toggleOmniFinder,
			exactMatch: true
		}
	]}
/>

<OmniFinder
	bind:open={omniOpen}
	{manifestContext}
	{navigationModel}
	{agentAvailable}
	onNavigate={navigate}
	onAskAgent={openAgent}
	onOpenRecord={(target) => {
		recordNavigation.open({
			collectionName: target.collectionName,
			recordId: target.recordId,
			routeKey: target.collectionName
		});
	}}
/>

<!--
	Billing toast and agent FAB sit outside WorkspaceShell / Bound so `position: fixed`
	is viewport-relative. Bound sets `container-type: inline-size`, which would otherwise
	make fixed descendants anchor to the content pane and flush against the sidebar.
-->
<BillingBanner
	billing={data.billing}
	isAdmin={data.user.role === 'admin'}
	billingHref={billingSettingsHref}
	{navigate}
/>

{#if agentAvailable && !agentSurfaceAllowed && !agentSheetOpen}
	<Button
		type="button"
		aria-label={t('pod.shell.openWorkspaceAgentWithShortcut', { shortcut: agentShortcut })}
		aria-haspopup="dialog"
		class="fixed right-4 bottom-[calc(env(safe-area-inset-bottom)+1rem)] z-40 h-11 gap-2 rounded-full bg-[#26251e] px-4 text-[#f7f7f4] shadow-lg hover:bg-[#1c1b16] sm:right-6 sm:bottom-6 dark:bg-card dark:text-card-foreground dark:shadow-black/40 dark:ring-1 dark:ring-border dark:hover:bg-accent"
		onclick={openAgent}
		data-testid="workspace-agent-trigger"
	>
		<NorbitalThinkingOrb
			state={fabAgentState}
			size={20}
			label={t('pod.shell.openWorkspaceAgent')}
		/>
		<span>{t('pod.shell.askAgent')}</span>
		<kbd
			class="pointer-events-none hidden h-5 select-none items-center rounded-md border border-white/20 bg-white/10 px-1.5 font-mono text-[10px] font-medium text-white/75 sm:inline-flex dark:border-foreground/20 dark:bg-foreground/10 dark:text-foreground/75"
			data-testid="workspace-agent-shortcut"
			aria-hidden="true">{agentShortcut}</kbd
		>
	</Button>
{/if}

{#if agentAvailable}
	<Sheet.Root bind:open={agentSheetOpen}>
		<Sheet.Content
			flush
			contained
			portalTarget="[data-slot='sidebar-inset']"
			side="right"
			class="w-[min(30rem,100%)] sm:max-w-[30rem]"
			persistenceKey="pod-workspace-agent"
			preventBackgroundClick="narrow"
			onOpenAutoFocus={(event) => {
				// The composer, not the sheet shell, owns focus: Cmd+K and the FAB both end in the
				// textarea, and the sheet would otherwise grab the caret for itself.
				event.preventDefault();
			}}
		>
			<Stack gap="none" fill>
				<Sheet.Header class="shrink-0 bg-card px-4 pt-3 pr-12 pb-1 text-left sm:px-5 sm:pr-12">
					<Inline gap="sm" align="center" class="min-w-0">
						<div
							class="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-foreground"
							data-testid="workspace-agent-orb"
						>
							<NorbitalThinkingOrb
								state={fabAgentState}
								size={28}
								label={t(agentOrbStatusKey(fabAgentState))}
							/>
						</div>
						<Sheet.Title class="min-w-0 truncate text-sm font-semibold">
							{t('pod.shell.workspaceAgentTitle')}
						</Sheet.Title>
					</Inline>
				</Sheet.Header>
				<Stack gap="none" grow>
					<AgentChatPanel headerOrb={false} />
				</Stack>
			</Stack>
		</Sheet.Content>
	</Sheet.Root>
{/if}

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
