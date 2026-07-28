<script lang="ts">
	import Icon from '@iconify/svelte';
	import { FEATURE_COLOR_STYLES } from '#lib/feature-colors';
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
	const featureStyles = $derived(
		item.featureColor ? FEATURE_COLOR_STYLES[item.featureColor] : null
	);
	const hasChildren = $derived(Boolean(item.children?.length));
	const productIconName = $derived(productIconNameFromReference(item.icon));

	function navigate(event: MouseEvent, href: string): void {
		if (!onNavigate) return;
		event.preventDefault();
		onNavigate(href);
	}

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

<Sidebar.MenuItem>
	{#if hasChildren}
		<Sidebar.MenuButton isActive={item.active} size="sm" tooltipContent={item.label}>
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
					<div
						class={cn(
							'flex size-6 shrink-0 items-center justify-center rounded-md border shadow-xs',
							productIconName
								? 'border-input bg-background text-foreground'
								: (featureStyles?.iconWrapperClass ?? 'border-input bg-background')
						)}
					>
						{#if productIconName}
							<ProductIcon name={productIconName} class="size-3.5" />
						{:else}
							<Icon
								icon={item.icon ?? 'lucide:folder'}
								class={cn('size-3.5', featureStyles?.iconClass)}
							/>
						{/if}
					</div>
					{#if open}
						<span class={cn('min-w-0 flex-1 truncate text-left', WORKSPACE_SIDEBAR_ITEM_TEXT_CLASS)}
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
					{/if}
				</button>
			{/snippet}
		</Sidebar.MenuButton>
		{#if open && displayed}
			<Sidebar.MenuSub>
				{#each item.children ?? [] as subItem (subItem.key)}
					{#if subItem.children?.length}
						<WorkspaceSidebarNavigationBranch item={subItem} {open} {onNavigate} {onPrefetch} />
					{:else}
						<WorkspaceSidebarNavigationLeaf item={subItem} {onNavigate} />
					{/if}
				{/each}
			</Sidebar.MenuSub>
		{/if}
	{:else}
		<Sidebar.MenuButton isActive={item.active} size="sm" tooltipContent={item.label}>
			{#snippet child({ props })}
				<a
					{...props}
					href={item.href}
					onmouseenter={() => onPrefetch?.(item.href)}
					onfocus={() => onPrefetch?.(item.href)}
					onclick={(event) => navigate(event, item.href)}
					aria-current={item.active ? 'page' : undefined}
				>
					<div
						class={cn(
							'flex size-6 shrink-0 items-center justify-center rounded-md border shadow-xs',
							productIconName
								? 'border-input bg-background text-foreground'
								: (featureStyles?.iconWrapperClass ?? 'border-input bg-background')
						)}
					>
						{#if productIconName}
							<ProductIcon name={productIconName} class="size-3.5" />
						{:else}
							<Icon
								icon={item.icon ?? 'lucide:layout-grid'}
								class={cn('size-3.5', featureStyles?.iconClass)}
							/>
						{/if}
					</div>
					{#if open}<span class={WORKSPACE_SIDEBAR_ITEM_TEXT_CLASS}>{item.label}</span>{/if}
				</a>
			{/snippet}
		</Sidebar.MenuButton>
	{/if}
</Sidebar.MenuItem>
