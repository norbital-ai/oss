<script lang="ts">
	import Icon from '@iconify/svelte';
	import { Inline } from '@norbital-ai/ui/layout';
	import type { MentionMenuItem } from './mention-sources.js';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import type { PodUiKeys } from '$lib/i18n/index.js';

	const { t } = useI18n<PodUiKeys>();

	/**
	 * The "@" menu. Deliberately dumb: the composer owns the keyboard — the textarea keeps focus
	 * and decides what keys mean — so this surface only renders the current items, reports clicks
	 * and mouse hovers, and stays out of the way. `mousedown` is swallowed on the whole popover so
	 * choosing an entry never steals focus from the input.
	 */
	let {
		items,
		highlightIndex,
		loading,
		query,
		scope,
		onselect,
		onhighlight,
		onclearscope
	}: {
		items: readonly MentionMenuItem[];
		highlightIndex: number;
		loading: boolean;
		query: string;
		scope: string | null;
		onselect: (index: number) => void;
		onhighlight: (index: number) => void;
		onclearscope: () => void;
	} = $props();

	let listElement = $state<HTMLElement | null>(null);

	$effect(() => {
		void highlightIndex;
		const node = listElement?.querySelector('[aria-selected="true"]');
		if (node && typeof node.scrollIntoView === 'function') {
			node.scrollIntoView({ block: 'nearest' });
		}
	});
</script>

<div
	id="agent-mention-menu"
	role="listbox"
	tabindex="-1"
	aria-label={t('pod.agent.recordReferencesAria')}
	data-testid="agent-mention-menu"
	class="absolute inset-x-0 bottom-full z-30 mb-2 overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-lg"
	onmousedown={(event) => event.preventDefault()}
>
	{#if scope}
		<Inline
			justify="between"
			gap="sm"
			class="border-b border-border/60 px-3 py-1.5 text-xs text-muted-foreground"
		>
			<span class="inline-flex min-w-0 items-center gap-1.5">
				<Icon icon="lucide:filter" class="size-3 shrink-0" />
				<span class="truncate">{t('pod.agent.searchingScope', { scope })}</span>
			</span>
			<button
				type="button"
				class="shrink-0 rounded px-1 transition-colors hover:text-foreground"
				onclick={onclearscope}
			>
				{t('pod.agent.clearScope')}
			</button>
		</Inline>
	{/if}
	<div bind:this={listElement} class="max-h-64 overflow-y-auto p-1">
		{#if loading && items.length === 0}
			<div class="px-3 py-2 text-xs text-muted-foreground">{t('pod.agent.searchingRecords')}</div>
		{:else if items.length === 0}
			<div class="px-3 py-2 text-xs text-muted-foreground" data-testid="agent-mention-empty">
				{#if scope && !query.trim()}
					{t('pod.agent.typeToSearchScope', { scope })}
				{:else}
					{t('pod.agent.noRecordsMatch', { query: query.trim() })}
				{/if}
			</div>
		{:else}
			{#each items as item, index (item.kind === 'record' ? `record:${item.hit.collection}:${item.hit.recordId}` : `scope:${item.collection}`)}
				<button
					type="button"
					role="option"
					aria-selected={index === highlightIndex}
					data-highlighted={index === highlightIndex ? true : undefined}
					class={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors ${
						index === highlightIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-muted'
					}`}
					onclick={() => onselect(index)}
					onmouseenter={() => onhighlight(index)}
				>
					<Icon
						icon={item.kind === 'record' ? 'lucide:file-text' : 'lucide:search'}
						class="size-3.5 shrink-0 text-muted-foreground"
					/>
					{#if item.kind === 'record'}
						<span class="min-w-0 flex-1 truncate">{item.hit.label}</span>
						<span class="shrink-0 text-xs text-muted-foreground">{item.hit.collection}</span>
					{:else}
						<span class="min-w-0 flex-1 truncate"
							>{t('pod.agent.searchCollection', { collection: item.collection })}</span
						>
						<span class="shrink-0 text-xs text-muted-foreground">{t('pod.agent.scope')}</span>
					{/if}
				</button>
			{/each}
		{/if}
	</div>
	<Inline gap="md" class="border-t border-border/60 px-3 py-1.5 text-[11px] text-muted-foreground">
		<span>{t('pod.agent.navigateHint')}</span>
		<span>{t('pod.agent.selectHint')}</span>
		<span>{t('pod.agent.dismissHint')}</span>
	</Inline>
</div>
