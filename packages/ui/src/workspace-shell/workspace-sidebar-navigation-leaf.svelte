<script lang="ts">
	import Icon from '@iconify/svelte';
	import { Badge } from '#lib/badge';
	import { ProductIcon, productIconNameFromReference } from '#lib/product-icon';
	import * as Sidebar from '#lib/sidebar';
	import { cn } from '#lib/utils';
	import {
		WORKSPACE_SIDEBAR_ITEM_TEXT_CLASS,
		WORKSPACE_SIDEBAR_TRAILING_SLOT_CLASS,
		type WorkspaceNavigationItem
	} from '#lib/workspace-shell/workspace-shell.types';

	let {
		item,
		onNavigate
	}: {
		item: WorkspaceNavigationItem;
		onNavigate?: (href: string) => void | undefined;
	} = $props();

	const productIconName = $derived(productIconNameFromReference(item.icon));
	const badgeIconName = $derived(productIconNameFromReference(item.badge));

	/** Follows the leaf's href through the shell navigator when one is provided. */
	function navigate(event: MouseEvent): void {
		if (!onNavigate) return;
		event.preventDefault();
		onNavigate(item.href);
	}
</script>

<Sidebar.MenuSubItem>
	<Sidebar.MenuSubButton isActive={item.active} size="sm">
		{#snippet child({ props })}
			<a
				{...props}
				href={item.href}
				onclick={navigate}
				aria-current={item.active ? 'page' : undefined}
				class={cn(
					typeof props.class === 'string' ? props.class : undefined,
					'relative overflow-visible pr-7'
				)}
			>
				<span class="flex size-6 shrink-0 items-center justify-center">
					{#if productIconName}
						<ProductIcon name={productIconName} class="size-3.5" />
					{:else}
						<Icon icon={item.icon ?? 'lucide:file'} class="size-3.5" />
					{/if}
				</span>
				<span
					data-navigation-label
					class="min-w-0 flex-1 truncate {WORKSPACE_SIDEBAR_ITEM_TEXT_CLASS}">{item.label}</span
				>
				{#if item.badge}
					<!-- Icon badges share the expand-chevron slot so they flush to the same right edge. -->
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
			</a>
		{/snippet}
	</Sidebar.MenuSubButton>
</Sidebar.MenuSubItem>
