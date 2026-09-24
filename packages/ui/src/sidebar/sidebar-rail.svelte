<script lang="ts">
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { cn, type WithElementRef } from '#lib/utils';
	import type { HTMLAttributes } from 'svelte/elements';
	import { useSidebar } from './context.svelte.js';

	const { t } = useI18n<UiKeys>();

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLButtonElement>, HTMLButtonElement> = $props();

	const sidebar = useSidebar()();
</script>

<button
	bind:this={ref}
	data-sidebar="rail"
	data-slot="sidebar-rail"
	aria-label={t('misc.toggleSidebar')}
	tabIndex={-1}
	onclick={sidebar.toggle}
	title={t('misc.toggleSidebar')}
	class={cn(
		// repository-health:allow UI19 -- the rail's edge is picked at runtime by group-data side/collapse variants (-right-4, left-0, -left-2); an Imposter placement fixes one edge in its class, which those variants would have to undo, and the ::after guide line is a pseudo-element no Imposter can be
		'absolute inset-y-0 z-20 hidden w-4 -translate-x-1/2 transition-all ease-linear group-data-[side=left]:-right-4 group-data-[side=right]:left-0 after:absolute after:inset-y-0 after:left-[calc(1/2*100%-1px)] after:w-[2px] hover:after:bg-sidebar-border sm:block',
		'in-data-[side=left]:cursor-w-resize in-data-[side=right]:cursor-e-resize',
		'[[data-side=left][data-state=collapsed]_&]:cursor-e-resize [[data-side=right][data-state=collapsed]_&]:cursor-w-resize',
		'group-data-[collapsible=offcanvas]:translate-x-0 group-data-[collapsible=offcanvas]:after:left-full hover:group-data-[collapsible=offcanvas]:bg-sidebar',
		'[[data-side=left][data-collapsible=offcanvas]_&]:-right-2',
		'[[data-side=right][data-collapsible=offcanvas]_&]:-left-2',
		className
	)}
	{...restProps}
>
	{@render children?.()}
</button>
