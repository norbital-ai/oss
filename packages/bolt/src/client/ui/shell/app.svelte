<script lang="ts">
	import type { Snippet } from 'svelte';
	import { Stack } from '@norbital-ai/ui/layout';
	import { Toaster } from '@norbital-ai/ui/sonner';
	import Shell from './shell.svelte';
	import type { TenantMessageCatalogs } from '../agent/i18n.js';
	import type { HostPlugin } from './workspace-navigation.js';

	const DEFAULT_PLUGINS: HostPlugin[] = [
		{
			key: 'workspace-studio',
			label: 'Workspace Studio',
			icon: 'product:studio',
			entry: '/__host/workspace-studio',
			placement: 'sidebar',
			adminOnly: true
		},
		{
			key: 'organization',
			label: 'Organization',
			icon: 'lucide:building-2',
			entry: '/__host/organization',
			placement: 'settings',
			adminOnly: true
		},
		{
			// The surface configures the channels an agent is reachable on, so it is named for the
			// agent rather than for the plumbing underneath it.
			key: 'agent',
			label: 'Agents',
			icon: 'lucide:bot',
			entry: '/__host/agent',
			placement: 'settings',
			adminOnly: true
		},
		{
			// Split from the agent channels: a channel is a transport a workspace talks over, a secret
			// is a value it needs to talk at all. Putting both behind one label meant neither had a
			// form — one page cannot be driven by declared channels and declared environment at once.
			// "Environment secrets" is the name the vault has: it is backed by the workspace's own
			// reserved root `+env.ts`.
			key: 'environment_secrets',
			label: 'Environment secrets',
			icon: 'lucide:key-round',
			entry: '/__host/environment_secrets',
			placement: 'settings',
			adminOnly: true
		}
	];

	let {
		title = 'Bolt',
		apps = [],
		current = '',
		path,
		search = '',
		loading = false,
		error,
		organization,
		organizations = [],
		user,
		plugins = DEFAULT_PLUGINS,
		isAdmin = true,
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
		current?: string;
		path?: string;
		/** Live query string, forwarded to the detail surface that reads `?stack=`. */
		search?: string;
		loading?: boolean;
		error?: string;
		organization?: { id: string; name: string; logoUrl?: string | null };
		organizations?: Array<{
			organizationId: string;
			organizationName: string;
			logoUrl: string | null;
		}>;
		user?: {
			name: string;
			email: string;
			role: string;
			avatarUrl?: string | null;
			teamLabels: string[];
		};
		plugins?: HostPlugin[];
		isAdmin?: boolean;
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
		activeApp !== undefined && typeof activeApp !== 'string' ? (activeApp.description ?? null) : null
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
	{current}
	{path}
	{search}
	{status}
	{organization}
	{organizations}
	{user}
	{plugins}
	{isAdmin}
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
