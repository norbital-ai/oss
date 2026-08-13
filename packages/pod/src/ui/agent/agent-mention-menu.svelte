<script lang="ts">
	import Icon from '@iconify/svelte';
	import { Inline } from '@norbital-ai/ui/layout';
	import {
		commandPrefixChar,
		type MentionCommand,
		type MentionMenuItem
	} from './mention-sources.js';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import type { PodUiKeys } from '$lib/i18n/index.js';

	const { t } = useI18n<PodUiKeys>();

	function itemKey(item: MentionMenuItem): string {
		switch (item.kind) {
			case 'record':
				return `record:${item.hit.collection}:${item.hit.recordId}`;
			case 'scope':
				return `scope:${item.collection}`;
			case 'collection':
				return `collection:${item.collection}`;
			case 'app':
				return `app:${item.key}`;
			case 'command':
				return `command:${item.command}`;
			default: {
				const _exhaustive: never = item;
				return _exhaustive;
			}
		}
	}

	function commandIcon(command: MentionCommand): string {
		switch (command) {
			case 'record':
				return 'lucide:search';
			case 'plan':
				return 'lucide:list-todo';
			case 'app':
				return 'lucide:layout-grid';
			default: {
				const _exhaustive: never = command;
				return _exhaustive;
			}
		}
	}

	function commandLabelKey(
		command: MentionCommand
	): 'pod.agent.prefixSearch' | 'pod.agent.prefixPlan' | 'pod.agent.prefixApps' {
		switch (command) {
			case 'record':
				return 'pod.agent.prefixSearch';
			case 'plan':
				return 'pod.agent.prefixPlan';
			case 'app':
				return 'pod.agent.prefixApps';
			default: {
				const _exhaustive: never = command;
				return _exhaustive;
			}
		}
	}

	function itemIcon(item: MentionMenuItem): string {
		switch (item.kind) {
			case 'record':
				return 'lucide:file-text';
			case 'scope':
				return 'lucide:search';
			case 'collection':
				return 'lucide:table';
			case 'app':
				return 'lucide:layout-grid';
			case 'command':
				return commandIcon(item.command);
			default: {
				const _exhaustive: never = item;
				return _exhaustive;
			}
		}
	}

	function itemLabel(item: MentionMenuItem): string {
		switch (item.kind) {
			case 'record':
				return item.hit.label;
			case 'scope':
				return t('pod.agent.searchCollection', { collection: item.collection });
			case 'collection':
				return item.collection;
			case 'app':
				return item.label;
			case 'command':
				return t(commandLabelKey(item.command));
			default: {
				const _exhaustive: never = item;
				return _exhaustive;
			}
		}
	}

	function itemSecondary(item: MentionMenuItem): string {
		switch (item.kind) {
			case 'record':
				return item.hit.collection;
			case 'scope':
				return t('pod.agent.scope');
			case 'collection':
				return t('pod.agent.collection');
			case 'app':
				return t('pod.agent.app');
			case 'command':
				return commandPrefixChar(item.command);
			default: {
				const _exhaustive: never = item;
				return _exhaustive;
			}
		}
	}

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
			<Inline gap="sm" class="min-w-0">
				<Icon icon="lucide:filter" class="size-3 shrink-0" />
				<span class="truncate">{t('pod.agent.searchingScope', { scope })}</span>
			</Inline>
			<button
				type="button"
				class="shrink-0 rounded px-1 transition-colors hover:text-foreground"
				onclick={onclearscope}
			>
				{t('pod.agent.clearScope')}
			</button>
		</Inline>
	{/if}
	<div
		{@attach (node) => {
			void highlightIndex;
			const selected = node.querySelector('[aria-selected="true"]');
			if (selected && typeof selected.scrollIntoView === 'function') {
				selected.scrollIntoView({ block: 'nearest' });
			}
		}}
		class="max-h-64 overflow-y-auto p-1"
	>
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
			{#each items as item, index (itemKey(item))}
				<button
					type="button"
					role="option"
					aria-selected={index === highlightIndex}
					data-highlighted={index === highlightIndex ? true : undefined}
					class={`w-full rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors ${
						index === highlightIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-muted'
					}`}
					onclick={() => onselect(index)}
					onmouseenter={() => onhighlight(index)}
				>
					<Inline gap="sm">
						<Icon icon={itemIcon(item)} class="size-3.5 shrink-0 text-muted-foreground" />
						<span class="min-w-0 grow truncate">{itemLabel(item)}</span>
						<span
							class={`shrink-0 text-xs text-muted-foreground ${item.kind === 'command' ? 'font-mono' : ''}`}
							>{itemSecondary(item)}</span
						>
					</Inline>
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
