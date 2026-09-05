<script lang="ts">
	import type { Snippet } from 'svelte';
	import * as Sidebar from '#lib/sidebar';
	import {
		WORKSPACE_SIDEBAR_SECTION_TEXT_CLASS,
		type WorkspaceNavigationItem
	} from '#lib/workspace-shell/workspace-shell.types';
	import WorkspaceSidebarNavigationItem from './workspace-sidebar-navigation-item.svelte';

	let {
		label,
		items,
		open,
		href,
		leading,
		class: className,
		onNavigate,
		onPrefetch
	}: {
		label: string;
		items: readonly WorkspaceNavigationItem[];
		open: boolean;
		href?: string | undefined;
		leading?: Snippet | undefined;
		/** Padding override for a section that follows another group and needs no gap of its own. */
		class?: string | undefined;
		onNavigate?: (href: string) => void | undefined;
		onPrefetch?: (href: string) => void | undefined;
	} = $props();
</script>

{#if items.length > 0}
	<Sidebar.Group class={className}>
		<Sidebar.GroupLabel class={WORKSPACE_SIDEBAR_SECTION_TEXT_CLASS}>
			{#if href}
				<a
					{href}
					class="rounded-sm outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
					onclick={(event) => {
						if (!onNavigate) return;
						event.preventDefault();
						onNavigate(href);
					}}
					onpointerenter={() => onPrefetch?.(href)}
					onfocus={() => onPrefetch?.(href)}>{label}</a
				>
			{:else}
				{label}
			{/if}
		</Sidebar.GroupLabel>
		<Sidebar.GroupContent>
			<Sidebar.Menu>
				{@render leading?.()}
				{#each items as item (item.key)}
					<WorkspaceSidebarNavigationItem {item} {open} {onNavigate} {onPrefetch} />
				{/each}
			</Sidebar.Menu>
		</Sidebar.GroupContent>
	</Sidebar.Group>
{/if}
