<script lang="ts">
	import { Predicate, Schema } from 'effect';
	import { IconWrapper } from '#lib/icon-wrapper';
	import { Cluster, Inline, INSET_MX_CLASS } from '#lib/layout';
	import { insetReader } from '#lib/layout/inset.svelte';
	import { cn } from '#lib/utils';
	import type { Snippet } from 'svelte';
	import { Tabs as TabsPrimitive } from 'bits-ui';
	import TabsList from './tabs-list.svelte';
	import TabsContent from './tabs-content.svelte';
	import type { TabConfig, TabsProps } from '#lib/tabs/tabs.types';

	let {
		config,
		value = $bindable(),
		onValueChange,
		class: className,
		listClass,
		listStyle,
		flush = false,
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

	const isString = Schema.is(Schema.String);

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
		return Predicate.isFunction(candidate);
	}

	function resolveTabMeta(tab: TabConfig, index: number): ResolvedTabMeta {
		const name = tab.name;
		const nameIsSnippet = isSnippet(name);
		const labelIsSnippet = tab.label !== undefined && isSnippet(tab.label);
		const labelText = isString(tab.label) ? tab.label : isString(name) ? name : undefined;

		return {
			value: nameIsSnippet ? `tab-${index}` : isString(name) ? name : `tab-${index}`,
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
	// A vertical strip is always the underline rail: the pill chrome is a horizontal idiom.
	const resolvedVariant = $derived(resolvedLayout === 'vertical' ? 'underline' : variant);
	// A page that owns its inset (`Bound inset`, every `page` AppShell) already aligns the strip
	// with the content; the default chrome supplies the inset only on a full-bleed page.
	const insideInset = insetReader();
	const resolvedListClass = $derived(
		// `responsive` lists are width-full. The default chrome returns to auto width, or its 100%
		// width plus both margins overhangs the PageHeader inset.
		listClass ??
			(resolvedVariant === 'default'
				? cn(flush || insideInset() ? undefined : INSET_MX_CLASS, 'w-auto')
				: undefined)
	);
</script>

{#snippet tabList()}
	{#if listPrefix}
		{@render listPrefix()}
	{/if}
	<TabsList
		variant={resolvedVariant}
		{semantics}
		layout={resolvedLayout}
		class={/* repository-health:allow UI25 -- the inset-aware list class is resolved in the script from `insetReader()`; its literal tokens are there */ resolvedListClass}
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
				<Inline as="span" gap="xs" justify={resolvedLayout === 'vertical' ? 'start' : 'center'}>
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
			? cn(
					// repository-health:allow UI6 -- bits-ui owns the tabs root; its list/panel track is that element's own grid, and consumers restyle it through `class`
					// repository-health:allow UI27 -- the list-to-panel gap of the same bits-ui root (see UI6 above)
					'grid h-full min-h-0 min-w-0 gap-2 overflow-clip',
					// A vertical strip is a rail beside the panel, not a stack above it.
					// repository-health:allow UI27 -- the rail-or-stack track template of the same bits-ui root (see UI6 above)
					resolvedLayout === 'vertical'
						? 'grid-cols-[auto_minmax(0,1fr)]'
						: // repository-health:allow UI27 -- the rail-or-stack track template of the same bits-ui root (see UI6 above)
							'grid-rows-[auto_minmax(0,1fr)]'
				)
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
				{flush}
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
