<script lang="ts">
	import WorkspaceShellFrame from './workspace-shell-frame.svelte';
	import type { Snippet } from 'svelte';
	import type { WorkspaceNavigationModel } from './workspace-shell.types.js';
	import WorkspaceSidebar from './workspace-sidebar.svelte';

	let {
		model,
		onNavigate,
		onPrefetch,
		onOrganizationChange,
		onSignOut,
		children
	}: {
		model: WorkspaceNavigationModel;
		onNavigate?: (href: string) => void;
		onPrefetch?: (href: string) => void;
		onOrganizationChange?: (organizationId: string) => void | Promise<void>;
		onSignOut?: () => void | Promise<void>;
		children: Snippet;
	} = $props();

	const mobileTitle = $derived(
		[...model.system, ...model.applications].find((item) => item.active)?.label ??
			model.activeOrganization.name
	);
</script>

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
		<WorkspaceSidebar {model} {onNavigate} {onPrefetch} {onOrganizationChange} {onSignOut} />
	{/snippet}
	{@render children()}
</WorkspaceShellFrame>
