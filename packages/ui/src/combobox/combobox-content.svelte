<script lang="ts" generics="T, TAdditionalProps extends Record<string, unknown> = {}">
	import Icon from '@iconify/svelte';
	import * as Command from '#lib/command';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { Spinner } from '#lib/spinner';
	import { cn } from '#lib/utils';
	import type { Snippet } from 'svelte';
	import ComboboxListItem from './combobox-list-item.svelte';
	import type { TComboboxCommandItem, TInfiniteLoadingConfig, TOption } from './index.js';

	const { t } = useI18n<UiKeys>();

	interface Props {
		readonly: boolean;
		readonlyContent?: Snippet;
		showCreateForm: boolean;
		submitting: boolean;
		searchQuery: string;
		InlineCreateForm?: Snippet<
			[
				{
					newValue: string;
					cancel: () => void;
					setSubmitting: (v: boolean) => void;
					submitting: boolean;
					onSuccess: (newOption: TOption<T, TAdditionalProps>) => void;
				}
			]
		>;
		searchable: boolean;
		searchPlaceholder: string;
		commandValue: string;
		commandItems: TComboboxCommandItem<T, TAdditionalProps>[];
		initialActiveValue?: string;
		onCommandSelect: (value: string) => void;
		onSearchInput: (event: Event) => void;
		listContainerRef: HTMLDivElement | null;
		comboboxId: string;
		compactTextClass: string;
		maxHeight: number;
		itemHeight: number;
		groupHeaderHeight: number;
		overscan: number;
		infiniteLoadingConfig?: TInfiniteLoadingConfig;
		isLoading: boolean;
		filteredOptions: TOption<T, TAdditionalProps>[];
		error: string | null;
		multiple: boolean;
		optionsLength: number;
		virtualItemsLength: number;
		header?: Snippet;
		footer?: Snippet;
		loadingState: Snippet;
		errorState: Snippet;
		emptyState: Snippet;
		isValueSelected: (value: T) => boolean;
		onCancelCreate: () => void;
		onSetSubmitting: (v: boolean) => void;
		onInlineCreateSuccess: (option: TOption<T, TAdditionalProps>) => void;
	}

	let {
		readonly,
		readonlyContent,
		showCreateForm,
		submitting,
		searchQuery,
		InlineCreateForm,
		searchable,
		searchPlaceholder,
		commandValue,
		commandItems,
		initialActiveValue,
		onCommandSelect,
		onSearchInput,
		listContainerRef = $bindable(null),
		comboboxId,
		compactTextClass,
		maxHeight,
		itemHeight,
		groupHeaderHeight,
		overscan,
		infiniteLoadingConfig,
		isLoading,
		filteredOptions,
		error,
		multiple,
		optionsLength,
		virtualItemsLength,
		header,
		footer,
		loadingState,
		errorState,
		emptyState,
		isValueSelected,
		onCancelCreate,
		onSetSubmitting,
		onInlineCreateSuccess
	}: Props = $props();
</script>

{#if readonly && readonlyContent}
	{@render readonlyContent()}
{:else if showCreateForm && InlineCreateForm}
	{@render InlineCreateForm({
		newValue: searchQuery,
		cancel: onCancelCreate,
		setSubmitting: onSetSubmitting,
		submitting,
		onSuccess: onInlineCreateSuccess
	})}
{:else}
	<Command.Root
		value={commandValue}
		items={commandItems}
		shouldFilter={false}
		class="flex flex-col gap-1"
		activeValue={initialActiveValue}
		onValueChange={onCommandSelect}
	>
		{#if searchable}
			<Command.Input
				value={searchQuery}
				oninput={onSearchInput}
				placeholder={searchPlaceholder}
				class={compactTextClass}
			>
				{#snippet prefix()}
					<div class={cn('pr-2 text-muted-foreground', compactTextClass)}>
						{#if showCreateForm}
							<Icon icon="lucide:plus" class="h-3 w-3" />
						{:else if isLoading}
							<Spinner class="h-3 w-3" />
						{:else}
							<Icon icon="lucide:search" class="h-3 w-3" />
						{/if}
					</div>
				{/snippet}
			</Command.Input>
		{/if}
		{#if header}
			{@render header()}
		{/if}
		<Command.List
			bind:ref={listContainerRef}
			class="relative gap-1 overflow-auto p-1"
			style="max-height: {maxHeight}px;"
			id="{comboboxId}-listbox"
			{itemHeight}
			{overscan}
			infiniteLoading={infiniteLoadingConfig
				? {
						total: infiniteLoadingConfig.total,
						hasMore: infiniteLoadingConfig.hasMore,
						onLoadMore: (info) =>
							infiniteLoadingConfig.handleInfiniteLoad({
								loadedCount: info.loadedCount,
								lastVirtualIndex: info.lastVisibleIndex
							})
					}
				: undefined}
		>
			{#snippet itemSnippet({ item })}
				<ComboboxListItem
					item={item as TComboboxCommandItem<T, TAdditionalProps>}
					{multiple}
					{itemHeight}
					{groupHeaderHeight}
					{searchQuery}
					{compactTextClass}
					{isValueSelected}
				/>
			{/snippet}
			{#if isLoading && filteredOptions.length === 0}
				{@render loadingState()}
			{:else if error}
				{@render errorState()}
			{:else if commandItems.length === 0}
				{@render emptyState()}
			{/if}
		</Command.List>
		{#if footer}
			<div class={cn('border-t p-2', compactTextClass)}>
				{@render footer()}
			</div>
		{/if}
	</Command.Root>

	{#if infiniteLoadingConfig && virtualItemsLength > 0}
		{@const displayTotal = Math.max(infiniteLoadingConfig.total, optionsLength)}
		<div class={cn('border-t p-2 text-center text-muted-foreground', compactTextClass)}>
			{t('common.showingCount', { count: optionsLength, total: displayTotal })}
		</div>
	{/if}
{/if}
