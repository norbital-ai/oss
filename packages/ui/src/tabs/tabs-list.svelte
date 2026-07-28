<script lang="ts" module>
	import { Tabs as TabsPrimitive } from 'bits-ui';
	import type { Snippet } from 'svelte';
	import { tv } from 'tailwind-variants';
	import {
		WORKSPACE_TAB_TRIGGER_TEXT_CLASS,
		type TabListLayout,
		type TabListSemantics,
		type TabListVariant
	} from './tabs.types.js';

	// Indicator styles for the animated background
	export const indicatorVariants = tv({
		base: 'absolute inset-0 pointer-events-none',
		variants: {
			variant: {
				default: 'rounded-sm bg-background shadow-sm',
				underline: 'rounded-none',
				chip: 'rounded-full bg-muted/50 ring-2 ring-inset ring-ring/45'
			},
			semantics: {
				default: '',
				info: 'ring-brand',
				warning: 'ring-brand',
				danger: 'ring-destructive',
				success: 'ring-success'
			}
		},
		compoundVariants: [
			{
				variant: 'underline',
				semantics: 'default',
				class: 'bg-foreground'
			},
			{
				variant: 'underline',
				semantics: 'info',
				class: 'bg-brand'
			},
			{
				variant: 'underline',
				semantics: 'warning',
				class: 'bg-orange-600'
			},
			{
				variant: 'underline',
				semantics: 'danger',
				class: 'bg-destructive'
			},
			{
				variant: 'underline',
				semantics: 'success',
				class: 'bg-success'
			}
		],
		defaultVariants: {
			variant: 'default',
			semantics: 'default'
		}
	});

	export const tabTriggerVariants = tv({
		base: 'relative inline-flex items-center justify-center whitespace-nowrap rounded-sm px-3 py-1 transition-all outline-none focus:outline-none focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0 disabled:pointer-events-none disabled:opacity-50 cursor-pointer',
		variants: {
			variant: {
				default: '',
				underline: 'rounded-none',
				chip: 'rounded-full capitalize'
			},
			semantics: {
				default: 'text-muted-foreground hover:text-foreground',
				info: 'text-muted-foreground hover:text-brand',
				warning: 'text-muted-foreground hover:text-brand',
				danger: 'text-muted-foreground hover:text-destructive',
				success: 'text-muted-foreground hover:text-success'
			},
			layout: {
				horizontal: '',
				vertical: '',
				responsive: ''
			}
		},
		compoundVariants: [
			{
				variant: 'underline',
				layout: 'vertical',
				semantics: 'default',
				class:
					'data-[state=active]:rounded-md data-[state=active]:bg-foreground/10 data-[state=active]:ring-1 data-[state=active]:ring-inset data-[state=active]:ring-foreground/20'
			},
			{
				variant: 'underline',
				layout: 'vertical',
				semantics: ['info', 'warning'],
				class:
					'data-[state=active]:rounded-md data-[state=active]:bg-brand/10 data-[state=active]:ring-1 data-[state=active]:ring-inset data-[state=active]:ring-brand/20'
			},
			{
				variant: 'underline',
				layout: 'vertical',
				semantics: 'danger',
				class:
					'data-[state=active]:rounded-md data-[state=active]:bg-destructive/10 data-[state=active]:ring-1 data-[state=active]:ring-inset data-[state=active]:ring-destructive/20'
			},
			{
				variant: 'underline',
				layout: 'vertical',
				semantics: 'success',
				class:
					'data-[state=active]:rounded-md data-[state=active]:bg-success/10 data-[state=active]:ring-1 data-[state=active]:ring-inset data-[state=active]:ring-success/20'
			}
		],
		defaultVariants: {
			variant: 'default',
			semantics: 'default',
			layout: 'horizontal'
		}
	});

	export interface TabItem {
		value: string;
		label?: string;
		disabled?: boolean;
		icon?: string;
		description?: string;
		labelSnippet?: Snippet;
	}

	export interface TabsListProps<T extends TabItem = TabItem> extends TabsPrimitive.ListProps {
		variant?: TabListVariant;
		semantics?: TabListSemantics;
		layout?: TabListLayout;
		tabs: T[];
		itemSnippet?: Snippet<[{ tab: T }]>;
	}

	import { createContext } from 'svelte';
	export type TabsVariantContext = {
		variant: TabListVariant;
		semantics: TabListSemantics;
	};
	export const [getTabsVariant, setTabsVariant] = createContext<() => TabsVariantContext>();
</script>

