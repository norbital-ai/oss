<script lang="ts">
	import WorkspaceShellFrame from './workspace-shell-frame.svelte';
	import type { Snippet } from 'svelte';
	import { Inline } from '#lib/layout';
	import { Spinner } from '#lib/spinner';
	import type {
		WorkspaceNavigationModel,
		WorkspaceOrganizationOption
	} from './workspace-shell.types.js';
	import WorkspaceSidebar from './workspace-sidebar.svelte';

	let {
		model,
		onNavigate,
		onPrefetch,
		onOrganizationChange,
		onSignOut,
		notifications,
		children
	}: {
		model: WorkspaceNavigationModel;
		onNavigate?: (href: string) => void;
		onPrefetch?: (href: string) => void;
		onOrganizationChange?: (organizationId: string) => void | Promise<void>;
		onSignOut?: () => void | Promise<void>;
		/**
		 * The account area's notification surface, rendered above the user menu.
		 *
		 * A snippet rather than a model field because the shell has no data layer: what is unread, and
		 * what marking it read costs, are questions only the runtime holding the sync engine can
		 * answer. `expanded` mirrors the sidebar's own state so the surface can collapse with it.
		 */
		notifications?: Snippet<[{ expanded: boolean }]>;
		children: Snippet;
	} = $props();

	const mobileTitle = $derived(
		[...model.system, ...model.applications].find((item) => item.active)?.label ??
			model.activeOrganization.name
	);
	let switchingOrganization = $state<WorkspaceOrganizationOption | null>(null);

	async function changeOrganization(organizationId: string): Promise<void> {
		if (!onOrganizationChange || switchingOrganization) return;
		const organization = model.organizations.find((entry) => entry.id === organizationId);
		if (!organization || organization.id === model.activeOrganization.id) return;

		// The switch crosses the tenant boundary. Remove the complete outgoing tenant document before
		// asking the host to select the next one so stale records cannot remain mounted or paint through
		// a loader owned by a child sidebar.
		switchingOrganization = organization;
		try {
			await onOrganizationChange(organizationId);
		} catch (error) {
			switchingOrganization = null;
			throw error;
		}
	}
</script>

{#if switchingOrganization}
	<main
		class="grid min-h-dvh w-full place-items-center bg-background"
		role="status"
		aria-live="polite"
		aria-label={`Switching to ${switchingOrganization.name}`}
		data-testid="organization-switch-loader"
	>
		<Inline gap="md" class="text-sm font-medium">
			<Spinner class="size-4" />
			<span>Switching to {switchingOrganization.name}</span>
		</Inline>
	</main>
{:else}
	<WorkspaceShellFrame
		persistenceKey="workspace-shell.sidebar-expanded"
		{mobileTitle}
		mobileDescription="Switch organizations, open applications, or manage your account."
		navigationLabel="Workspace navigation"
		collapsible="icon"
		sidebarClass="overflow-x-hidden text-xs [view-transition-name:sidebar]"
		mobileSidebarClass="px-3 pt-[max(0.75rem,env(safe-area-inset-top))] pb-[max(0.75rem,env(safe-area-inset-bottom))]"
	>
		{#snippet navigation()}
			<WorkspaceSidebar
				{model}
				{onNavigate}
				{onPrefetch}
				onOrganizationChange={changeOrganization}
				{onSignOut}
				{notifications}
			/>
		{/snippet}
		{@render children()}
	</WorkspaceShellFrame>
{/if}
