<!--
@component
A tab strip with the selected tab's body; `keepAlive` tabs stay mounted while hidden.
-->
<script lang="ts" module>
	import type { Snippet } from 'svelte';
	import { TAB_LEVEL, tabLevel, tabVariant, type TabLevel, type TabVariant } from './level.js';

	/** One tab (§3.6 `RecordTab`): a `keepAlive` tab stays mounted while hidden, so a form inside keeps its state. */
	export type TabItem = {
		name: string;
		title: string;
		body: Snippet;
		icon?: string;
		/** A count after the title (the rows the tab holds). */
		count?: number;
		keepAlive?: true;
		disabled?: boolean;
	};
	/** The props of `Tabs`: the tabs, the bindable selected `value`, and trailing content. */
	export type TabsProps = {
		tabs: readonly TabItem[];
		value?: string;
		onValueChange?: (value: string) => void;
		class?: string;
		/** Rendered at the list's end (a toolbar, a trailing action). */
		trailing?: Snippet;
		/** Rendered before the list (a scope picker the tabs read): the tabs then sit flush right, wrapping below on narrow. */
		leading?: Snippet;
		/**
		 * The hierarchy level: 1 `segmented` (top), 2 `underline`, 3 `chips`. Omitted, it is one below the enclosing
		 * `Tabs` (1 at the top); an explicit level out of that order warns in the console.
		 */
		level?: TabLevel;
		/**
		 * `vertical`: a rail of tabs on the left, the body on the right (a compact scroller on a narrow container). Omitted,
		 * horizontal: the body keeps the full width.
		 */
		orientation?: 'horizontal' | 'vertical';
	};

	// every level spaces its triggers alike (gap-1, a 0.25rem inset); only the container's surface differs
	const LIST: Record<TabVariant, string> = {
		segmented: 'gap-1 rounded-lg bg-muted p-1',
		underline: 'gap-1 border-b px-1',
		chips: 'gap-1 px-1'
	};
	// the vertical rail: chips on a narrow container, a column of full-width rows on a wide one (`@2xl`)
	const RAIL_LIST =
		'gap-1.5 @2xl:flex-col @2xl:items-stretch @2xl:gap-0.5 @2xl:overflow-x-clip @2xl:overflow-y-auto';
	const RAIL_TRIGGER =
		'h-8 rounded-full border px-3 data-[state=active]:border-foreground @2xl:justify-start @2xl:rounded-md @2xl:border-transparent @2xl:data-[state=active]:border-transparent @2xl:data-[state=active]:bg-muted';
	// every level's trigger is the same size (h-8, px-3, text-sm, its icon size-3.5); only roundness, fill and border
	// mark the level
	const TRIGGER: Record<TabVariant, string> = {
		segmented: 'rounded-md data-[state=active]:bg-background data-[state=active]:shadow-sm',
		// the bar spans the whole trigger, as wide as a segmented tab's fill
		underline:
			"relative after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:rounded-full after:content-[''] data-[state=active]:after:bg-foreground",
		chips:
			'rounded-full border data-[state=active]:border-foreground data-[state=active]:bg-foreground data-[state=active]:text-background'
	};
</script>

<script lang="ts">
	import { Tabs } from 'bits-ui';
	import * as Popover from '../popover/index.js';
	import { getContext, setContext, untrack } from 'svelte';
	import Icon from '../icon/icon-wrapper.svelte';
	import { cn } from '../utils.js';
	import { SCROLL_AXIS_CLASSES } from '../../layout/layout.shared.js';

	let {
		tabs,
		value = $bindable(),
		onValueChange,
		class: className,
		trailing,
		leading,
		level: explicit,
		orientation
	}: TabsProps = $props();
	const parent = getContext<{ level: TabLevel; shown: readonly string[] } | undefined>(TAB_LEVEL);
	const placed = $derived(tabLevel(parent?.level, explicit));
	const variant = $derived(tabVariant(placed.level));
	const vertical = $derived(orientation === 'vertical');
	// `shown`: every tab name and title of the strips around a body, so a record view inside one does not repeat them
	setContext(TAB_LEVEL, {
		get level() {
			return placed.level;
		},
		get shown() {
			return [...(parent?.shown ?? []), ...tabs.flatMap((t) => [t.name, t.title])];
		}
	});
	untrack(() => placed.warning && console.warn(`[ui] ${placed.warning}`));
	const active = $derived(value ?? tabs.find((t) => !t.disabled)?.name);
	const select = (next: string) => {
		value = next;
		onValueChange?.(next);
	};
	// a horizontal strip never scrolls: the triggers that fit stay in it (the active one always), the rest go under More
	let list = $state<HTMLElement | null>(null),
		measure = $state<HTMLElement | null>(null),
		fit = $state(Infinity),
		moreOpen = $state(false);
	function layout() {
		if (list === null || measure === null) return;
		const items = [...measure.children].filter((e): e is HTMLElement => e instanceof HTMLElement);
		const more = items.pop()?.offsetWidth ?? 0;
		const style = getComputedStyle(list);
		const gap = parseFloat(style.columnGap) || 0;
		const room = list.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
		const widths = items.map((e) => e.offsetWidth);
		if (widths.reduce((sum, w) => sum + w, 0) + gap * (widths.length - 1) <= room) {
			fit = widths.length;
			return;
		}
		let used = more,
			count = 0;
		for (const width of widths) {
			if (used + gap + width > room) break;
			used += gap + width;
			count++;
		}
		fit = Math.max(1, count);
	}
	$effect(() => {
		if (vertical || list === null || measure === null) return;
		// measured now, and again on every resize (a hidden page delivers its first observation late)
		layout();
		const observer = new ResizeObserver(layout);
		observer.observe(list);
		observer.observe(measure);
		return () => observer.disconnect();
	});
	const activeIndex = $derived(tabs.findIndex((t) => t.name === active));
	const shownTabs = $derived(
		vertical || fit >= tabs.length
			? tabs
			: activeIndex < fit
				? tabs.slice(0, fit)
				: [...tabs.slice(0, fit - 1), tabs[activeIndex]!]
	);
	const overflow = $derived(tabs.filter((t) => !shownTabs.includes(t)));
	const triggerClass = $derived(
		cn(
			'[--hit-target:2rem] inline-flex h-8 shrink-0 items-center gap-1.5 px-3 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50 data-[state=active]:text-foreground',
			vertical ? RAIL_TRIGGER : TRIGGER[variant]
		)
	);
	// a tab is mounted once visited and, unless keepAlive, dropped when left
	let visited = $state<Record<string, true>>({});
	$effect.pre(() => {
		if (active !== undefined && !visited[active]) visited[active] = true;
	});