<script lang="ts" generics="T extends TabItem = TabItem">
	import {
		bindSlidingIndicatorMeasure,
		formatSlidingIndicatorStyle,
		observeSlidingIndicatorResize,
		SLIDING_INDICATOR_TRANSITION_CLASS
	} from '#lib/sliding-indicator';
	import { cn } from '#lib/utils';
	import { watch } from 'runed';
	import { onMount } from 'svelte';

	let {
		ref = $bindable(null),
		class: className,
		style: listStyle,
		variant = 'default',
		semantics = 'default',
		layout = 'horizontal',
		tabs,
		itemSnippet,
		...restProps
	}: TabsListProps<T> & { style?: string | undefined } = $props();

	const listLayoutClasses: Record<TabListLayout, string> = {
		horizontal:
			'relative mb-2 flex max-w-full flex-nowrap items-center overflow-x-auto overflow-y-hidden overscroll-x-contain',
		vertical: 'relative mr-2 flex w-full flex-col items-stretch',
		/** Horizontal with overflow scroll on narrow containers (never stacks vertically). */
		responsive:
			'relative mb-2 flex w-full max-w-full flex-nowrap items-center overflow-x-auto overflow-y-hidden overscroll-x-contain'
	};

	const listHeightClasses = $derived.by(() => {
		if (layout === 'vertical') return '';
		if (variant === 'chip') {
			return 'h-auto min-h-8 overflow-visible px-1 py-1';
		}
		return 'h-auto min-h-8 sm:min-h-0';
	});

	setTabsVariant(() => ({
		get variant() {
			return variant;
		},
		get semantics() {
			return semantics;
		}
	}));

	let indicatorStyle = $state('opacity: 0;');
	const indicatorPositioned = { current: false };

	const scheduleIndicatorMeasure = bindSlidingIndicatorMeasure({
		getTarget: () => ref?.querySelector<HTMLElement>('[data-state="active"]') ?? null,
		onStyle: (style) => {
			indicatorStyle = style;
		},
		positioned: indicatorPositioned,
		formatStyle: (rect, options) => {
			if (variant === 'underline' && ref) {
				const transition =
					options.hasPositioned && options.useTransition ? '' : ' transition: none;';
				if (layout === 'vertical') {
					const x = `calc(${ref.offsetWidth}px - 0.125rem)`;
					return `transform: translate3d(${x}, ${rect.y}px, 0); width: 0.125rem; height: ${rect.height}px; opacity: 1;${transition}`;
				}
				const y = `calc(${ref.offsetHeight}px - 0.125rem)`;
				return `transform: translate3d(${rect.x}px, ${y}, 0); width: ${rect.width}px; height: 0.125rem; opacity: 1;${transition}`;
			}
			return formatSlidingIndicatorStyle(rect, options);
		}
	});

	onMount(() => {
		// Initial measurement after fonts load
		document.fonts.ready.then(() => scheduleIndicatorMeasure(false));
	});

	watch(
		() => [ref, tabs] as const,
		([element], previous) => {
			if (!element) return;

			const disconnectResize = observeSlidingIndicatorResize(element, scheduleIndicatorMeasure);

			const mutationObserver = new MutationObserver(() => scheduleIndicatorMeasure(true));
			mutationObserver.observe(element, {
				subtree: true,
				attributes: true,
				attributeFilter: ['data-state']
			});

			if (previous?.[0] === undefined || previous[0] !== element) {
				scheduleIndicatorMeasure(false);
			}

			return () => {
				disconnectResize();
				mutationObserver.disconnect();
			};
		}
	);
</script>

<TabsPrimitive.List
	bind:ref
	style={listStyle}
	class={cn(
		listLayoutClasses[layout],
		listHeightClasses,
		variant === 'default' && 'rounded-md bg-muted p-1 text-muted-foreground',
		variant === 'underline' &&
			(layout === 'vertical'
				? 'gap-1 bg-transparent p-0 text-muted-foreground'
				: 'gap-0 bg-transparent p-0 text-muted-foreground'),
		variant === 'chip' && 'gap-1 bg-transparent p-0 text-muted-foreground',
		className
	)}
	{...restProps}
>
	<!-- Animated indicator -->
	<div
		class={cn(indicatorVariants({ variant, semantics }), SLIDING_INDICATOR_TRANSITION_CLASS)}
		style={indicatorStyle}
	></div>

	{#each tabs as tab (tab.value)}
		{@const iconOnly = !tab.labelSnippet && !tab.label && Boolean(tab.icon)}
		{@const ariaLabel = tab.description ?? tab.label ?? tab.value}
		{@const triggerClass = cn(
			tabTriggerVariants({ variant, semantics, layout }),
			'group/tab relative z-10 data-[state=active]:shadow-none',
			WORKSPACE_TAB_TRIGGER_TEXT_CLASS,
			layout !== 'vertical' && 'data-[state=active]:bg-transparent',
			iconOnly ? 'min-w-0 flex-1 justify-center px-1.5' : 'shrink-0',
			semantics === 'default' && 'data-[state=active]:!text-foreground',
			semantics === 'info' && 'data-[state=active]:!text-brand',
			semantics === 'warning' && 'data-[state=active]:!text-brand',
			semantics === 'danger' && 'data-[state=active]:!text-destructive',
			semantics === 'success' && 'data-[state=active]:!text-success'
		)}
		<!--
			No Tooltip / title on tab triggers. Sheet open + focus-trap previously focused
			the first icon tab and flashed a "UI" tooltip on every sidesheet open.
			aria-label is enough for accessibility.
		-->
		<TabsPrimitive.Trigger
			value={tab.value}
			disabled={tab.disabled}
			aria-label={ariaLabel}
			class={triggerClass}
		>
			{#if itemSnippet}
				{@render itemSnippet({ tab })}
			{:else}
				{tab.label ?? tab.value}
			{/if}
		</TabsPrimitive.Trigger>
	{/each}
</TabsPrimitive.List>
