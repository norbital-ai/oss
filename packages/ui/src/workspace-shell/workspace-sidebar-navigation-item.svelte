<script lang="ts">
	import { Frame, Inline } from '#lib/layout';
	import Icon from '@iconify/svelte';
	import { Badge } from '#lib/badge';
	import { FEATURE_COLOR_STYLES } from '#lib/feature-colors';
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
	const featureStyles = $derived(
		item.featureColor ? FEATURE_COLOR_STYLES[item.featureColor] : null
	);
	const hasChildren = $derived(Boolean(item.children?.length));
	const productIconName = $derived(productIconNameFromReference(item.icon));
	const badgeIconName = $derived(productIconNameFromReference(item.badge));

	function navigate(event: MouseEvent, href: string): void {
		if (!onNavigate) return;
		event.preventDefault();
		onNavigate(href);
	}

	/**
	 * A group row is a disclosure, not a link: it expands and collapses its children. Only the
	 * icon rail (sidebar collapsed, children unreachable) follows the group's own page.
	 */
	function toggleOrNavigate(event: MouseEvent): void {
		if (open) expanded = !expanded;
		else navigate(event, item.href);
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
				<svelte:element
					this={open ? 'button' : 'a'}
					{...props}
					type={open ? 'button' : undefined}
					href={open ? undefined : item.href}
					onclick={toggleOrNavigate}
					aria-expanded={open ? expanded : undefined}
					class={cn(
						typeof props.class === 'string' ? props.class : undefined,
						'relative w-full overflow-visible',
						open && 'pr-7'
					)}
				>
					<Frame
						ratio="square"
						shrink={false}
						class={cn(
							'size-6 rounded-md border shadow-xs',
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
					</Frame>
					{#if open}
						<span
							data-navigation-label
							class={cn('min-w-0 flex-1 truncate text-left', WORKSPACE_SIDEBAR_ITEM_TEXT_CLASS)}
							>{item.label}</span
						>
						{#if item.badge && !badgeIconName}
							<Badge
								variant="outline"
								class="ml-auto shrink-0 px-1.5 py-0 text-[0.625rem] leading-4 font-medium"
								data-navigation-badge={item.badge}
								aria-hidden="true">{item.badge}</Badge
							>
						{/if}
						<div
							class={cn(WORKSPACE_SIDEBAR_TRAILING_SLOT_CLASS, !badgeIconName && 'size-3.5')}
							aria-hidden="true"
						>
							<Inline as="span" gap="xs">
								{#if badgeIconName}
									<span data-navigation-badge={item.badge}>
										<ProductIcon name={badgeIconName} class="size-3.5" />
									</span>
								{/if}
								<Icon
									icon="lucide:chevron-right"
									class={cn('size-3.5 transition-transform duration-150', expanded && 'rotate-90')}
								/>
							</Inline>
						</div>
					{/if}
				</svelte:element>
			{/snippet}
		</Sidebar.MenuButton>
		{#if open && expanded}
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
					class={cn(
						typeof props.class === 'string' ? props.class : undefined,
						'relative w-full overflow-visible',
						open && 'pr-7'
					)}
				>
					<Frame
						ratio="square"
						shrink={false}
						class={cn(
							'size-6 rounded-md border shadow-xs',
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
					</Frame>
					{#if open}
						<span
							data-navigation-label
							class="min-w-0 flex-1 truncate {WORKSPACE_SIDEBAR_ITEM_TEXT_CLASS}">{item.label}</span
						>
						{#if item.badge}
							{#if badgeIconName}
								<span
									class={cn(WORKSPACE_SIDEBAR_TRAILING_SLOT_CLASS, 'size-3.5')}
									data-navigation-badge={item.badge}
									aria-hidden="true"
								>
									<ProductIcon name={badgeIconName} class="size-3.5" />
								</span>
							{:else}
								<Badge
									variant="outline"
									class="ml-auto shrink-0 px-1.5 py-0 text-[0.625rem] leading-4 font-medium"
									data-navigation-badge={item.badge}
									aria-hidden="true">{item.badge}</Badge
								>
							{/if}
						{/if}
					{/if}
				</a>
			{/snippet}
		</Sidebar.MenuButton>
	{/if}
</Sidebar.MenuItem>
