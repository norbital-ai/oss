<script lang="ts">
	import type { Snippet } from 'svelte';
	import { onMount, tick, untrack } from 'svelte';
	import { provideI18n, uiMessages, useI18n } from '@norbital-ai/ui/i18n';
	import * as Sheet from '@norbital-ai/ui/sheet';
	import { detectShortcutModifier, formatShortcut, shortcut } from '@norbital-ai/ui/keybindings';
	import {
		WorkspaceShell,
		type WorkspaceImpersonation,
		type WorkspaceNavigationItem,
		type WorkspaceNavigationModel
	} from '@norbital-ai/ui/workspace-shell';
	import { IconWrapper } from '@norbital-ai/ui/icon-wrapper';
	import { AppMediaHeader } from '@norbital-ai/ui/media-banner';
	import { Bound, Center, Cover, Frame, Inline, Scroll, Stack } from '@norbital-ai/ui/layout';
	import AgentChatPanel from '../agent/agent-chat-panel.svelte';
	import { ThinkingOrb as NorbitalThinkingOrb } from '@norbital-ai/ui/thinking-orb';
	import AgentTrigger from './agent-trigger.svelte';
	import { requestAgentComposerFocus, type AgentComposerSeed } from '../agent/composer-chrome.js';
	import { getAgentSurface } from '../agent/agent-activity-state.svelte.js';
	import { agentOrbState, agentOrbStatusKey } from '../agent/agent-orb-state.js';
	import { getAgentRuntime } from '../agent/client.js';
	import { setBoltMentionCatalog } from '../agent/mention-catalog.js';
	import { mergeBoltAgentMessages, type TenantMessageCatalogs } from '../agent/i18n.js';
	import {
		setAppHeaderActionsSlot,
		type AppHeaderActionsSlot
	} from './app-header-actions.svelte.js';
	import {
		setPlatformStateContext,
		type PlatformChannel,
		type PlatformState
	} from '../state/platform.js';
	import { CollectionTableNavigationSurface } from '@norbital-ai/ui/collection-table';
	import BillingBanner from './billing-banner.svelte';
	import OmniFinder from './omni-finder.svelte';
	import Notifications from './notifications.svelte';
	import {
		AGENT_PATH,
		buildApplicationNavigation,
		buildSystemNavigation,
		resolveAppHeaderDescription,
		resolveAppHeaderTitle,
		filterAccessibleApps,
		resolveHostPluginSurface,
		resolveWorkspaceOrganizationOptions,
		WORKSPACE_SETTINGS_PATH,
		type HostPlugin
	} from './workspace-navigation.js';

	let {
		app = 'Bolt',
		status = 'ready',
		offline = false,
		organization,
		organizations = [],
		user,
		apps = [],
		accessibleApps = null,
		current = '',
		path,
		search = '',
		plugins = [],
		isAdmin,
		impersonation = null,
		onImpersonate,
		onStopImpersonating,
		headerTitle,
		headerDescription,
		headerIcon,
		headerBanner,
		headerActions,
		tenantMessages,
		children,
		onNavigate,
		onOrganizationChange,
		onSignOut,
		onSearch,
		onOpenRecord
	}: {
		app?: string;
		status?: 'starting' | 'syncing' | 'ready' | 'error';
		offline?: boolean;
		tenantMessages?: TenantMessageCatalogs;
		organization?: { id: string; name: string; logoUrl?: string | null };
		organizations?: ReadonlyArray<{
			readonly organizationId: string;
			readonly organizationName: string;
			readonly logoUrl: string | null;
		}>;
		user?: {
			/**
			 * The viewer's `norbital_id`, and the only thing a workspace can key its own rows by.
			 *
			 * Carried explicitly because the platform context published `norbital_id: user.name` —
			 * the local part of an email address — and every authored query of the shape
			 * `where: { user_id: { eq: user.norbital_id } }` therefore sent `'dion.neo'` to a `uuid`
			 * column and failed with 22P02. It read as "could not load your profile", so the surface
			 * had never worked for anybody, contractor or administrator.
			 */
			id: string;
			name: string;
			email: string;
			role: string;
			avatarUrl?: string | null;
			teamLabels: string[];
		};
		apps?: ReadonlyArray<
			| string
			| {
					name: string;
					label: string;
					icon?: string;
					description?: string | null;
					banner?: string;
					parent?: string;
			  }
		>;
		/**
		 * The app names this session may see, as `AccessControl.visibleApps` computed them.
		 *
		 * `apps` above is the *compiled* registry — everything the workspace ships, which is what the
		 * host can enumerate locally and is deliberately not a statement about who may open any of it.
		 * This is the second half, and only the host can fetch it: the policies live in the tenant
		 * runtime, so the answer arrives over the wire rather than out of the bundle.
		 *
		 * `null` means the host never restricted the workspace, which is how every host that predates
		 * this behaved and still behaves. An empty array is a different claim — "this session may see
		 * nothing" — and is honoured as one.
		 */
		accessibleApps?: ReadonlyArray<string> | null;
		current?: string;
		path?: string;
		/**
		 * The live query string. The detail stack lives in `?stack=`, and `window.location.search` is
		 * not reactive — without the host passing it, the detail surface never saw a record open.
		 */
		search?: string;
		plugins?: ReadonlyArray<HostPlugin>;
		isAdmin?: boolean;
		/**
		 * The admin team-preview state the sidebar's account menu renders, or `null` for no menu.
		 *
		 * Forwarded to `<WorkspaceShell>` and read nowhere else here. The sidebar has carried the
		 * picker since it was written, but this was the only component that mounts the shell and it
		 * passed none of the three props — so `impersonationAvailable` was `false` for every host and
		 * the menu had never rendered anywhere.
		 *
		 * Who qualifies and what the teams are is the host's answer, not the shell's: only the tenant
		 * runtime holds the compiled policy list and the credential's roles at the same time.
		 */
		impersonation?: WorkspaceImpersonation | null;
		/** Preview the workspace under one team's policy. The host owns storing and applying it. */
		onImpersonate?: (teamId: string) => void | Promise<void>;
		/** Return to the real subject. */
		onStopImpersonating?: () => void | Promise<void>;
		headerTitle?: string;
		headerDescription?: string | null;
		headerIcon?: string;
		/** Authored `bolt:banner` image for the active app; the header renders flat without one. */
		headerBanner?: string | null;
		/** App-contributed header controls — the entity picker lands here rather than in its own bar. */
		headerActions?: Snippet;
		children?: Snippet;
		onNavigate?: (href: string) => void;
		onOrganizationChange?: (id: string) => void;
		onSignOut?: () => void;
		onSearch?: () => void;
		onOpenRecord?: (target: { collectionName: string; recordId: string }) => void;
	} = $props();

	provideI18n(untrack(() => mergeBoltAgentMessages(uiMessages, tenantMessages)));

	// The running app registers its trailing header controls here; the banner renders them.
	const appHeaderActionsSlot = $state<AppHeaderActionsSlot>({ current: null });
	const appHeaderActions = setAppHeaderActionsSlot(appHeaderActionsSlot);

	/**
	 * Who the workspace is being used by, for authored pages that ask.
	 *
	 * `setPlatformStateContext` was exported and never called, so any page reading it — the whole
	 * Employee Self-Service app — threw `missing_context` and rendered an empty body. The getter is
	 * a function so a page reads the current value rather than a snapshot taken at mount.
	 */
	setPlatformStateContext((): PlatformState => ({
		user: {
			// The row's key, not a label. A name here is what made `user_id = 'dion.neo'` reach a uuid.
			norbital_id: user?.id ?? 'unknown',
			...(user?.email === undefined ? {} : { email: user.email }),
			/**
			 * Administration, taken from the runtime rather than from the host's `user` summary.
			 *
			 * `impersonation` is the answer to `access.impersonation`, whose `isAdmin` is
			 * `AccessControl.mayImpersonate` — which is now exactly the `admin` status on the caller's
			 * own `bolt_auth_user` row. So this is the same proven fact the sidebar's team picker is
			 * offered on, read once and shared, rather than a second boolean a host would have to
			 * remember to pass and could get wrong.
			 *
			 * It is deliberately not derived from `user.role`: a workspace may name a role anything at
			 * all, and one of them being spelled "Admin" must not confer authority.
			 *
			 * A preview narrows it, and correctly: `subjectAsTeam` clears the flag, so mid-preview the
			 * runtime reports the previewed subject's authority and administrator-only surfaces fold
			 * away with the rest — which is what a preview is for. `isAdmin` on this payload is
			 * answered from the real actor so the picker itself survives; `isActive` is what says a
			 * preview is running.
			 */
			admin: impersonation?.isAdmin === true && !(impersonation?.isActive ?? false)
		},
		apps: visibleApps.map(({ name }) => name),
		channels: declaredChannels
	}));

	// Loaded after mount, which is why the context above is a getter over this rather than a snapshot.
	let declaredChannels = $state<ReadonlyArray<PlatformChannel>>([]);

	const { t, has } = useI18n();

	// A bare string carries no description; an entry object keeps whatever it declared, so the
	// mention catalog and finder can show it.
	const normalizedApps = $derived.by(() =>
		apps.map((entry) =>
			typeof entry === 'string'
				? { name: entry, label: entry, description: null as string | null }
				: { ...entry, description: entry.description ?? null }
		)
	);

	/**
	 * The same registry with everything this session may not see removed.
	 *
	 * The sidebar is not the only surface that lists apps. `OmniFinder` reads `navigationModel`, so it
	 * inherits the filter for free — but the agent's mention catalog and the `platform.apps` an
	 * authored page reads were both built straight off the full registry, so an app hidden from the
	 * sidebar was still offered by `@` in the composer and still named to any page that asked. One
	 * filter, applied where the list is first narrowed, keeps those three answers agreeing.
	 */
	const visibleApps = $derived(filterAccessibleApps(normalizedApps, accessibleApps));

	const currentPath = $derived(path ?? (current ? `/app/${current}` : '/'));

	/**
	 * The URL a collection detail stack is read from and written to.
	 *
	 * `CollectionTableNavigationSurface` owns the rest — the navigation context every `CollectionTable`
	 * requires, the registration bookkeeping, and the sheet the record renders in. Without it mounted,
	 * opening any row threw "CollectionTable requires a record navigation provider": nothing in Bolt
	 * had ever provided one.
	 */
	const detailUrl = $derived(
		new URL(
			`${currentPath}${search}`,
			typeof window === 'undefined' ? 'http://workspace.invalid' : window.location.origin
		)
	);

	const resolvedHeaderTitle = $derived(
		currentPath.startsWith('/app/')
			? resolveAppHeaderTitle({ has, t }, currentPath.slice('/app/'.length), headerTitle ?? app)
			: (headerTitle ?? app)
	);
	const resolvedHeaderDescription = $derived(
		currentPath.startsWith('/app/')
			? resolveAppHeaderDescription(
					{ has, t },
					currentPath.slice('/app/'.length),
					headerDescription
				)
			: (headerDescription ?? null)
	);

	const activeOrganization = $derived({
		id: organization?.id ?? 'workspace',
		name: organization?.name ?? app,
		logoUrl: organization?.logoUrl ?? null
	});

	const navigationModel = $derived({
		activeOrganization,
		organizations: resolveWorkspaceOrganizationOptions({
			activeOrganization,
			organizations
		}),
		user: user ?? {
			name: 'Workspace user',
			email: '',
			role: 'Member',
			teamLabels: []
		},
		system: buildSystemNavigation({
			plugins,
			isAdmin: isAdmin ?? true,
			currentPath,
			i18n: { has, t }
		}),
		applications: buildApplicationNavigation({
			apps: normalizedApps,
			// The unfiltered registry plus the grant list, rather than `visibleApps` already narrowed:
			// the builder owns this rule for every caller, and handing it both keeps the one place that
			// decides what a group's survival means from depending on who called it.
			accessibleAppNames: accessibleApps,
			currentPath,
			i18n: { has, t }
		}),
		applicationsHref: '/'
	} satisfies WorkspaceNavigationModel);

	const statusLabel = $derived(offline ? 'Offline' : status === 'ready' ? 'Up to date' : status);

	const onAgentPath = $derived(
		currentPath === AGENT_PATH || currentPath.startsWith(`${AGENT_PATH}/`)
	);

	const agentSurface = getAgentSurface();
	const fabAgentState = $derived(
		agentOrbState({
			pending: agentSurface.pending,
			failed: agentSurface.failed
		})
	);

	const activeHostPlugin = $derived(resolveHostPluginSurface(currentPath, plugins));

	let finderOpen = $state(false);
	let agentSheetOpen = $state(false);
	let finderCollections = $state<readonly string[]>([]);
	let shortcutModifier = $state(detectShortcutModifier());
	let notificationItems = $state<
		ReadonlyArray<{ readonly id: string; readonly text: string; readonly read: boolean }>
	>([]);
	let notificationsLoading = $state(false);
	let notificationsError = $state<string | undefined>(undefined);

	const isRecord = (value: unknown): value is Record<string, unknown> =>
		value !== null && typeof value === 'object' && !Array.isArray(value);

	const stringField = (value: Record<string, unknown>, key: string): string | undefined => {
		const field = value[key];
		return typeof field === 'string' && field.length > 0 ? field : undefined;
	};

	const notificationText = (payload: unknown): string => {
		if (typeof payload === 'string' && payload.length > 0) return payload;
		if (!isRecord(payload)) return 'Notification';
		return (
			stringField(payload, 'text') ??
			stringField(payload, 'message') ??
			stringField(payload, 'title') ??
			'Notification'
		);
	};

	const parseNotificationItems = (
		value: unknown
	): ReadonlyArray<{ readonly id: string; readonly text: string; readonly read: boolean }> => {
		if (!Array.isArray(value)) return [];
		const items: Array<{ readonly id: string; readonly text: string; readonly read: boolean }> = [];
		for (const entry of value) {
			if (!isRecord(entry)) continue;
			const id = stringField(entry, 'id');
			if (id === undefined) continue;
			items.push({
				id,
				text: notificationText(entry.payload),
				read: entry.read === true
			});
		}
		return items;
	};

	/**
	 * The channels out of `workspace.manifest`, dropped rather than defaulted when a field is missing.
	 *
	 * A channel whose `audience` did not arrive is not a private channel, and guessing one would put
	 * an outsider's thread into every member's conversation list. The manifest always carries all
	 * three, so an entry missing one is a projection that changed underneath this reader.
	 */
	const parseDeclaredChannels = (value: unknown): ReadonlyArray<PlatformChannel> => {
		if (!Array.isArray(value)) return [];
		const declared: Array<PlatformChannel> = [];
		for (const entry of value) {
			if (!isRecord(entry)) continue;
			const name = stringField(entry, 'name');
			const transport = stringField(entry, 'transport');
			const audience = stringField(entry, 'audience');
			if (name === undefined || transport === undefined || audience === undefined) continue;
			declared.push({ name, transport, audience });
		}
		return declared;
	};

	const loadDeclaredChannels = async (): Promise<void> => {
		const runtime = getAgentRuntime();
		if (runtime === undefined) return;
		try {
			const summary = await runtime.transport.command('workspace.manifest', {});
			declaredChannels = parseDeclaredChannels(isRecord(summary) ? summary.channels : undefined);
		} catch {
			// An unread channel list is an absent one. The conversation selector then offers only the
			// threads that exist, which is what it did before any channel was published at all.
			declaredChannels = [];
		}
	};

	const loadNotifications = async (): Promise<void> => {
		const runtime = getAgentRuntime();
		if (runtime === undefined) {
			notificationItems = [];
			notificationsError = undefined;
			return;
		}
		notificationsLoading = true;
		notificationsError = undefined;
		try {
			notificationItems = parseNotificationItems(
				await runtime.transport.command('notifications.list', { recipient: runtime.userId })
			);
		} catch (cause) {
			notificationsError = cause instanceof Error ? cause.message : 'Could not load notifications';
		} finally {
			notificationsLoading = false;
		}
	};

	const markNotificationRead = (id: string): void => {
		const runtime = getAgentRuntime();
		notificationItems = notificationItems.map((item) =>
			item.id === id ? { ...item, read: true } : item
		);
		if (runtime === undefined) return;
		void runtime.transport
			.command('notifications.markRead', { recipient: runtime.userId, id })
			.catch(() => undefined);
	};

	const syncMentionCatalog = (): void => {
		setBoltMentionCatalog({
			collections: finderCollections,
			apps: visibleApps.map((app) => ({
				key: app.name,
				label: app.label,
				href: `/app/${app.name}`,
				// `'x' in app` is a presence test that leaves the value as `{}`; the type check narrows it.
				description: app.description
			}))
		});
	};

	const loadFinderCollections = async (): Promise<void> => {
		const runtime = getAgentRuntime();
		if (runtime === undefined) {
			finderCollections = [];
			syncMentionCatalog();
			return;
		}
		try {
			const shape = await runtime.transport.command('sync.shape', { subject: runtime.subject });
			finderCollections = Array.isArray(shape)
				? shape.filter((entry): entry is string => typeof entry === 'string')
				: [];
		} catch {
			finderCollections = [];
		}
		syncMentionCatalog();
	};

	$effect(() => {
		syncMentionCatalog();
	});

	onMount(() => {
		shortcutModifier = detectShortcutModifier();
		void loadNotifications();
		void loadFinderCollections();
		void loadDeclaredChannels();
	});

	$effect(() => {
		if (onAgentPath) {
			agentSheetOpen = true;
		}
	});

	const agentShortcut = $derived(formatShortcut(shortcutModifier, 'K'));
	const searchShortcut = $derived(formatShortcut(shortcutModifier, '/'));

	function navigate(href: string): void {
		onNavigate?.(href);
	}

	function toggleFinder(): void {
		finderOpen = !finderOpen;
		onSearch?.();
	}

	function openAgent(seed?: AgentComposerSeed): void {
		if (agentSheetOpen) {
			requestAgentComposerFocus(seed);
			return;
		}
		agentSheetOpen = true;
		void tick().then(() => requestAgentComposerFocus(seed));
	}

	function closeAgentSheet(next: boolean): void {
		agentSheetOpen = next;
		if (!next && onAgentPath) {
			navigate('/');
		}
	}

	function openRecord(target: { collectionName: string; recordId: string }): void {
		onOpenRecord?.(target);
	}
