<script lang="ts">
	import Icon from '@iconify/svelte';
	import * as Command from '@norbital-ai/ui/command';
	import { IconWrapper } from '@norbital-ai/ui/icon-wrapper';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import { Inline } from '@norbital-ai/ui/layout';
	import type { PodUiKeys } from '$lib/i18n/index.js';
	import { commandPrefixChar, type CommandScope } from '../agent/mention-sources.js';
	import type { FinderEntity, FinderRow } from './finder-entity.js';

	const { t } = useI18n<PodUiKeys>();

	/**
	 * Shared finder list. Cmd+/ wraps it in a dialog with an input; the composer `@` menu
	 * drives the same rows from the textarea and leaves keyboard ownership there.
	 */
	let {
		query = $bindable(''),
		items,
		showInput = true,
		disableNavigation = false,
		activeValue = undefined,
		scope = null,
		parsedScope = null,
		placeholder,
		ariaLabel,
		inputElement = $bindable(null),
		onPick,
		onQueryInput,
		onClearScope
	}: {
		query?: string;
		items: readonly FinderRow[];
		showInput?: boolean;
		disableNavigation?: boolean;
		activeValue?: string;
		scope?: string | null;
		parsedScope?: CommandScope | null;
		placeholder?: string;
		ariaLabel?: string;
		inputElement?: HTMLInputElement | null;
		onPick: (entity: FinderEntity) => void;
		onQueryInput?: (query: string) => void;
		onClearScope?: () => void;
	} = $props();
	const commandItems = $derived([...items]);

	function pickValue(value: string | null): void {
		if (!value) return;
		const row = items.find((item) => item.value === value);
		if (row?.entity) onPick(row.entity);
	}
</script>

<div
	class={showInput
		? 'contents'
		: 'overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-lg'}
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
			{#if onClearScope}
				<button
					type="button"
					class="shrink-0 rounded px-1 transition-colors hover:text-foreground"
					onclick={onClearScope}
				>
					{t('pod.agent.clearScope')}
				</button>
			{/if}
		</Inline>
	{/if}
	<Command.Root
		items={commandItems}
		{disableNavigation}
		{activeValue}
		shouldFilter={false}
		onValueChange={pickValue}
		onIndicatorKeydown={(event, { indicatorValue }) => {
			if (event.key !== 'Enter') return false;
			event.preventDefault();
			pickValue(indicatorValue);
			return true;
		}}
	>
		{#if showInput}
			<Command.Input
				bind:ref={inputElement}
				value={query}
				oninput={(event) => onQueryInput?.((event.currentTarget as HTMLInputElement).value)}
				{placeholder}
				aria-label={ariaLabel}
				class="h-9 text-sm"
			>
				{#snippet prefix()}
					{#if parsedScope}
						<span class="shrink-0 font-mono text-xs text-muted-foreground"
							>{commandPrefixChar(parsedScope)}</span
						>
					{:else}
						<Icon icon="lucide:search" class="size-3.5 shrink-0 text-muted-foreground" />
					{/if}
				{/snippet}
			</Command.Input>
		{/if}
		<Command.List
			itemHeight={34}
			gap={0}
			class={showInput ? 'max-h-[min(60vh,22rem)]' : 'max-h-64'}
		>
			{#snippet itemSnippet({ item, isIndicator })}
				{@const row = item as FinderRow}
				{@const highlighted = isIndicator && row.kind !== 'group' && row.kind !== 'empty'}
				<Inline
					fill
					gap={row.kind === 'group' ? 'xs' : 'sm'}
					justify={row.kind === 'empty' ? 'center' : 'start'}
					class={`${
						row.kind === 'group'
							? 'px-3 text-micro font-normal uppercase tracking-wide text-muted-foreground sm:text-tiny'
							: 'px-3'
					} ${highlighted ? 'bg-accent text-accent-foreground' : ''} ${
						row.kind === 'app' && row.depth === 1 ? 'pl-7' : ''
					}`}
				>
					{#if row.kind === 'group'}
						<span>{row.label}</span>
					{:else if row.kind === 'loading'}
						<Icon
							icon="lucide:loader-circle"
							class="size-3 shrink-0 animate-spin text-muted-foreground"
						/>
						<span class="text-xs text-muted-foreground">{t('pod.shell.omniSearchingRecords')}</span>
					{:else if row.kind === 'empty'}
						<span data-testid="agent-mention-empty" class="truncate text-xs text-muted-foreground"
							>{row.label}</span
						>
					{:else}
						{#if row.thumbnail}
							<span class="size-4 shrink-0 overflow-hidden rounded-sm">
								<img
									src={row.thumbnail}
									alt=""
									class="size-full object-cover"
									loading="lazy"
									decoding="async"
								/>
							</span>
						{:else if row.icon}
							<IconWrapper name={row.icon} class="size-3.5 shrink-0 text-muted-foreground" />
						{:else}
							<Icon
								icon={row.kind === 'record'
									? 'lucide:file-text'
									: row.kind === 'scope'
										? 'lucide:search'
										: 'lucide:circle'}
								class="size-3.5 shrink-0 text-muted-foreground"
							/>
						{/if}
						<span class="min-w-0 flex-1 truncate text-xs font-normal text-foreground sm:text-micro"
							>{row.label}</span
						>
						{#if row.description}
							<span class="max-w-40 shrink-0 truncate text-micro text-muted-foreground"
								>{row.description}</span
							>
						{/if}
					{/if}
				</Inline>
			{/snippet}
		</Command.List>
	</Command.Root>
	{#if !showInput}
		<Inline
			gap="md"
			class="border-t border-border/60 px-3 py-1.5 text-[11px] text-muted-foreground"
		>
			<span>{t('pod.agent.navigateHint')}</span>
			<span>{t('pod.agent.selectHint')}</span>
			<span>{t('pod.agent.dismissHint')}</span>
		</Inline>
	{/if}
</div>
