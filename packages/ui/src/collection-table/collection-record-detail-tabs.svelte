<script lang="ts">
	import Icon from '@iconify/svelte';
	import type { Snippet } from 'svelte';
	import * as Sheet from '#lib/sheet';
	import { Tabs, type TabConfig } from '#lib/tabs';
	import { Bound, Inline, Scroll } from '#lib/layout';

	let {
		title,
		description,
		loading,
		error,
		found,
		actions,
		ui,
		approval,
		raw
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
	} = $props();

	const config = $derived([
		{
			name: 'ui',
			label: '',
			description: 'UI',
			icon: 'lucide:layout-template',
			content: uiContent
		},
		{
			name: 'approval',
			label: '',
			description: 'Approval',
			icon: 'lucide:shield-check',
			content: approvalContent
		},
		{
			name: 'raw',
			label: '',
			description: 'Raw',
			icon: 'lucide:braces',
			content: rawContent
		}
	] satisfies TabConfig[]);
</script>

{#snippet detailHeader({ list }: { list: Snippet })}
	<Inline
		as="header"
		gap="md"
		class="shrink-0 border-b bg-background px-4 py-2.5 sm:px-5"
	>
		<div class="min-w-0 flex-1">
			<Sheet.Description class="truncate text-micro leading-4 text-muted-foreground">
				{description}
			</Sheet.Description>
			<Sheet.Title class="truncate text-sm leading-5 font-semibold">{title}</Sheet.Title>
		</div>
		<Inline gap="sm" class="shrink-0">
			{@render list()}
			{#if actions}
				{@render actions()}
			{/if}
		</Inline>
	</Inline>
{/snippet}

{#snippet unavailableState()}
	{#if loading}
		<Inline gap="sm" class="p-6 text-sm text-muted-foreground" role="status">
			<Icon icon="lucide:loader-circle" class="size-4 animate-spin" aria-hidden="true" />
			Loading record…
		</Inline>
	{:else if error}
		<div class="m-6 rounded-lg border border-destructive/40 bg-destructive/5 p-4" role="alert">
			<p class="text-sm font-medium text-destructive">Record could not be loaded</p>
			<p class="mt-1 text-sm text-muted-foreground">{error}</p>
		</div>
	{:else if !found}
		<div class="m-6 rounded-lg border bg-muted/20 p-4 text-sm text-muted-foreground">
			This record is no longer available.
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
	<Scroll name={`${title} approval`} class="p-5 sm:p-6">
		{#if loading || error || !found}
			{@render unavailableState()}
		{:else}
			{@render approval()}
		{/if}
	</Scroll>
{/snippet}

{#snippet rawContent()}
	<Scroll name={`${title} raw data`} class="p-5 sm:p-6">
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
