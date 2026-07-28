<script lang="ts">
	import * as Sidebar from '#lib/sidebar';
	import {
		WORKSPACE_SIDEBAR_SECTION_TEXT_CLASS,
		type WorkspaceNavigationItem
	} from './workspace-shell.types.js';
	import WorkspaceSidebarNavigationItem from './workspace-sidebar-navigation-item.svelte';

	let {
		label,
		items,
		open,
		onNavigate,
		onPrefetch
	}: {
		label: string;
		items: readonly WorkspaceNavigationItem[];
		open: boolean;
		onNavigate?: (href: string) => void;
		onPrefetch?: (href: string) => void;
	} = $props();
</script>

{#if items.length > 0}
	<Sidebar.Group>
		<Sidebar.GroupLabel class={WORKSPACE_SIDEBAR_SECTION_TEXT_CLASS}>{label}</Sidebar.GroupLabel>
		<Sidebar.GroupContent>
			<Sidebar.Menu>
				{#each items as item (item.key)}
					<WorkspaceSidebarNavigationItem {item} {open} {onNavigate} {onPrefetch} />
				{/each}
			</Sidebar.Menu>
		</Sidebar.GroupContent>
	</Sidebar.Group>
{/if}