</script>

{#snippet label(tab: TabsProps['tabs'][number])}
	{#if tab.icon}<Icon name={tab.icon} class="size-3.5 shrink-0" />{/if}
	<span class="truncate">{tab.title}</span>
	{#if tab.count !== undefined}<span class="text-muted-foreground tabular-nums" data-tab-count
			>{tab.count}</span
		>{/if}
{/snippet}

<!-- a vertical strip is a rail beside the body in a wide container, and a compact horizontal scroller in a narrow one -->
<div class={vertical ? '@container h-full min-h-0 min-w-0' : 'contents'}>
	<Tabs.Root
		value={active}
		orientation={vertical ? 'vertical' : 'horizontal'}
		onValueChange={select}
		class={cn(
			// one column of the container's width: a strip measured against its own contents would shrink as tabs move to More
			'grid h-full min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)] gap-4',
			vertical &&
				'@2xl:grid-cols-[minmax(9rem,13rem)_minmax(0,1fr)] @2xl:grid-rows-[minmax(0,1fr)] @2xl:gap-4',
			className
		)}
		data-tabs-orientation={vertical ? 'vertical' : 'horizontal'}
	>
		<div
			class={cn(
				'flex w-full min-w-0 items-center gap-2',
				leading && 'flex-wrap items-end',
				vertical && '@2xl:flex-col @2xl:items-stretch'
			)}
		>
			{#if leading}<div class="min-w-0 flex-1 basis-64">{@render leading()}</div>{/if}
			<Tabs.List
				bind:ref={list}
				data-tabs-variant={vertical ? 'rail' : variant}
				class={cn(
					'relative flex min-w-0 flex-nowrap items-center',
					leading ? 'ml-auto flex-none' : 'flex-1',
					vertical ? RAIL_LIST : LIST[variant],
					vertical ? SCROLL_AXIS_CLASSES.x : 'overflow-x-clip'
				)}
			>
				{#each shownTabs as tab (tab.name)}
					<Tabs.Trigger value={tab.name} disabled={tab.disabled} class={triggerClass}>
						{@render label(tab)}
					</Tabs.Trigger>
				{/each}
				{#if overflow.length > 0}
					<Popover.Root bind:open={moreOpen}>
						<Popover.Trigger type="button" class={cn(triggerClass, 'ml-auto')} data-tabs-more>
							<Icon name="lucide:ellipsis" class="size-3.5 shrink-0" /><span>More</span>
						</Popover.Trigger>
						<Popover.Content align="end" class="flex w-56 flex-col gap-0.5 p-1">
							{#each overflow as tab (tab.name)}
								<button
									type="button"
									disabled={tab.disabled}
									class="flex h-8 items-center gap-1.5 rounded-sm px-2 text-left text-sm font-medium hover:bg-muted disabled:opacity-50"
									onclick={() => {
										select(tab.name);
										moreOpen = false;
									}}>{@render label(tab)}</button
								>
							{/each}
						</Popover.Content>
					</Popover.Root>
				{/if}
				{#if !vertical}
					<!-- every trigger at its natural width, and More's, measured off-screen: what fits is computed from them -->
					<div
						bind:this={measure}
						aria-hidden="true"
						class="pointer-events-none invisible absolute top-0 left-0 flex w-max"
					>
						{#each tabs as tab (tab.name)}<span class={triggerClass}>{@render label(tab)}</span
							>{/each}
						<span class={triggerClass}
							><Icon name="lucide:ellipsis" class="size-3.5 shrink-0" /><span>More</span></span
						>
					</div>
				{/if}
			</Tabs.List>
			{@render trailing?.()}
		</div>
		{#each tabs as tab (tab.name)}
			{#if tab.name === active || (tab.keepAlive && visited[tab.name])}
				<!-- a kept-alive panel stays in the DOM, hidden, outside bits-ui's own unmounting -->
				<div
					role="tabpanel"
					hidden={tab.name !== active}
					class="min-h-0 min-w-0 overflow-x-clip overflow-y-auto"
				>
					{@render tab.body()}
				</div>
			{/if}
		{/each}
	</Tabs.Root>
</div>
