<script
	lang="ts"
	generics="T, TAdditionalProps extends Record<string, unknown> = {}, TMultiple extends boolean = false"
>
	import Icon from '@iconify/svelte';
	import { buttonVariants } from '#lib/button';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { Imposter, Inline } from '#lib/layout';
	import * as Popover from '#lib/popover';
	import { Spinner } from '#lib/spinner';
	import { cn } from '#lib/utils';
	import { toError } from '@norbital-ai/std';
	import type { Snippet } from 'svelte';
	import { Effect } from 'effect';
	import { tick } from 'svelte';
	import ComboboxContent from './combobox-content.svelte';
	import type { TComboboxCommandItem, TInfiniteLoadingConfig, TOption } from '#lib/combobox/types';

	const { t } = useI18n<UiKeys>();

	interface Props {
		open: boolean;
		readonly: boolean;
		disabled: boolean;
		invalid: boolean;
		showClearButton: boolean;
		isLoading: boolean;
		hideChevron: boolean;
		error: string | null;
		comboboxId: string;
		selectionDescription: string;
		ariaLabel?: string;
		multiple: boolean;
		truncate: boolean;
		scrollToSelection: boolean;
		value: TMultiple extends true ? T[] | null : T | null;
		className?: string;
		triggerClass?: string;
		style: string;
		compactTextClass: string;
		dropdownClass?: string;
		sameWidth: boolean;
		minWidth?: number;
		maxWidth?: number;
		align?: 'start' | 'center' | 'end';
		avoidCollisions: boolean;
		collisionPadding: number;
		renderSelectionContent: Snippet;
		onOpenChange: (open: boolean) => Effect.Effect<void> | void;
		onClear: (e: Event) => void;
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
		maxHeight: number;
		itemHeight: number;
		groupHeaderHeight: number;
		overscan: number;
		infiniteLoadingConfig?: TInfiniteLoadingConfig;
		filteredOptions: TOption<T, TAdditionalProps>[];
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
		open = $bindable(false),
		readonly,
		disabled,
		invalid,
		showClearButton,
		isLoading,
		hideChevron,
		error,
		comboboxId,
		selectionDescription,
		ariaLabel,
		multiple,
		truncate,
		scrollToSelection,
		value,
		className,
		triggerClass,
		style,
		compactTextClass,
		dropdownClass,
		sameWidth,
		minWidth,
		maxWidth,
		align,
		avoidCollisions,
		collisionPadding,
		renderSelectionContent,
		onOpenChange,
		onClear,
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
		maxHeight,
		itemHeight,
		groupHeaderHeight,
		overscan,
		infiniteLoadingConfig,
		filteredOptions,
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

	let listContainer = $state<HTMLDivElement | null>(null);

	function scrollToCurrentSelection() {
		if (!listContainer) return;
		const selectedValue = Array.isArray(value) ? value[0] : value;
		if (!selectedValue) return;
		const selector = `[data-value="${JSON.stringify(selectedValue).replace(/"/g, '\\"')}"]`;
		const element = listContainer.querySelector(selector);
		element?.scrollIntoView({ block: 'center' });
	}

	function handleOpenChange(newOpen: boolean): void {
		Effect.runFork(
			Effect.gen(function* () {
				const change = onOpenChange(newOpen);
				if (change) yield* change;
				if (newOpen && scrollToSelection) {
					yield* Effect.tryPromise({ try: () => tick(), catch: toError });
					yield* Effect.tryPromise({ try: () => tick(), catch: toError });
					scrollToCurrentSelection();
				}
			})
		);
	}

	const trapFocus = $derived(showCreateForm ? submitting : true);
</script>

<Popover.Root {open} onOpenChange={handleOpenChange}>
	<div class={cn('group relative min-w-0 w-full', className)} {style}>
		<Popover.Trigger
			aria-expanded={open}
			aria-haspopup="listbox"
			aria-invalid={invalid}
			aria-describedby={error ? `${comboboxId}-error` : undefined}
			aria-label={ariaLabel ?? (readonly ? t('common.viewDetails') : selectionDescription)}
			class={cn(
				'block w-full min-w-0 rounded-md p-1 pl-2',
				'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none focus-visible:ring-inset',
				truncate || !multiple ? 'h-9' : 'min-h-9',
				{
					'cursor-pointer hover:bg-muted': readonly,
					'border border-input bg-background shadow-xs hover:bg-accent hover:text-accent-foreground':
						!readonly,
					'border-destructive ring-[3px] ring-destructive/20 ring-inset': invalid
				},
				triggerClass
			)}
			role={readonly ? 'button' : 'combobox'}
			disabled={disabled || isLoading}
		>
			<Inline as="span" gap="none" fill class="min-h-6.5 w-full py-1">
				{@render renderSelectionContent()}
			</Inline>
		</Popover.Trigger>
		{#if !readonly}
			<Imposter placement="center-end" offset="xs" class="pointer-events-none">
				<Inline gap="xs" justify="center">
					{#if showClearButton}
						<button
							type="button"
							class={cn(
								buttonVariants({ variant: 'outline' }),
								'pointer-events-auto h-4 w-min flex-none px-1 py-0 text-muted-foreground opacity-0 transition-opacity',
								'group-hover:opacity-100 group-focus-within:opacity-100',
								compactTextClass
							)}
							onclick={onClear}
							aria-label={t('common.clearSelection')}>{t('common.clear')}</button
						>
					{/if}
					{#if isLoading}
						<Spinner class="h-3 w-3 shrink-0 opacity-60" />
					{/if}
					{#if !hideChevron}
						<!--
						Mouse/keyboard chrome stays quiet at rest and appears with an outline on hover or focus.
						Coarse pointers cannot hover, so their glyph remains visible. Disabled controls remain
						muted, and simple read-only values take the non-trigger path in Combobox.
					-->
						<Inline
							as="span"
							gap="none"
							justify="center"
							shrink={false}
							class={cn(
								'size-5 rounded-md',
								'border border-transparent bg-transparent text-muted-foreground outline outline-0 outline-transparent',
								'opacity-0 [@media(hover:none)]:opacity-60',
								'transition-[background-color,border-color,opacity,outline-color,outline-width]',
								'group-hover:border-ring group-hover:bg-background group-hover:opacity-100 group-hover:outline-1 group-hover:outline-ring',
								'group-focus-within:border-ring group-focus-within:bg-background group-focus-within:opacity-100 group-focus-within:outline-1 group-focus-within:outline-ring',
								'group-has-[:disabled]:group-hover:border-transparent group-has-[:disabled]:group-hover:bg-transparent group-has-[:disabled]:group-hover:opacity-40 group-has-[:disabled]:group-hover:outline-0'
							)}
							aria-hidden="true"
						>
							<Icon icon="lucide:chevrons-up-down" class="h-3 w-3 shrink-0" />
						</Inline>
					{/if}
				</Inline>
			</Imposter>
		{/if}
	</div>

	{#if error}
		<div id="{comboboxId}-error" class="sr-only" aria-live="polite">
			{t('common.errorLabel', { message: error ?? '' })}
		</div>
	{/if}

	<Popover.Content
		onCloseAutoFocus={(e) => e.preventDefault()}
		class={cn('p-1', dropdownClass)}
		{sameWidth}
		{minWidth}
		{maxWidth}
		{align}
		{avoidCollisions}
		{collisionPadding}
		sideOffset={2}
		{trapFocus}
		role={readonly ? 'dialog' : 'listbox'}
		aria-multiselectable={readonly ? undefined : multiple}
	>
		<ComboboxContent
			{readonly}
			{readonlyContent}
			{showCreateForm}
			{submitting}
			{searchQuery}
			{InlineCreateForm}
			{searchable}
			{searchPlaceholder}
			{commandValue}
			{commandItems}
			{initialActiveValue}
			{onCommandSelect}
			{onSearchInput}
			bind:listContainerRef={listContainer}
			{comboboxId}
			{compactTextClass}
			{maxHeight}
			{itemHeight}
			{groupHeaderHeight}
			{overscan}
			{infiniteLoadingConfig}
			{isLoading}
			{filteredOptions}
			{error}
			{multiple}
			{optionsLength}
			{virtualItemsLength}
			{header}
			{footer}
			{loadingState}
			{errorState}
			{emptyState}
			{isValueSelected}
			{onCancelCreate}
			{onSetSubmitting}
			{onInlineCreateSuccess}
		/>
	</Popover.Content>
</Popover.Root>
