<script lang="ts">
	import { IconWrapper } from '#lib/icon-wrapper';
	import { cn } from '#lib/utils';
	import { onMount, type Snippet } from 'svelte';
	import { Tabs as TabsPrimitive } from 'bits-ui';
	import TabsList from './tabs-list.svelte';
	import TabsContent from './tabs-content.svelte';
	import type { TabConfig, TabsProps } from './tabs.types.js';

	let {
		config,
		value = $bindable(),
		onValueChange,
		class: className,
		listClass,
		listStyle,
		contentPadding = true,
		variant = 'default',
		semantics = 'default',
		layout,
		keepAlive = false,
		lazyLoad = true,
		animate = true,
		showContent = true,
		header,
		listPrefix,
		listSuffix
	}: TabsProps = $props();

	type ResolvedTabMeta = {
		value: string;
		label?: string;
		icon?: string;
		description?: string;
		disabled?: boolean;
		keepAlive?: boolean;
		lazyLoad?: boolean;
	};

	function isSnippet(candidate: unknown): candidate is Snippet {
		return typeof candidate === 'function';
	}

	function resolveTabMeta(tab: TabConfig, index: number): ResolvedTabMeta {
		const name = tab.name;
		const nameIsSnippet = isSnippet(name);
		const labelIsSnippet = tab.label !== undefined && isSnippet(tab.label);
		const labelText =
			typeof tab.label === 'string' ? tab.label : typeof name === 'string' ? name : undefined;

		return {
			value: nameIsSnippet ? `tab-${index}` : typeof name === 'string' ? name : `tab-${index}`,
			label: nameIsSnippet || labelIsSnippet ? undefined : labelText,
			icon: tab.icon,
			description: tab.description,
			disabled: tab.disabled,
			keepAlive: tab.keepAlive,
			lazyLoad: tab.lazyLoad
		};
	}

	const resolvedTabMeta = $derived(config.map(resolveTabMeta));

	const defaultValue = $derived(resolvedTabMeta.find((tab) => !tab.disabled)?.value);
	const activeValue = $derived(value ?? defaultValue);
	const resolvedLayout = $derived(
		layout ?? (variant === 'default' && listClass == null ? 'responsive' : 'horizontal')
	);
	const resolvedListClass = $derived(
		listClass ?? (variant === 'default' ? 'mx-4 mb-0 sm:mx-6' : undefined)
	);
	let interactive = $state(false);
	onMount(() => {
		interactive = true;
	});
</script>

{#snippet tabList()}
	{#if listPrefix}
		{@render listPrefix()}
	{/if}
	<TabsList
		{variant}
		{semantics}
		layout={resolvedLayout}
		class={resolvedListClass}
		style={listStyle}
		tabs={resolvedTabMeta}
	>
		{#snippet itemSnippet({ tab })}
			{@const tabIndex = resolvedTabMeta.findIndex((entry) => entry.value === tab.value)}
			{@const configTab = tabIndex >= 0 ? config[tabIndex] : undefined}
			{#if configTab && isSnippet(configTab.name)}
				{@render configTab.name()}
			{:else if configTab?.label !== undefined && isSnippet(configTab.label)}
				{@render configTab.label()}
			{:else}
				<span class="inline-flex items-center justify-center gap-1.5">
					{#if tab.icon}
						<IconWrapper name={tab.icon} class={tab.label ? 'size-3.5' : 'size-4'} />
					{/if}
					{#if tab.label}
						{tab.label}
					{/if}
				</span>
			{/if}
		{/snippet}
	</TabsList>
	{#if listSuffix}
		{@render listSuffix()}
	{/if}
{/snippet}

<TabsPrimitive.Root
	class={cn(
		showContent
			? 'grid h-full min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] overflow-clip'
			: 'min-w-0 shrink-0',
		className
	)}
	value={activeValue}
	data-tabs-root
	data-interactive={interactive || undefined}
	onValueChange={(next) => {
		value = next;
		onValueChange?.(next);
	}}
>
	{#if header}
		{@render header({ list: tabList })}
	{:else if listPrefix || listSuffix}
		<div class="flex flex-wrap items-center gap-2">
			{@render tabList()}
		</div>
	{:else}
		{@render tabList()}
	{/if}

	{#if showContent}
		{#each config as tabConfig, index (resolveTabMeta(tabConfig, index).value)}
			{@const tab = resolveTabMeta(tabConfig, index)}
			<TabsContent
				value={tab.value}
				active={tab.value === activeValue}
				keepAlive={tab.keepAlive ?? keepAlive}
				lazyLoad={tab.lazyLoad ?? lazyLoad}
				{animate}
				{contentPadding}
			>
				{#if typeof tabConfig.content === 'string'}
					{tabConfig.content}
				{:else if isSnippet(tabConfig.content)}
					{@render tabConfig.content()}
				{/if}
			</TabsContent>
		{/each}
	{/if}
</TabsPrimitive.Root>
