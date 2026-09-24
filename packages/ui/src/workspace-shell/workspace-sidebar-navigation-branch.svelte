<script lang="ts">
	import { Frame } from '#lib/layout';
	import Icon from '@iconify/svelte';
	import { ProductIcon, productIconNameFromReference } from '#lib/product-icon';
	import * as Sidebar from '#lib/sidebar';
	import { cn } from '#lib/utils';
	import { watch } from 'runed';
	import {
		WORKSPACE_SIDEBAR_ITEM_TEXT_CLASS,
		WORKSPACE_SIDEBAR_TRAILING_SLOT_CLASS,
		type WorkspaceNavigationItem
	} from '#lib/workspace-shell/workspace-shell.types';
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
		onNavigate?: (href: string) => void | undefined;
		onPrefetch?: (href: string) => void | undefined;
	} = $props();

	// Expand the active branch on first paint; watch keeps it open on nav.
	// svelte-ignore state_referenced_locally
	let expanded = $state(item.active);
	const productIconName = $derived(productIconNameFromReference(item.icon));

	/** A nested group is a disclosure: it expands and collapses, it never navigates. */
	const toggle = () => (expanded = !expanded);

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
				onclick={toggle}
				aria-expanded={expanded}
				class={cn(
					typeof props.class === 'string' ? props.class : undefined,
					'relative w-full overflow-visible pr-7'
				)}
			>
				<Frame as="span" ratio="square" shrink={false} class="size-6">
					{#if productIconName}
						<ProductIcon name={productIconName} class="size-3.5" />
					{:else}
						<Icon icon={item.icon ?? 'lucide:folder'} class="size-3.5" />
					{/if}
				</Frame>
				<span
					class={cn('min-w-0 flex-1 truncate text-left pe-1', WORKSPACE_SIDEBAR_ITEM_TEXT_CLASS)}
					>{item.label}</span
				>
				<div class={cn(WORKSPACE_SIDEBAR_TRAILING_SLOT_CLASS, 'size-3.5')} aria-hidden="true">
					<Icon
						icon="lucide:chevron-right"
						class={cn('size-3.5 transition-transform duration-150', expanded && 'rotate-90')}
					/>
				</div>
			</button>
		{/snippet}
	</Sidebar.MenuSubButton>
	{#if open && expanded && item.children?.length}
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
