<script lang="ts">
	import Icon from '@iconify/svelte';
	import type { Snippet } from 'svelte';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import * as Sheet from '#lib/sheet';
	import { Tabs, type TabConfig } from '#lib/tabs';
	import { Frame, Inline, INSET_X_CLASS, Scroll, Stack } from '#lib/layout';
	import { cn } from '#lib/utils';

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
		<Inline
			as="header"
			gap="md"
			shrink={false}
			class={cn('border-b bg-background py-2.5', INSET_X_CLASS)}
		>
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
		<Inline gap="sm" class="py-4 text-sm text-muted-foreground" role="status">
			<Icon icon="lucide:loader-circle" class="size-4 animate-spin" aria-hidden="true" />
			{t('table.loadingRecord')}
		</Inline>
	{:else if error}
		<div class="rounded-lg border border-destructive/40 bg-destructive/5 p-4" role="alert">
			<p class="text-sm font-medium text-destructive">{t('table.recordLoadFailed')}</p>
			<p class="mt-1 text-sm text-muted-foreground">{error}</p>
		</div>
	{:else if !found}
		<div class="rounded-lg border bg-muted/20 p-4 text-sm text-muted-foreground">
			{t('table.recordUnavailable')}
		</div>
	{/if}
{/snippet}

{#snippet uiContent()}
	<!-- Shell owns the one horizontal inset; nested representations must not add another. -->
	<Scroll name={description} inset>
		<!-- A background refresh retains the current record. Keep its stateful form mounted while that
		     revalidation runs so a mutation failure can finish by painting its error instead of losing the
		     form to a transient loading placeholder. -->
		{#if error || !found}
			{@render unavailableState()}
		{:else}
			{@render ui()}
		{/if}
	</Scroll>
{/snippet}

{#snippet approvalContent()}
	<Scroll name={t('table.approvalRegion', { title })} inset>
		{#if error || !found}
			{@render unavailableState()}
		{:else}
			{@render approval()}
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
