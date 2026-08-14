<script lang="ts">
	import Icon from '@iconify/svelte';
	import * as Command from '@norbital-ai/ui/command';
	import type { CommandItemData } from '@norbital-ai/ui/command';
	import { IconWrapper } from '@norbital-ai/ui/icon-wrapper';
	import { Inline, Stack } from '@norbital-ai/ui/layout';
	import * as Popover from '@norbital-ai/ui/popover';
	import { Tabs, type TabConfig } from '@norbital-ai/ui/tabs';
	import { cn } from '@norbital-ai/ui/utils';
	import {
		WEB_CHANNEL_ID,
		channelIdForConversation,
		filterConversationRows,
		type ConversationSelectorModel
	} from './conversation-selector.js';

	type ConversationCommandItem = CommandItemData & {
		rowKind: 'heading' | 'conversation';
		icon?: string;
		level?: 0 | 1;
	};

	let {
		model,
		value,
		displayLabel,
		placeholder,
		searchPlaceholder,
		ariaLabel,
		emptyLabel,
		onValueChange
	}: {
		model: ConversationSelectorModel;
		value?: string;
		displayLabel: string | null;
		placeholder: string;
		searchPlaceholder: string;
		ariaLabel: string;
		emptyLabel: string;
		onValueChange: (id: string) => void;
	} = $props();

	let open = $state(false);
	let query = $state('');
	let selectedChannel = $state<string | null>(null);

	const activeChannel = $derived(
		selectedChannel ?? channelIdForConversation(value, model) ?? WEB_CHANNEL_ID
	);

	const tabConfig = $derived<TabConfig[]>(
		model.channels.map((channel) => ({
			name: channel.id,
			label: channel.label,
			icon: channel.icon,
			content: ''
		}))
	);

	const visibleRows = $derived(
		filterConversationRows(model.rowsByChannel[activeChannel] ?? [], query)
	);

	const commandItems = $derived<ConversationCommandItem[]>(
		visibleRows.map((row) => {
			switch (row.kind) {
				case 'heading':
					return {
						value: row.id,
						disabled: true,
						label: row.label,
						rowKind: 'heading',
						level: row.level
					};
				case 'conversation':
					return {
						value: row.id,
						disabled: false,
						label: row.title,
						rowKind: 'conversation',
						icon: row.icon
					};
				default: {
					const _exhaustive: never = row;
					return _exhaustive;
				}
			}
		})
	);

	const hasConversationRows = $derived(
		visibleRows.some((row) => row.kind === 'conversation')
	);

	/** Restores the conversation's channel when the popover opens and clears the query when it closes. */
	function handleOpenChange(nextOpen: boolean): void { // stupidity:allow Q3 -- template handler
		open = nextOpen;
		if (nextOpen) {
			selectedChannel = channelIdForConversation(value, model);
			return;
		}
		query = '';
	}

	/** Selects the channel tab without dismissing the popover. */
	function handleTabChange(channelId: string): void { // stupidity:allow Q3 -- template handler; stupidity:allow Q4 -- template handler
		selectedChannel = channelId;
	}

	/** Commits a conversation pick and closes the menu. */
	function handleCommandValueChange(id: string): void { // stupidity:allow Q3 -- template handler
		if (!visibleRows.some((entry) => entry.kind === 'conversation' && entry.id === id)) return;
		onValueChange(id);
		open = false;
		query = '';
	}
</script>

<Popover.Root bind:open onOpenChange={handleOpenChange}>
	<Stack gap="none" class="group relative">
		<Popover.Trigger
			aria-expanded={open}
			aria-haspopup="listbox"
			aria-label={ariaLabel}
			class={cn(
				'flex h-8 w-full items-center gap-2 rounded border-0 bg-transparent p-1 pl-2 text-left shadow-none hover:bg-accent hover:text-accent-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none focus-visible:ring-inset'
			)}
		>
			{#if displayLabel}
				<span class="truncate text-xs">{displayLabel}</span>
			{:else}
				<span class="truncate text-xs text-muted-foreground">{placeholder}</span>
			{/if}
		</Popover.Trigger>
		<div
			class="pointer-events-none absolute top-1/2 right-1 flex -translate-y-1/2 items-center justify-center"
		>
			<Icon icon="lucide:chevrons-up-down" class="h-3 w-3 shrink-0 opacity-50" aria-hidden="true" />
		</div>
	</Stack>
	<Popover.Content
		align="start"
		sideOffset={4}
		class="w-[min(calc(100vw-2rem),28rem)] min-w-0 max-w-[calc(100vw-2rem)] p-0"
	>
		<Stack gap="none">
			{#if model.showTabs}
				<Stack gap="none" class="px-2 pt-2">
					<Tabs
						config={tabConfig}
						value={activeChannel}
						onValueChange={handleTabChange}
						showContent={false}
						variant="default"
						layout="horizontal"
						listClass="w-full"
						contentPadding={false}
					/>
				</Stack>
			{/if}
			<Command.Root
				items={commandItems}
				{value}
				shouldFilter={false}
				onValueChange={handleCommandValueChange}
			>
				<Command.Input
					value={query}
					oninput={(event) => {
						query = (event.currentTarget as HTMLInputElement).value;
					}}
					placeholder={searchPlaceholder}
					class="h-9 text-sm"
				>
					{#snippet prefix()}
						<Icon icon="lucide:search" class="size-3.5 shrink-0 text-muted-foreground" />
					{/snippet}
				</Command.Input>
				<Command.List
					itemHeight={32}
					gap={0}
					class="max-h-[min(22rem,calc(100vh-8rem))]"
				>
					{#snippet itemSnippet({ item, isIndicator, isSelected })}
						{@const row = item as ConversationCommandItem}
						{#if row.rowKind === 'heading'}
							<Inline fill gap="none" class="px-2">
								<span
									class={row.level === 1
										? 'text-xs text-muted-foreground'
										: 'text-micro uppercase tracking-wide text-muted-foreground'}
								>
									{row.label}
								</span>
							</Inline>
						{:else}
							<Inline
								fill
								gap="sm"
								justify="between"
								class={cn(
									'px-2',
									isSelected && 'bg-accent text-accent-foreground',
									isIndicator && 'bg-accent/50'
								)}
							>
								<Inline gap="sm" class="min-w-0">
									{#if row.icon}
										<IconWrapper name={row.icon} class="size-3.5 shrink-0 text-muted-foreground" />
									{/if}
									<span class="truncate text-xs">{row.label}</span>
								</Inline>
								{#if isSelected}
									<span
										class="flex size-4 shrink-0 items-center justify-center rounded-full bg-brand-100 dark:bg-brand-900"
									>
										<Icon
											icon="lucide:check"
											class="size-2.5 text-brand dark:text-brand-400"
											aria-hidden="true"
										/>
									</span>
								{/if}
							</Inline>
						{/if}
					{/snippet}
				</Command.List>
				<Command.Empty show={!hasConversationRows} class="px-2 py-6 text-center text-xs text-muted-foreground">
					{emptyLabel}
				</Command.Empty>
			</Command.Root>
		</Stack>
	</Popover.Content>
</Popover.Root>
