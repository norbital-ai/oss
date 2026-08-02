<script lang="ts">
	import Icon from '@iconify/svelte';
	import { Badge } from '#lib/badge';
	import { ProductIcon, productIconNameFromReference } from '#lib/product-icon';
	import * as Sidebar from '#lib/sidebar';
	import {
		WORKSPACE_SIDEBAR_ITEM_TEXT_CLASS,
		type WorkspaceNavigationItem
	} from './workspace-shell.types.js';

	let {
		item,
		onNavigate
	}: {
		item: WorkspaceNavigationItem;
		onNavigate?: (href: string) => void;
	} = $props();

	const productIconName = $derived(productIconNameFromReference(item.icon));

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
			>
				{#if productIconName}
					<ProductIcon name={productIconName} class="size-3.5 shrink-0" />
				{:else}
					<Icon icon={item.icon ?? 'lucide:file'} class="size-3.5 shrink-0" />
				{/if}
				<span
					data-navigation-label
					class="min-w-0 flex-1 truncate {WORKSPACE_SIDEBAR_ITEM_TEXT_CLASS}">{item.label}</span
				>
				{#if item.badge}
					<Badge
						variant="outline"
						class="ml-auto shrink-0 px-1.5 py-0 text-[0.625rem] leading-4 font-medium"
						data-navigation-badge={item.badge}
						aria-hidden="true">{item.badge}</Badge
					>
				{/if}
			</a>
		{/snippet}
	</Sidebar.MenuSubButton>
</Sidebar.MenuSubItem>
