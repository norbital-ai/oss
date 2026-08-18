<script lang="ts">
	import WorkspaceShellFrame from './workspace-shell-frame.svelte';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import type { Snippet } from 'svelte';
	import { Inline } from '#lib/layout';
	import { Spinner } from '#lib/spinner';
	import type {
		WorkspaceImpersonation,
		WorkspaceNavigationModel,
		WorkspaceOrganizationOption
	} from './workspace-shell.types.js';
	import WorkspaceSidebar from './workspace-sidebar.svelte';

	const { t } = useI18n<UiKeys>();

	let {
		model,
		onNavigate,
		onPrefetch,
		onOrganizationChange,
		onSignOut,
		notifications,
		impersonation,
		onImpersonate,
		onStopImpersonating,
		onSearch,
		searchLabel,
		searchShortcut,
		agent,
		children
	}: {
		model: WorkspaceNavigationModel;
		onNavigate?: (href: string) => void | undefined;
		onPrefetch?: (href: string) => void | undefined;
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
		/**
		 * Admin team impersonation state, when the host supplies it. Absent for
		 * non-admins, so the account menu hides the picker rather than asking.
		 */
		impersonation?: WorkspaceImpersonation | null;
		/** Switch the impersonation scope to a single team. */
		onImpersonate?: (teamId: string) => void | Promise<void>;
		/** Return to the requestor's own team scope. */
		onStopImpersonating?: () => void | Promise<void>;
		/** Host supplies the search gesture; shell only renders the affordance. */
		onSearch?: () => void;
		searchLabel?: string;
		searchShortcut?: string;
		/** The workspace agent's trigger, rendered at the top of the sidebar navigation. */
		agent?: Snippet<[{ expanded: boolean }]>;
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
		aria-label={t('misc.switchingTo', { organization: switchingOrganization.name })}
		data-testid="organization-switch-loader"
	>
		<Inline gap="md" class="text-sm font-medium">
			<Spinner class="size-4" />
			<span>{t('misc.switchingTo', { organization: switchingOrganization.name })}</span>
		</Inline>
	</main>
{:else}
	<WorkspaceShellFrame
		persistenceKey="workspace-shell.sidebar-expanded"
		{mobileTitle}
		mobileDescription={t('misc.shellMobileDescription')}
		navigationLabel={t('misc.workspaceNavigation')}
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
				{impersonation}
				{onImpersonate}
				{onStopImpersonating}
				{onSearch}
				{searchLabel}
				{searchShortcut}
				{agent}
			/>
		{/snippet}
		{@render children()}
	</WorkspaceShellFrame>
{/if}
