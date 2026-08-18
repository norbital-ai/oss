<script lang="ts">
	import { IconWrapper } from '#lib/icon-wrapper';
	import { Cluster, Inline, INSET_MX_CLASS } from '#lib/layout';
	import { cn } from '#lib/utils';
	import type { Snippet } from 'svelte';
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
		label?: string | undefined;
		labelSnippet?: Snippet;
		icon?: string | undefined;
		description?: string | undefined;
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
			labelSnippet: nameIsSnippet ? name : labelIsSnippet ? (tab.label as Snippet) : undefined,
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
		// `responsive` lists are width-full. The default chrome also owns horizontal margins, so it
		// must return to auto width or its 100% width plus both margins overhangs the PageHeader inset.
		listClass ?? (variant === 'default' ? cn(INSET_MX_CLASS, 'w-auto') : undefined)
	);
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
				<Inline as="span" gap="xs" justify="center">
					{#if tab.icon}
						<IconWrapper name={tab.icon} class={tab.label ? 'size-3.5' : 'size-4'} />
					{/if}
					{#if tab.label}
						{tab.label}
					{/if}
				</Inline>
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
			? 'grid h-full min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] gap-2 overflow-clip'
			: 'min-w-0 shrink-0',
		className
	)}
	value={activeValue}
	data-tabs-root
	onValueChange={(next) => {
		value = next;
		onValueChange?.(next);
	}}
>
	{#if header}
		{@render header({ list: tabList })}
	{:else if listPrefix || listSuffix}
		<Cluster gap="sm" align="center">
			{@render tabList()}
		</Cluster>
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