</script>

{#snippet activeAppBanner()}
	<AppMediaHeader
		src={headerBanner ?? null}
		icon={headerIcon ?? 'lucide:layout-grid'}
		title={resolvedHeaderTitle ?? ''}
		description={resolvedHeaderDescription ?? null}
		actions={headerActions ?? appHeaderActions.current ?? undefined}
	/>
{/snippet}

{#snippet applicationCard(app: WorkspaceNavigationItem)}
	<a
		href={app.href}
		class="group w-[17rem] shrink-0 snap-start overflow-hidden rounded-xl border bg-card shadow-card outline-none transition-colors duration-150 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
		onclick={(event) => {
			event.preventDefault();
			navigate(app.href);
		}}
	>
		<Stack gap="none">
			<Frame
				ratio="banner"
				shrink={false}
				class="bg-linear-to-br from-muted via-background to-brand/10"
			>
				{#if app.thumbnail}
					<!--
						The authored thumbnail, which the workspace already publishes and this card ignored:
						every app rendered as the same icon on the same gradient, so the overview could not
						tell one from another at a glance.
					-->
					<img src={app.thumbnail} alt="" class="size-full object-cover" loading="lazy" />
				{:else}
					<Inline fill justify="center" align="center" aria-hidden="true">
						<IconWrapper name={app.icon ?? 'lucide:layout-grid'} class="size-10 text-brand/45" />
					</Inline>
				{/if}
			</Frame>
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
						<!-- The authored description. "Open X" restated the title and said nothing. -->
						{app.description ?? ''}
					</p>
				</Stack>
			</Inline>
		</Stack>
	</a>
{/snippet}

<output class="sr-only" aria-live="polite" data-status={status}>
	{statusLabel}
</output>

<WorkspaceShell
	model={navigationModel}
	onNavigate={navigate}
	{onOrganizationChange}
	{onSignOut}
	onSearch={toggleFinder}
	searchLabel={t('bolt.shell.omniTitle')}
	{searchShortcut}
	{impersonation}
	{onImpersonate}
	{onStopImpersonating}
>
	{#snippet agent({ expanded })}
		<AgentTrigger
			state={fabAgentState}
			label={t('bolt.shell.askAgent')}
			shortcut={agentShortcut}
			{expanded}
			onclick={() => openAgent()}
		/>
	{/snippet}
	{#snippet notifications({ expanded })}
		<Notifications
			{expanded}
			items={notificationItems}
			loading={notificationsLoading}
			error={notificationsError}
			onread={markNotificationRead}
			onretry={() => {
				void loadNotifications();
			}}
		/>
	{/snippet}
	<Bound size="full" clip>
		{#if currentPath === '/' || onAgentPath}
			<Scroll name="Workspace overview" inset>
				<Center measure="wide">
					<Stack gap="xl" class="py-2 sm:py-4 lg:py-6">
						<Stack as="header" gap="xs">
							<h1 class="text-base font-semibold text-foreground">{activeOrganization.name}</h1>
							<p class="text-meta">Pick an application</p>
						</Stack>

						<Stack as="section" gap="sm">
							<h2 class="text-overline">Applications</h2>
							{#if navigationModel.applications.length === 0}
								<Stack
									align="center"
									justify="center"
									gap="xs"
									class="rounded-lg border border-dashed p-8"
								>
									<IconWrapper
										name="lucide:layout-dashboard"
										class="size-8 text-muted-foreground"
									/>
									<span class="text-meta">No applications yet</span>
									<span class="max-w-72 pt-1 text-center text-micro text-muted-foreground">
										Add an application to this workspace to see it here.
									</span>
								</Stack>
							{:else}
								<!--
									A group is a heading over its own apps, not a card standing in for them. Rendering
									every entry flat put "HR Controller" beside its own children as though it were a
									sibling, and gave a card to something you cannot actually open.
								-->
								{@const standalone = navigationModel.applications.filter(
									(app) => (app.children?.length ?? 0) === 0
								)}
								{@const grouped = navigationModel.applications.filter(
									(app) => (app.children?.length ?? 0) > 0
								)}
								{#if standalone.length > 0}
									<Scroll
										axis="x"
										name="overview-apps"
										layout="inline"
										gap="sm"
										class="-mx-1 snap-x snap-mandatory px-1 pb-2"
									>
										{#each standalone as app (app.key)}
											{@render applicationCard(app)}
										{/each}
									</Scroll>
								{/if}
								{#each grouped as group (group.key)}
									<Stack as="section" gap="sm" class="border-l-2 border-brand/40 pl-3">
										<Inline gap="sm" align="center">
											<Inline
												shrink={false}
												justify="center"
												align="center"
												class="size-8 rounded-md border border-input bg-background text-foreground shadow-xs"
											>
												<IconWrapper name={group.icon ?? 'lucide:layout-grid'} class="size-4" />
											</Inline>
											<Stack gap="xs" class="min-w-0">
												<p class="truncate text-sm font-semibold text-foreground">{group.label}</p>
												{#if group.description}
													<p class="text-micro text-muted-foreground">{group.description}</p>
												{/if}
											</Stack>
										</Inline>
										<Scroll
											axis="x"
											name={`overview-group-${group.key}`}
											layout="inline"
											gap="sm"
											class="-mx-1 snap-x snap-mandatory px-1 pb-2"
										>
											{#each group.children ?? [] as child (child.key)}
												{@render applicationCard(child)}
											{/each}
										</Scroll>
									</Stack>
								{/each}
							{/if}
						</Stack>
					</Stack>
				</Center>
			</Scroll>
		{:else if currentPath === WORKSPACE_SETTINGS_PATH || currentPath.startsWith(`${WORKSPACE_SETTINGS_PATH}/`) || activeHostPlugin}
			{#key activeHostPlugin?.key ?? WORKSPACE_SETTINGS_PATH}
				<Bound size="full" clip data-testid="host-plugin-surface" class="bg-background">
					{@render children?.()}
				</Bound>
			{/key}
		{:else}
			<!--
				`gap="none"` sat the app's first row flush against the banner image, so a tab strip began
				on the pixel the artwork ended. The banner is a header, not a border: the content below it
				needs the same separation any other section gets.
			-->
			<Cover gap="md" top={resolvedHeaderTitle ? activeAppBanner : undefined}>
				<Bound size="full" clip data-workspace-app-surface class="[container-name:bolt-app]">
					<CollectionTableNavigationSurface url={detailUrl} navigate={(href) => onNavigate?.(href)}>
						{@render children?.()}
					</CollectionTableNavigationSurface>
				</Bound>
			</Cover>
		{/if}
	</Bound>
</WorkspaceShell>

<svelte:window
	use:shortcut={[
		{
			ctrl: true,
			key: 'k',
			// The shortcut hands the callback a KeyboardEvent; `openAgent` takes an optional composer
			// seed, so passing it directly would forward the event as the seed.
			callback: () => openAgent(),
			exactMatch: true
		},
		{
			ctrl: true,
			key: 'forward slash',
			callback: toggleFinder,
			exactMatch: true
		}
	]}
/>

<OmniFinder
	bind:open={finderOpen}
	collections={finderCollections}
	{navigationModel}
	agentAvailable={true}
	onNavigate={navigate}
	onAskAgent={openAgent}
	onOpenRecord={openRecord}
/>

<BillingBanner fixed />

<Sheet.Root open={agentSheetOpen} onOpenChange={closeAgentSheet}>
	<Sheet.Content
		flush
		contained
		portalTarget="[data-slot='sidebar-inset']"
		side="right"
		class="flex h-full w-[min(30rem,100%)] flex-col sm:max-w-[30rem]"
		persistenceKey="bolt-workspace-agent"
		preventBackgroundClick="narrow"
		onOpenAutoFocus={(event) => {
			event.preventDefault();
		}}
	>
		<Stack gap="none" fill class="min-h-0">
			<Sheet.Header class="shrink-0 bg-card px-4 pt-3 pr-12 pb-1 text-left sm:px-5 sm:pr-12">
				<Inline gap="sm" align="center" class="min-w-0">
					<div
						class="grid size-4 shrink-0 place-items-center text-foreground"
						data-testid="workspace-agent-orb"
					>
						<NorbitalThinkingOrb
							state={fabAgentState}
							size={16}
							label={t(agentOrbStatusKey(fabAgentState))}
						/>
					</div>
					<Sheet.Title class="min-w-0 truncate text-sm font-semibold">
						{t('bolt.shell.workspaceAgentTitle')}
					</Sheet.Title>
				</Inline>
			</Sheet.Header>
			<Stack gap="none" grow class="min-h-0">
				<AgentChatPanel headerOrb={false} />
			</Stack>
		</Stack>
	</Sheet.Content>
</Sheet.Root>

{#if offline}
	<p class="sr-only" role="status">Changes will be queued until the connection returns.</p>
{:else if status === 'error'}
	<p class="sr-only" role="alert">The application could not finish loading.</p>
{/if}

<style>
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}
</style>
