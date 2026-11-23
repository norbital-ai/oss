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
		icon_class?: string;
		href?: string;
		count?: number;
	};
	export type TabStripProps = {
		/** The items, in order; those that do not fit move to a More menu. */
		items: readonly TabStripItem[];
		/** The active item's `name`. */
		value: string | undefined;
		/** Called with the button item the user selects (links navigate instead). */
		on_value_change?: (value: string) => void;
		/** The strip's accessible name. */
		label: string;
		/** The type's level (1 default, 2 underline, 3 chips); omitted, one below the enclosing `Tabs`. */
		level?: TabLevel;
		/** Classes on the list. */
		class?: string;
	};
</script>

<script lang="ts">
	import { getContext } from 'svelte';
	import * as Popover from '../popover/index.js';
	import Icon from '../icon/icon-wrapper.svelte';
	import { cn, ui_text } from '../utils.js';
	import { TAB_LEVEL, tabLevel, tabVariant } from './level.js';
	import { TAB_ICON, TAB_LIST, TAB_TRACK, TAB_TRIGGER, TAB_TYPE } from './style.js';
	import { create_overflow, register_control } from '../../behaviors/index.js';
	import OverflowTrigger from './overflow-trigger.svelte';

	let { items, value, on_value_change, label, level, class: className }: TabStripProps = $props();
	const parent = getContext<{ level: TabLevel } | undefined>(TAB_LEVEL);
	const t = ui_text();
	const variant = $derived(tabVariant(level ?? tabLevel(parent?.level, undefined).level));
	const links = $derived(items.some((item) => item.href !== undefined));
	const trigger = $derived(cn(TAB_TRIGGER, TAB_TYPE[variant]));
	const strip = create_overflow({
		items: () => items,
		key: (item) => item.name,
		active: () => value
	});
	$effect(() => {
		const id = `tab-strip:${label}`;
		return register_control({
			id,
			kind: 'tab-strip',
			label,
			state: () => ({
				active: value,
				items: items.map((item) => item.name)
			}),
			actions: !links && on_value_change
				? {
						select: (name) => {
							if (typeof name === 'string' && items.some((item) => item.name === name)) {
								on_value_change(name);
							}
						}
					}
				: undefined
		});
	});
	const listClass = $derived(
		cn(
			'relative flex w-full min-w-0 flex-nowrap items-center overflow-x-clip',
			TAB_TRACK,
			TAB_LIST[variant],
			className
		)
	);
</script>

{#snippet content(item: TabStripItem)}
	{#if item.icon}<Icon name={item.icon} class={cn(TAB_ICON, item.icon_class)} />{/if}
	<span class="truncate">{item.title}</span>
	{#if item.count !== undefined}<span class="text-muted-foreground tabular-nums">{item.count}</span
		>{/if}
{/snippet}

<svelte:element
	this={links ? 'nav' : 'div'}
	{@attach strip.list}
	role={links ? undefined : 'tablist'}
	aria-label={label}
	class={listClass}
	data-tabs-variant={variant}
>
	{#each strip.visible as item (item.name)}
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
				onclick={() => on_value_change?.(item.name)}>{@render content(item)}</button
			>
		{/if}
	{/each}
	{#if strip.has_overflow}
		<Popover.Root bind:open={strip.more_open}>
			<OverflowTrigger active={strip.active_in_hidden} label={t('moreTabs')} class={trigger} />
			<Popover.Content align="end" class="flex w-56 flex-col gap-0.5 p-1">
				{#each strip.hidden as item (item.name)}
					{#if links}
						<a
							href={item.href}
							aria-current={item.name === value ? 'page' : undefined}
							class="flex h-7 items-center gap-1.5 rounded-sm px-2 text-left text-xs font-medium hover:bg-muted aria-[current=page]:bg-muted"
							onclick={() => (strip.more_open = false)}>{@render content(item)}</a
						>
					{:else}
						<button
							type="button"
							aria-current={item.name === value ? 'page' : undefined}
							class="flex h-7 items-center gap-1.5 rounded-sm px-2 text-left text-xs font-medium hover:bg-muted aria-[current=page]:bg-muted"
							onclick={() => {
								on_value_change?.(item.name);
								strip.more_open = false;
							}}>{@render content(item)}</button
						>
					{/if}
				{/each}
			</Popover.Content>
		</Popover.Root>
	{/if}
	<div
		{@attach strip.measure}
		aria-hidden="true"
		class="pointer-events-none invisible absolute top-0 left-0 flex w-max"
	>
		{#each items as item (item.name)}<span class={trigger}>{@render content(item)}</span>{/each}
		<span class={trigger}
			><Icon name="lucide:ellipsis" class={TAB_ICON} /><span>{t('moreTabs')}</span></span
		>
	</div>
</svelte:element>
