<!--
@component
A tab strip without bodies, at the one tab size `Tabs` uses: links (`href`, the page's own navigation) or buttons that
switch a view the caller renders. Its type follows the enclosing `Tabs` level, or `level`.
-->
<script lang="ts" module>
	import type { TabLevel } from './level.js';
	/** One strip item: a link with `href`, a button without. */
	export type TabStripItem = {
		name: string;
		title: string;
		icon?: string;
		href?: string;
		count?: number;
	};
	export type TabStripProps = {
		items: readonly TabStripItem[];
		value: string | undefined;
		onValueChange?: (value: string) => void;
		/** The strip's accessible name. */
		label: string;
		/** The type's level (1 segmented, 2 underline, 3 chips); omitted, one below the enclosing `Tabs`. */
		level?: TabLevel;
		class?: string;
	};
</script>

<script lang="ts">
	import { getContext } from 'svelte';
	import Icon from '../icon/icon-wrapper.svelte';
	import { cn } from '../utils.js';
	import { TAB_LEVEL, tabLevel, tabVariant } from './level.js';
	import { TAB_ICON, TAB_LIST, TAB_TRIGGER, TAB_TYPE } from './style.js';

	let { items, value, onValueChange, label, level, class: className }: TabStripProps = $props();
	const parent = getContext<{ level: TabLevel } | undefined>(TAB_LEVEL);
	const variant = $derived(tabVariant(level ?? tabLevel(parent?.level, undefined).level));
	const links = $derived(items.some((item) => item.href !== undefined));
	const trigger = $derived(cn(TAB_TRIGGER, TAB_TYPE[variant]));
	const list = $derived(
		cn(
			'flex w-fit max-w-full min-w-0 flex-nowrap items-center overflow-x-auto [scrollbar-width:none]',
			TAB_LIST[variant],
			className
		)
	);
</script>

{#snippet content(item: TabStripItem)}
	{#if item.icon}<Icon name={item.icon} class={TAB_ICON} />{/if}
	<span class="truncate">{item.title}</span>
	{#if item.count !== undefined}<span class="text-muted-foreground tabular-nums">{item.count}</span
		>{/if}
{/snippet}

{#if links}
	<nav aria-label={label} class={list} data-tabs-variant={variant}>
		{#each items as item (item.name)}
			<a
				href={item.href}
				aria-current={item.name === value ? 'page' : undefined}
				data-state={item.name === value ? 'active' : 'inactive'}
				class={trigger}>{@render content(item)}</a
			>
		{/each}
	</nav>
{:else}
	<div role="tablist" aria-label={label} class={list} data-tabs-variant={variant}>
		{#each items as item (item.name)}
			<button
				type="button"
				role="tab"
				aria-selected={item.name === value}
				data-state={item.name === value ? 'active' : 'inactive'}
				class={trigger}
				onclick={() => onValueChange?.(item.name)}>{@render content(item)}</button
			>
		{/each}
	</div>
{/if}
