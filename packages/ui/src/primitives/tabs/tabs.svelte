<!--
@component
A tab strip with the selected tab's body; `keepAlive` tabs stay mounted while hidden.
-->
<script lang="ts" module>
	import type { Snippet } from 'svelte';
	import { TAB_LEVEL, tabLevel, tabVariant, type TabLevel, type TabVariant } from './level.js';

	/** One tab (§3.6 `RecordTab`): a `keepAlive` tab stays mounted while hidden, so a form inside keeps its state. */
	export type TabItem = { name: string; title: string; body: Snippet; icon?: string; keepAlive?: true; disabled?: boolean };
	/** The props of `Tabs`: the tabs, the bindable selected `value`, and trailing content. */
	export type TabsProps = {
		tabs: readonly TabItem[];
		value?: string;
		onValueChange?: (value: string) => void;
		class?: string;
		/** Rendered at the list's end (a toolbar, a trailing action). */
		trailing?: Snippet;
		/**
		 * The hierarchy level: 1 `segmented` (top), 2 `underline`, 3 `chips`. Omitted, it is one below the enclosing
		 * `Tabs` (1 at the top); an explicit level out of that order warns in the console.
		 */
		level?: TabLevel;
		/**
		 * `vertical`: a rail of tabs on the left, the body on the right (a compact scroller on a narrow container). Omitted,
		 * a nested strip (level 2 or deeper) of more than two tabs is vertical; a top strip, or two tabs, is horizontal.
		 */
		orientation?: 'horizontal' | 'vertical';
	};

	const LIST: Record<TabVariant, string> = {
		segmented: 'gap-0.5 rounded-lg bg-muted p-0.5',
		underline: 'gap-4 border-b',
		chips: 'gap-1.5'
	};
	// the vertical rail: chips on a narrow container, a column of full-width rows on a wide one (`@2xl`)
	const RAIL_LIST = 'gap-1.5 @2xl:flex-col @2xl:items-stretch @2xl:gap-0.5 @2xl:overflow-x-clip @2xl:overflow-y-auto';
	const RAIL_TRIGGER =
		'h-7 rounded-full border px-3 text-xs data-[state=active]:border-foreground @2xl:h-8 @2xl:justify-start @2xl:rounded-md @2xl:border-transparent @2xl:px-2.5 @2xl:text-sm @2xl:data-[state=active]:border-transparent @2xl:data-[state=active]:bg-muted';
	const TRIGGER: Record<TabVariant, string> = {
		segmented: 'h-7 rounded-md px-3 text-xs data-[state=active]:bg-background data-[state=active]:shadow-sm',
		underline: '-mb-px h-9 border-b-2 border-transparent px-1 text-sm data-[state=active]:border-foreground',
		chips: 'h-7 rounded-full border px-3 text-xs data-[state=active]:border-foreground data-[state=active]:bg-foreground data-[state=active]:text-background'
	};
</script>

<script lang="ts">
	import { Tabs } from 'bits-ui';
	import { getContext, setContext, untrack } from 'svelte';
	import Icon from '../icon/icon-wrapper.svelte';
	import { cn } from '../utils.js';
	import { SCROLL_AXIS_CLASSES } from '../../layout/layout.shared.js';

	let { tabs, value = $bindable(), onValueChange, class: className, trailing, level: explicit, orientation }: TabsProps = $props();
	const parent = getContext<{ level: TabLevel; shown: readonly string[] } | undefined>(TAB_LEVEL);
	const placed = $derived(tabLevel(parent?.level, explicit));
	const variant = $derived(tabVariant(placed.level));
	const vertical = $derived((orientation ?? (placed.level >= 2 && tabs.length > 2 ? 'vertical' : 'horizontal')) === 'vertical');
	// `shown`: every tab name and title of the strips around a body, so a record view inside one does not repeat them
	setContext(TAB_LEVEL, { get level() { return placed.level; }, get shown() { return [...(parent?.shown ?? []), ...tabs.flatMap((t) => [t.name, t.title])]; } });
	untrack(() => placed.warning && console.warn(`[ui] ${placed.warning}`));
	const active = $derived(value ?? tabs.find((t) => !t.disabled)?.name);
	// a tab is mounted once visited and, unless keepAlive, dropped when left
	let visited = $state<Record<string, true>>({});
	$effect.pre(() => {
		if (active !== undefined && !visited[active]) visited[active] = true;
	});
</script>

<!-- a vertical strip is a rail beside the body in a wide container, and a compact horizontal scroller in a narrow one -->
<div class={vertical ? '@container h-full min-h-0 min-w-0' : 'contents'}>
<Tabs.Root
	value={active}
	orientation={vertical ? 'vertical' : 'horizontal'}
	onValueChange={(next) => {
		value = next;
		onValueChange?.(next);
	}}
	class={cn('grid h-full min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] gap-2', vertical && '@2xl:grid-cols-[minmax(9rem,13rem)_minmax(0,1fr)] @2xl:grid-rows-[minmax(0,1fr)] @2xl:gap-4', className)}
	data-tabs-orientation={vertical ? 'vertical' : 'horizontal'}
>
	<div class={cn('flex min-w-0 items-center gap-2', vertical && '@2xl:flex-col @2xl:items-stretch')}>
		<Tabs.List data-tabs-variant={vertical ? 'rail' : variant} class={cn('relative flex min-w-0 flex-1 flex-nowrap items-center', vertical ? RAIL_LIST : LIST[variant], SCROLL_AXIS_CLASSES.x)}>
			{#each tabs as tab (tab.name)}
				<Tabs.Trigger
					value={tab.name}
					disabled={tab.disabled}
					class={cn('inline-flex shrink-0 items-center gap-1.5 font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50 data-[state=active]:text-foreground', vertical ? RAIL_TRIGGER : TRIGGER[variant])}
				>
					{#if tab.icon}<Icon name={tab.icon} class="size-3.5 shrink-0" />{/if}
					<span class="truncate">{tab.title}</span>
				</Tabs.Trigger>
			{/each}
		</Tabs.List>
		{@render trailing?.()}
	</div>
	{#each tabs as tab (tab.name)}
		{#if tab.name === active || (tab.keepAlive && visited[tab.name])}
			<!-- a kept-alive panel stays in the DOM, hidden, outside bits-ui's own unmounting -->
			<div role="tabpanel" hidden={tab.name !== active} class="min-h-0 min-w-0 overflow-x-clip overflow-y-auto [scrollbar-gutter:stable]">
				{@render tab.body()}
			</div>
		{/if}
	{/each}
</Tabs.Root>
</div>
