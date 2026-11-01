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
		/** A semantic status color, when the icon represents state. */
		iconClass?: string;
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
	import * as Popover from '../popover/index.js';
	import Icon from '../icon/icon-wrapper.svelte';
	import { cn } from '../utils.js';
	import { TAB_LEVEL, tabLevel, tabVariant } from './level.js';
	import { TAB_ICON, TAB_LIST, TAB_TRIGGER, TAB_TYPE } from './style.js';
	import { observeTabOverflow } from './overflow.js';

	let { items, value, onValueChange, label, level, class: className }: TabStripProps = $props();
	const parent = getContext<{ level: TabLevel } | undefined>(TAB_LEVEL);
	const variant = $derived(tabVariant(level ?? tabLevel(parent?.level, undefined).level));
	const links = $derived(items.some((item) => item.href !== undefined));
	const trigger = $derived(cn(TAB_TRIGGER, TAB_TYPE[variant]));
	let list = $state<HTMLElement | null>(null),
		measure = $state<HTMLElement | null>(null),
		fit = $state(Infinity),
		moreOpen = $state(false);
	$effect(() => {
		if (list === null || measure === null) return;
		return observeTabOverflow(list, measure, (count) => (fit = count));
	});
	const shown = $derived(items.slice(0, fit));
	const overflow = $derived(items.slice(fit));
	const activeInMore = $derived(overflow.some((item) => item.name === value));
	const listClass = $derived(
		cn(
			'relative flex w-full min-w-0 flex-nowrap items-center overflow-x-clip',
			TAB_LIST[variant],
			className
		)
	);
</script>

{#snippet content(item: TabStripItem)}
	{#if item.icon}<Icon name={item.icon} class={cn(TAB_ICON, item.iconClass)} />{/if}
	<span class="truncate">{item.title}</span>
	{#if item.count !== undefined}<span class="text-muted-foreground tabular-nums">{item.count}</span
		>{/if}
{/snippet}

<svelte:element
	this={links ? 'nav' : 'div'}
	bind:this={list}
	role={links ? undefined : 'tablist'}
	aria-label={label}
	class={listClass}
	data-tabs-variant={variant}
>
	{#each shown as item (item.name)}
		{#if links}
			<a
				href={item.href}
				aria-current={item.name === value ? 'page' : undefined}
				data-state={item.name === value ? 'active' : 'inactive'}
				class={trigger}>{@render content(item)}</a
			>
		{:else}
			<button
				type="button"
				role="tab"
				aria-selected={item.name === value}
				data-state={item.name === value ? 'active' : 'inactive'}
				class={trigger}
				onclick={() => onValueChange?.(item.name)}>{@render content(item)}</button
			>
		{/if}
	{/each}
	{#if overflow.length > 0}
		<Popover.Root bind:open={moreOpen}>
			<Popover.Trigger>
				{#snippet child({ props })}
					<button
						{...props}
						type="button"
						class={cn(trigger, 'ml-auto')}
						data-tabs-more
						data-state={activeInMore ? 'active' : 'inactive'}
					>
						<Icon name="lucide:ellipsis" class={TAB_ICON} /><span>More</span>
					</button>
				{/snippet}
			</Popover.Trigger>
			<Popover.Content align="end" class="flex w-56 flex-col gap-0.5 p-1">
				{#each overflow as item (item.name)}
					{#if links}
						<a
							href={item.href}
							aria-current={item.name === value ? 'page' : undefined}
							class="flex h-7 items-center gap-1.5 rounded-sm px-2 text-left text-xs font-medium hover:bg-muted aria-[current=page]:bg-muted"
							onclick={() => (moreOpen = false)}>{@render content(item)}</a
						>
					{:else}
						<button
							type="button"
							aria-current={item.name === value ? 'page' : undefined}
							class="flex h-7 items-center gap-1.5 rounded-sm px-2 text-left text-xs font-medium hover:bg-muted aria-[current=page]:bg-muted"
							onclick={() => {
								onValueChange?.(item.name);
								moreOpen = false;
							}}>{@render content(item)}</button
						>
					{/if}
				{/each}
			</Popover.Content>
		</Popover.Root>
	{/if}
	<div
		bind:this={measure}
		aria-hidden="true"
		class="pointer-events-none invisible absolute top-0 left-0 flex w-max"
	>
		{#each items as item (item.name)}<span class={trigger}>{@render content(item)}</span>{/each}
		<span class={trigger}><Icon name="lucide:ellipsis" class={TAB_ICON} /><span>More</span></span>
	</div>
</svelte:element>
