<script lang="ts">
	import * as Sheet from '#lib/sheet';
	import { cn, type WithElementRef } from '#lib/utils';
	import type { Attachment } from 'svelte/attachments';
	import type { HTMLAttributes } from 'svelte/elements';
	import { SIDEBAR_WIDTH_MOBILE } from './constants.js';
	import { useSidebar } from './context.svelte.js';
	import { watch } from 'runed';

	let {
		ref = $bindable(null),
		side = 'left',
		mobileSide = side,
		variant = 'sidebar',
		collapsible = 'offcanvas',
		mobileTitle = 'Navigation',
		mobileDescription = 'Browse and choose where to go.',
		closeOnNavigate = true,
		class: className,
		mobileClass,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> & {
		side?: 'left' | 'right';
		mobileSide?: 'left' | 'right' | 'bottom';
		variant?: 'sidebar' | 'floating' | 'inset';
		collapsible?: 'offcanvas' | 'icon' | 'none';
		mobileTitle?: string;
		mobileDescription?: string;
		closeOnNavigate?: boolean;
		mobileClass?: string;
	} = $props();

	const sidebar = useSidebar()();

	watch(
		() => sidebar.isMobile,
		(isMobile) => {
			if (!isMobile) sidebar.setOpenMobile(false);
		},
		{ lazy: false }
	);

	const closeOnNavigation: Attachment<HTMLElement> = (element) => {
		const handleClick = (event: MouseEvent) => {
			if (!closeOnNavigate || !(event.target instanceof Element)) return;
			if (event.target.closest('a[href]')) sidebar.setOpenMobile(false);
		};
		element.addEventListener('click', handleClick);
		return () => element.removeEventListener('click', handleClick);
	};
</script>

{#if collapsible === 'none'}
	<div
		class={cn(
			'flex h-full w-(--sidebar-width) flex-col bg-sidebar text-sidebar-foreground',
			className
		)}
		bind:this={ref}
		{...restProps}
	>
		{@render children?.()}
	</div>
{:else if sidebar.isMobile}
	<Sheet.Root bind:open={() => sidebar.openMobile, (v) => sidebar.setOpenMobile(v)}>
		<Sheet.Content
			data-sidebar="sidebar"
			data-slot="sidebar"
			data-mobile="true"
			class={cn(
				'w-(--sidebar-width) max-w-[calc(100vw-1rem)] bg-sidebar p-0 text-sidebar-foreground [&>button]:hidden',
				mobileClass
			)}
			style="--sidebar-width: {SIDEBAR_WIDTH_MOBILE};"
			side={mobileSide}
			aria-label={restProps['aria-label']}
		>
			<Sheet.Header class="sr-only">
				<Sheet.Title>{mobileTitle}</Sheet.Title>
				<Sheet.Description>{mobileDescription}</Sheet.Description>
			</Sheet.Header>
			<div class="flex h-full w-full flex-col" {@attach closeOnNavigation}>
				{@render children?.()}
			</div>
		</Sheet.Content>
	</Sheet.Root>
{:else}
	<div
		bind:this={ref}
		class="group peer hidden w-(--sidebar-width) shrink-0 text-sidebar-foreground transition-[width] duration-200 ease-linear data-[collapsible=icon]:w-(--sidebar-width-icon) data-[collapsible=offcanvas]:w-0 md:block"
		data-state={sidebar.state}
		data-collapsible={sidebar.state === 'collapsed' ? collapsible : ''}
		data-variant={variant}
		data-side={side}
		data-slot="sidebar"
	>
		<!-- This is what handles the sidebar gap on desktop -->
		<div
			data-slot="sidebar-gap"
			class={cn(
				'relative w-(--sidebar-width) bg-transparent transition-[width] duration-200 ease-linear',
				'group-data-[collapsible=offcanvas]:w-0',
				'group-data-[side=right]:rotate-180',
				variant === 'floating' || variant === 'inset'
					? 'group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+(--spacing(4)))]'
					: 'group-data-[collapsible=icon]:w-(--sidebar-width-icon)'
			)}
		></div>
		<div
			data-slot="sidebar-container"
			class={cn(
				'fixed inset-y-0 z-10 hidden h-svh w-(--sidebar-width) transition-[left,right,width] duration-200 ease-linear md:flex',
				side === 'left'
					? 'left-0 group-data-[collapsible=offcanvas]:left-[calc(var(--sidebar-width)*-1)]'
					: 'right-0 group-data-[collapsible=offcanvas]:right-[calc(var(--sidebar-width)*-1)]',
				// Adjust the padding for floating and inset variants.
				variant === 'floating' || variant === 'inset'
					? 'p-2 group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+(--spacing(4))+2px)]'
					: 'group-data-[collapsible=icon]:w-(--sidebar-width-icon) group-data-[side=left]:border-r group-data-[side=right]:border-l',
				className
			)}
			{...restProps}
		>
			<div
				data-sidebar="sidebar"
				data-slot="sidebar-inner"
				class="relative flex h-full w-full flex-col bg-sidebar group-data-[variant=floating]:rounded-lg group-data-[variant=floating]:border group-data-[variant=floating]:border-sidebar-border group-data-[variant=floating]:shadow-sm"
			>
				{@render children?.()}
			</div>
		</div>
	</div>
{/if}
