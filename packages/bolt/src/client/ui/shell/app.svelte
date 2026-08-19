<script lang="ts">
	import type { Snippet } from 'svelte';
	import { Stack } from '@norbital-ai/ui/layout';
	import { Toaster } from '@norbital-ai/ui/sonner';
	import type { WorkspaceImpersonation } from '@norbital-ai/ui/workspace-shell';
	import Shell from './shell.svelte';
	import type { TenantMessageCatalogs } from '../agent/i18n.js';
	import type { HostPlugin } from './workspace-navigation.js';

	let {
		title = 'Bolt',
		apps = [],
		accessibleApps = null,
		current = '',
		path,
		search = '',
		loading = false,
		error,
		organization,
		organizations = [],
		user,
		plugins,
		isAdmin = true,
		impersonation = null,
		onImpersonate,
		onStopImpersonating,
		tenantMessages,
		children,
		onNavigate,
		onOrganizationChange,
		onSignOut,
		onretry,
		headerActions
	}: {
		title?: string;
		apps?: ReadonlyArray<
			| string
			| {
					name: string;
					label: string;
					icon?: string;
					description?: string;
					banner?: string;
					parent?: string;
			  }
		>;
		/**
		 * Which of `apps` this session may see, from the host's `apps.visible` read.
		 *
		 * Forwarded verbatim to the shell and nowhere else: this component still resolves the active
		 * app's title, icon and banner out of the *full* registry, because the header describes the
		 * page that is open and a page reached by URL is not made unreachable by being unlisted. What
		 * this gates is what the workspace *offers* — the sidebar, the overview, the finder, the
		 * mention catalog — while the runtime stays the authority on what the page may read.
		 *
		 * `null` (the default) is "unrestricted", so a host that passes nothing keeps today's shell.
		 */
		accessibleApps?: ReadonlyArray<string> | null;
		current?: string;
		path?: string;
		/** Live query string, forwarded to the detail surface that reads `?stack=`. */
		search?: string;
		loading?: boolean;
		error?: string;
		organization?: { id: string; name: string; logoUrl?: string | null };
		organizations?: ReadonlyArray<{
			readonly organizationId: string;
			readonly organizationName: string;
			readonly logoUrl: string | null;
		}>;
		user?: {
			name: string;
			email: string;
			role: string;
			avatarUrl?: string | null;
			teamLabels: string[];
		};
		/**
		 * The surfaces this workspace offers beside its own apps.
		 *
		 * Required, and no default. There used to be a `DEFAULT_PLUGINS` list here that no caller ever
		 * took, because the only caller passed its own identical copy — a default that reads as the
		 * authority and is not one.
		 */
		plugins: ReadonlyArray<HostPlugin>;
		isAdmin?: boolean;
		/**
		 * Admin team preview, forwarded verbatim to the shell.
		 *
		 * Only the host can build it — the teams are the tenant's compiled policies and whether this
		 * session may impersonate is a fact about its credential — so this component neither derives
		 * nor defaults it. `null` is "no picker", which is what every host that supplies nothing gets.
		 */
		impersonation?: WorkspaceImpersonation | null;
		onImpersonate?: (teamId: string) => void | Promise<void>;
		onStopImpersonating?: () => void | Promise<void>;
		tenantMessages?: TenantMessageCatalogs;
		/** App-contributed header controls, rendered inside the banner rather than above the tabs. */
		headerActions?: Snippet;
		children?: Snippet;
		onNavigate?: (href: string) => void;
		onOrganizationChange?: (id: string) => void;
		onSignOut?: () => void;
		onretry?: () => void;
	} = $props();

	const status = $derived(error !== undefined ? 'error' : loading ? 'syncing' : 'ready');
	const currentPath = $derived(path ?? (current ? `/app/${current}` : '/'));
	const activeApp = $derived.by(() => {
		if (!currentPath.startsWith('/app/')) return undefined;
		const name = currentPath.slice('/app/'.length);
		return apps.find((entry) => (typeof entry === 'string' ? entry : entry.name) === name);
	});
	const activeAppTitle = $derived(
		activeApp === undefined
			? title
			: typeof activeApp === 'string'
				? activeApp
				: activeApp.label || activeApp.name
	);
	const activeAppDescription = $derived(
		activeApp !== undefined && typeof activeApp !== 'string'
			? (activeApp.description ?? null)
			: null
	);
	const activeAppIcon = $derived(
		activeApp !== undefined && typeof activeApp !== 'string' ? activeApp.icon : undefined
	);
	const activeAppBanner = $derived(
		activeApp !== undefined && typeof activeApp !== 'string' ? (activeApp.banner ?? null) : null
	);
</script>

<Toaster />

<Shell
	app={title}
	headerTitle={activeAppTitle}
	headerDescription={activeAppDescription}
	headerIcon={activeAppIcon}
	headerBanner={activeAppBanner}
	{headerActions}
	{apps}
	{accessibleApps}
	{current}
	{path}
	{search}
	{status}
	{organization}
	{organizations}
	{user}
	{plugins}
	{isAdmin}
	{impersonation}
	{onImpersonate}
	{onStopImpersonating}
	{tenantMessages}
	{onNavigate}
	{onOrganizationChange}
	{onSignOut}
>
	{#if error !== undefined}
		<!-- The retry sits under the message on the parent's gap, not on its own sibling margin. -->
		<Stack as="section" gap="sm" role="alert" class="p-6 text-sm text-destructive">
			<p>{error}</p>
			{#if onretry}
				<button type="button" class="underline" onclick={onretry}>Try again</button>
			{/if}
		</Stack>
	{:else if loading}
		<p role="status" class="p-6 text-sm text-muted-foreground">Loading workspace…</p>
	{:else}
		{@render children?.()}
	{/if}
</Shell>
