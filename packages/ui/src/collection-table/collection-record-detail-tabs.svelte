<script lang="ts">
	import Icon from '@iconify/svelte';
	import type { Snippet } from 'svelte';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import * as Sheet from '#lib/sheet';
	import { Tabs, type TabConfig } from '#lib/tabs';
	import { Bound, Frame, Inline, Scroll, Stack } from '#lib/layout';

	const { t } = useI18n<UiKeys>();

	let {
		title,
		description,
		loading,
		error,
		found,
		actions,
		ui,
		approval,
		raw,
		banner = null
	}: {
		title: string;
		description: string;
		loading: boolean;
		error?: string;
		found: boolean;
		actions?: Snippet;
		ui: Snippet;
		approval: Snippet;
		raw: Snippet;
		/** Full-width image above the sheet header, from the collection's `+representation.svelte`. */
		banner?: string | null;
	} = $props();

	const config = $derived([
		{
			name: 'ui',
			label: '',
			description: t('table.tabUi'),
			icon: 'lucide:layout-template',
			content: uiContent
		},
		{
			name: 'approval',
			label: '',
			description: t('table.tabApproval'),
			icon: 'lucide:shield-check',
			content: approvalContent
		},
		{
			name: 'raw',
			label: '',
			description: t('table.tabRaw'),
			icon: 'lucide:braces',
			content: rawContent
		}
	] satisfies TabConfig[]);

	/** Set to the URL that failed; a new `banner` value compares unequal and shows again. */
	let failedBannerSrc = $state<string | null>(null);
	const showBanner = $derived(banner != null && banner !== failedBannerSrc);
</script>

{#snippet detailHeader({ list }: { list: Snippet })}
	<Stack gap="none" shrink={false}>
		{#if showBanner && banner}
			<Frame ratio="banner" shrink={false}>
				<img
					src={banner}
					alt=""
					loading="lazy"
					decoding="async"
					onerror={() => (failedBannerSrc = banner)}
				/>
			</Frame>
		{/if}
		<Inline as="header" gap="md" shrink={false} class="border-b bg-background px-4 py-2.5 sm:px-5">
			<Stack gap="none" grow class="min-w-0">
				<Sheet.Description class="truncate text-micro leading-4 text-muted-foreground">
					{description}
				</Sheet.Description>
				<Sheet.Title class="truncate text-sm leading-5 font-semibold">{title}</Sheet.Title>
			</Stack>
			<Inline gap="sm" shrink={false}>
				{@render list()}
				{#if actions}
					{@render actions()}
				{/if}
			</Inline>
		</Inline>
	</Stack>
{/snippet}

{#snippet unavailableState()}
	{#if loading}
		<Inline gap="sm" class="p-6 text-sm text-muted-foreground" role="status">
			<Icon icon="lucide:loader-circle" class="size-4 animate-spin" aria-hidden="true" />
			{t('table.loadingRecord')}
		</Inline>
	{:else if error}
		<div class="m-6 rounded-lg border border-destructive/40 bg-destructive/5 p-4" role="alert">
			<p class="text-sm font-medium text-destructive">{t('table.recordLoadFailed')}</p>
			<p class="mt-1 text-sm text-muted-foreground">{error}</p>
		</div>
	{:else if !found}
		<div class="m-6 rounded-lg border bg-muted/20 p-4 text-sm text-muted-foreground">
			{t('table.recordUnavailable')}
		</div>
	{/if}
{/snippet}

{#snippet uiContent()}
	<Bound size="full" clip class="p-5 sm:p-6">
		{#if loading || error || !found}
			{@render unavailableState()}
		{:else}
			{@render ui()}
		{/if}
	</Bound>
{/snippet}

{#snippet approvalContent()}
	<Scroll name={t('table.approvalRegion', { title })} class="p-5 sm:p-6">
		{#if loading || error || !found}
			{@render unavailableState()}
		{:else}
			{@render approval()}
		{/if}
	</Scroll>
{/snippet}

{#snippet rawContent()}
	<Scroll name={t('table.rawRegion', { title })} class="p-5 sm:p-6">
		{#if loading || error || !found}
			{@render unavailableState()}
		{:else}
			{@render raw()}
		{/if}
	</Scroll>
{/snippet}

<Tabs
	class="grid h-full w-full grid-rows-[auto_minmax(0,1fr)] overflow-clip"
	listClass="mb-0"
	contentPadding={false}
	variant="default"
	layout="horizontal"
	header={detailHeader}
	{config}
/>
