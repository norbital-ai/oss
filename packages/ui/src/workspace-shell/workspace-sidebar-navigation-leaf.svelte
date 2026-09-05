<script lang="ts">
	import Icon from '@iconify/svelte';
	import { Badge } from '#lib/badge';
	import { ProductIcon, productIconNameFromReference } from '#lib/product-icon';
	import * as AlertDialog from '#lib/alert-dialog';
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

	/** Open while the confirm copy is up; the href follows only once confirmed. */
	let confirming = $state(false);

	/** Follows the leaf's href through the shell navigator when one is provided. */
	function navigate(event: MouseEvent): void {
		if (item.confirm !== undefined) {
			event.preventDefault();
			confirming = true;
			return;
		}
		if (!onNavigate) return;
		event.preventDefault();
		onNavigate(item.href);
	}

	/** The destination takes over the session; the sidebar will not be there to come back to. */
	function confirmNavigate(): void {
		confirming = false;
		if (onNavigate) onNavigate(item.href);
		else window.location.assign(item.href);
	}
</script>

<AlertDialog.Root bind:open={confirming}>
	<AlertDialog.Content class="max-w-md">
		<AlertDialog.Header>
			<AlertDialog.Title>{item.confirm?.title ?? ''}</AlertDialog.Title>
			<AlertDialog.Description>{item.confirm?.description ?? ''}</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>{item.confirm?.cancelLabel ?? ''}</AlertDialog.Cancel>
			<AlertDialog.Action onclick={confirmNavigate}>
				{item.confirm?.confirmLabel ?? ''}
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>

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
