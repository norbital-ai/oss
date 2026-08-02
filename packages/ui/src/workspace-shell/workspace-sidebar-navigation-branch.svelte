<script lang="ts">
	import Icon from '@iconify/svelte';
	import { ProductIcon, productIconNameFromReference } from '#lib/product-icon';
	import * as Sidebar from '#lib/sidebar';
	import { cn } from '#lib/utils';
	import { watch } from 'runed';
	import {
		WORKSPACE_SIDEBAR_ITEM_TEXT_CLASS,
		toggleWorkspaceNavigationBranch,
		type WorkspaceNavigationItem
	} from './workspace-shell.types.js';
	import WorkspaceSidebarNavigationBranch from './workspace-sidebar-navigation-branch.svelte';
	import WorkspaceSidebarNavigationLeaf from './workspace-sidebar-navigation-leaf.svelte';

	let {
		item,
		open,
		onNavigate,
		onPrefetch
	}: {
		item: WorkspaceNavigationItem;
		open: boolean;
		onNavigate?: (href: string) => void;
		onPrefetch?: (href: string) => void;
	} = $props();

	// Expand the active branch on first paint; watch keeps it open on nav.
	// svelte-ignore state_referenced_locally
	let expanded = $state(item.active);
	const displayed = $derived(expanded);
	const productIconName = $derived(productIconNameFromReference(item.icon));

	function toggle(): void {
		expanded = toggleWorkspaceNavigationBranch({
			open,
			href: item.href,
			expanded,
			onNavigate
		});
	}

	watch(
		() => item.active,
		(active, previous) => {
			if (active && !previous) expanded = true;
		}
	);
</script>

<Sidebar.MenuSubItem>
	<Sidebar.MenuSubButton isActive={item.active} size="sm">
		{#snippet child({ props })}
			<button
				{...props}
				type="button"
				aria-expanded={open ? displayed : undefined}
				onclick={toggle}
				class={cn(
					typeof props.class === 'string' ? props.class : undefined,
					'relative w-full pr-7'
				)}
			>
				{#if productIconName}
					<ProductIcon name={productIconName} class="size-3.5 shrink-0" />
				{:else}
					<Icon icon={item.icon ?? 'lucide:folder'} class="size-3.5 shrink-0" />
				{/if}
				<span
					class={cn('min-w-0 flex-1 truncate text-left pe-1', WORKSPACE_SIDEBAR_ITEM_TEXT_CLASS)}
					>{item.label}</span
				>
				<div
					class="pointer-events-none absolute top-1/2 right-1.5 flex size-3.5 -translate-y-1/2 items-center justify-center"
					aria-hidden="true"
				>
					<Icon
						icon="lucide:chevron-right"
						class={cn('size-3.5 transition-transform duration-150', displayed && 'rotate-90')}
					/>
				</div>
			</button>
		{/snippet}
	</Sidebar.MenuSubButton>
	{#if open && displayed && item.children?.length}
		<Sidebar.MenuSub>
			{#each item.children as subItem (subItem.key)}
				{#if subItem.children?.length}
					<WorkspaceSidebarNavigationBranch item={subItem} {open} {onNavigate} {onPrefetch} />
				{:else}
					<WorkspaceSidebarNavigationLeaf item={subItem} {onNavigate} />
				{/if}
			{/each}
		</Sidebar.MenuSub>
	{/if}
</Sidebar.MenuSubItem>
