<script
	lang="ts"
	generics="T, TAdditionalProps extends Record<string, unknown> = {}, TMultiple extends boolean = false"
>
	import Icon from '@iconify/svelte';
	import { buttonVariants } from '#lib/button';
	import * as Popover from '#lib/popover';
	import { Spinner } from '#lib/spinner';
	import { cn } from '#lib/utils';
	import type { Snippet } from 'svelte';
	import { tick } from 'svelte';
	import ComboboxContent from './combobox-content.svelte';
	import {
		estimateContentWidth as estimateContentWidthShared,
		pickSnappedAlign as pickSnappedAlignShared
	} from './combobox-alignment';
	import type { TComboboxCommandItem, TInfiniteLoadingConfig, TOption } from './index.js';

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
		baseHeight: string;
		elementGap: string;
		compactTextClass: string;
		dropdownClass?: string;
		sameWidth: boolean;
		minWidth?: number;
		maxWidth?: number;
		align?: 'start' | 'center' | 'end';
		snapToEnds: boolean;
		renderSelectionContent: Snippet;
		onOpenChange: (open: boolean) => Promise<void> | void;
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
		baseHeight,
		elementGap,
		compactTextClass,
		dropdownClass,
		sameWidth,
		minWidth,
		maxWidth,
		align,
		snapToEnds,
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

	let triggerEl = $state<HTMLElement | null>(null);
	let listContainer = $state<HTMLDivElement | null>(null);
	let alignOverride = $state<'start' | 'center' | 'end' | null>(null);
	const computedAlign = $derived(alignOverride ?? align);

	function estimateContentWidth(anchorWidth: number): number {
		return estimateContentWidthShared(anchorWidth, { sameWidth, minWidth, maxWidth });
	}

	function pickSnappedAlign(preferred: 'start' | 'center' | 'end'): 'start' | 'center' | 'end' {
		return pickSnappedAlignShared(triggerEl, preferred, estimateContentWidth);
	}

	function scrollToCurrentSelection() {
		if (!listContainer) return;
		const selectedValue = Array.isArray(value) ? value[0] : value;
		if (!selectedValue) return;
		const selector = `[data-value="${JSON.stringify(selectedValue).replace(/"/g, '\\"')}"]`;
		const element = listContainer.querySelector(selector);
		element?.scrollIntoView({ block: 'center' });
	}

	async function handleOpenChange(newOpen: boolean) {
		if (newOpen && snapToEnds) {
			alignOverride = pickSnappedAlign(align ?? 'center');
		}
		await onOpenChange(newOpen);
		if (newOpen && scrollToSelection) {
			await tick();
			await tick();
			scrollToCurrentSelection();
		}
	}

	const trapFocus = $derived(showCreateForm ? submitting : true);
	const triggerBaseClasses = $derived(
		cn(
			'flex min-w-0 w-full items-center gap-2 rounded-md p-1 pl-2',
			'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none focus-visible:ring-inset',
			truncate || !multiple ? baseHeight : 'min-h-8',
			{
				'cursor-pointer justify-start overflow-hidden hover:bg-muted': readonly,
				'border border-input bg-background shadow-xs hover:bg-accent hover:text-accent-foreground':
					!readonly,
				'border-destructive ring-[3px] ring-destructive/20 ring-inset': invalid
			},
			triggerClass
		)
	);
	const triggerInnerClasses = $derived(
		cn(
			'flex min-w-0 grow items-center py-1',
			elementGap,
			truncate ? 'overflow-hidden' : 'flex-wrap'
		)
	);
	const clearBtnClasses = $derived(
		cn(
			buttonVariants({ variant: 'outline' }),
			'pointer-events-auto h-4 w-min flex-none px-1 py-0 text-muted-foreground opacity-0 transition-opacity',
			'group-hover:opacity-100 group-focus-within:opacity-100',
			compactTextClass
		)
	);
</script>

<Popover.Root {open} onOpenChange={handleOpenChange}>
	<div bind:this={triggerEl} class={cn('group relative min-w-0 w-full', className)} {style}>
		<Popover.Trigger
			aria-expanded={open}
			aria-haspopup="listbox"
			aria-invalid={invalid}
			aria-describedby={error ? `${comboboxId}-error` : undefined}
			aria-label={ariaLabel ?? (readonly ? 'View details' : selectionDescription)}
			class={triggerBaseClasses}
			role={readonly ? 'button' : 'combobox'}
			disabled={disabled || isLoading}
		>
			<div class={triggerInnerClasses}>
				{@render renderSelectionContent()}
			</div>
		</Popover.Trigger>
		{#if !readonly}
			<!-- stupidity:allow UI6 -- absolutely-positioned clear/chevron decoration -->
			<div
				class="pointer-events-none absolute top-1/2 right-1 flex -translate-y-1/2 items-center justify-center gap-1"
			>
				{#if showClearButton}
					<button
						type="button"
						class={clearBtnClasses}
						onclick={onClear}
						aria-label="Clear selection">clear</button
					>
				{/if}
				{#if isLoading}
					<Spinner class="h-3 w-3 shrink-0 opacity-60" />
				{/if}
				{#if !hideChevron}
					<Icon
						icon="lucide:chevrons-up-down"
						class="h-3 w-3 shrink-0 opacity-60"
						aria-hidden="true"
					/>
				{/if}
			</div>
		{/if}
	</div>

	{#if error}
		<div id="{comboboxId}-error" class="sr-only" aria-live="polite">Error: {error}</div>
	{/if}

	<Popover.Content
		onCloseAutoFocus={(e) => e.preventDefault()}
		class={cn('p-1', dropdownClass)}
		{sameWidth}
		{minWidth}
		{maxWidth}
		align={snapToEnds ? computedAlign : align}
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
