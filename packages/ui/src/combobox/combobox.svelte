<script
	lang="ts"
	generics="T, TAdditionalProps extends Record<string, unknown> = {}, TMultiple extends boolean = false"
>
	/**********************************************************************
	 * Accessible Combobox with Virtualization – Svelte 5
	 * - Virtualization deferred to Command.List
	 * - Null-safe placeholders (never Command.Item)
	 *********************************************************************/
	import Icon from '@iconify/svelte';
	import { Inline, Stack } from '#lib/layout';
	import { Spinner } from '#lib/spinner';
	import { cn } from '#lib/utils';
	import { groupBy } from 'es-toolkit/array';
	import { isEqual } from 'es-toolkit/predicate';
	import ComboboxTrigger from './combobox-trigger.svelte';
	import ComboboxSelection from './combobox-selection.svelte';
	import type { TComboboxCommandItem, TComboboxProps, TOption } from './index.js';

	/* ═══════════════════════════════════════════════════════════════════ */
	/* PROPS                                                               */
	/* ═══════════════════════════════════════════════════════════════════ */
	let {
		options = [],
		value = $bindable<TMultiple extends true ? T[] | null : T | null>(),
		style = '',

		multiple = false as TMultiple,
		allowSelectAll = false as TMultiple extends true ? boolean : never,
		display,
		emptyPlaceholder,
		InlineCreateForm,
		allowClear = false,
		allowClickToSetNull = false,
		hideChevron = false,
		disabled = false,
		invalid = false,
		readonly = false,
		readonlyContent,
		truncate = true,
		preserveOptionOrder = false,
		scrollToSelection = false,

		type = 'client',
		clientConfig,
		serverConfig,
		searchable = true,
		searchPlaceholder = 'Search options...',

		itemHeight = 32,
		groupHeaderHeight = 28,
		maxHeight = 300,
		overscan = 30,
		infiniteLoadingConfig,
		open = $bindable(false),
		ariaLabel,

		class: className,
		triggerClass,
		sameWidth = true,
		dropdownClass,
		align,
		minWidth = 240,
		maxWidth,
		snapToEnds = false,
		header,
		footer,

		onValueChange
	}: TComboboxProps<T, TAdditionalProps, TMultiple> = $props();

	/* ═══════════════════════════════════════════════════════════════════ */
	/* STATE                                                               */
	/* ═══════════════════════════════════════════════════════════════════ */
	let ui = $state({
		searchQuery: '',
		showCreateForm: false,
		submitting: false
	});

	const comboboxId = `combobox-${Math.random().toString(36).substring(2, 9)}`;

	/* ═══════════════════════════════════════════════════════════════════ */
	/* STYLES                                                              */
	/* ═══════════════════════════════════════════════════════════════════ */
	const compactTextClass = 'text-xs';
	const baseHeight = 'h-8';
	const elementGap = 'gap-1';

	/* ═══════════════════════════════════════════════════════════════════ */
	/* DERIVED DISPLAY STATES                                              */
	/* ═══════════════════════════════════════════════════════════════════ */
	const isLoading = $derived(
		(type === 'server' && !!serverConfig?.isLoading) ||
			(type === 'client' && !!clientConfig?.isLoading)
	);
	const error = $derived((type === 'server' ? serverConfig?.error : clientConfig?.error) ?? null);
	const commandValue = $derived(value ? JSON.stringify(value) : '');

	const showClearButton = $derived(
		allowClear &&
			((Array.isArray(value) && value.length > 0) || (!Array.isArray(value) && value != null))
	);
	const emptyMessage = $derived(
		type === 'server' && serverConfig && ui.searchQuery.length > 0
			? `No results found for "${ui.searchQuery}"`
			: 'No options available'
	);
	const isReadonlySimple = $derived(readonly && !readonlyContent);
	const canSelectAll = $derived(
		multiple && allowSelectAll && type === 'client' && !infiniteLoadingConfig && options.length > 0
	);

	const selectedOptions = $derived.by(() => {
		if (!multiple || !Array.isArray(value) || value.length === 0) return [];
		return options.filter((option) =>
			(value as (string | object)[]).some((v) => isEqual(v, option.value))
		);
	});

	const sortedOptions = $derived.by(() => {
		if (preserveOptionOrder) return options;
		const selectionValues = Array.isArray(value) ? value : value ? [value] : [];
		if (selectionValues.length === 0) return options;
		const selected: TOption<T, TAdditionalProps>[] = [];
		const unselected: TOption<T, TAdditionalProps>[] = [];
		for (const opt of options) {
			if (selectionValues.some((v) => isEqual(v, opt.value))) {
				selected.push(opt);
			} else {
				unselected.push(opt);
			}
		}
		return [...selected, ...unselected];
	});

	const filteredOptions = $derived.by(() => {
		if (type !== 'client' || !ui.searchQuery) return sortedOptions;
		const query = ui.searchQuery.toLowerCase();
		return sortedOptions.filter((option) => {
			const searchableValue =
				option.search_term ??
				(typeof option.label === 'string' ? option.label : JSON.stringify(option.value));
			return searchableValue.toLowerCase().includes(query);
		});
	});

	const groupedOptions = $derived.by(() => {
		const hasTypes = filteredOptions.some((option) => 'type' in option);
		if (!hasTypes) return { default: filteredOptions };
		return groupBy(filteredOptions, (option) => option.type || 'Other');
	});
	const selectedOptionCount = $derived.by(() => {
		if (!multiple || !Array.isArray(value)) return 0;
		const selectedValues = value as T[]; // stupidity: boundary-cast — Svelte's conditional generic value does not narrow through Array.isArray.
		return options.filter((option) =>
			selectedValues.some((selected) => isEqual(selected, option.value))
		).length;
	});
	const allOptionsSelected = $derived(options.length > 0 && selectedOptionCount === options.length);

	type VirtualItem =
		| { type: 'group'; groupName: string; index: number; id: string }
		| { type: 'select-all'; index: number; id: string }
		| { type: 'option'; option: TOption<T, TAdditionalProps>; index: number; id: string }
		| { type: 'create'; index: number; id: string };

	const shouldShowCreateOption = $derived(InlineCreateForm && ui.searchQuery.trim() !== '');

	const virtualItems = $derived.by((): VirtualItem[] => {
		const items: VirtualItem[] = [];
		let index = 0;
		if (canSelectAll) items.push({ type: 'select-all', index: index++, id: 'select-all' });
		const groupEntries = Object.entries(groupedOptions);
		const hasMultipleGroups = groupEntries.length > 1;

		for (const [groupName, groupOptions] of groupEntries) {
			if (groupOptions.length === 0) continue;
			if (hasMultipleGroups && groupName !== 'default') {
				items.push({ type: 'group', groupName, index: index++, id: `group-${groupName}` });
			}
			for (const option of groupOptions) {
				items.push({
					type: 'option',
					option,
					index: index++,
					id: `option-${index}`
				});
			}
		}
		if (shouldShowCreateOption) items.push({ type: 'create', index: index++, id: 'create-option' });
		return items;
	});

	function buildCommandItems(): TComboboxCommandItem<T, TAdditionalProps>[] {
		return virtualItems.map((item) => {
			if (item.type === 'group') {
				return {
					value: `__group_${item.groupName}`,
					label: item.groupName,
					disabled: true,
					_type: 'group' as const,
					_groupName: item.groupName
				};
			} else if (item.type === 'select-all') {
				return {
					value: '__select_all__',
					label: allOptionsSelected ? 'Clear all options' : 'Select all options',
					_type: 'select-all' as const,
					_selectedCount: selectedOptionCount,
					_totalCount: options.length,
					_allSelected: allOptionsSelected
				};
			} else if (item.type === 'option') {
				return {
					value: JSON.stringify(item.option.value),
					label:
						typeof item.option.label === 'string' ? item.option.label : String(item.option.value),
					_type: 'option' as const,
					_option: item.option
				};
			} else {
				return {
					value: '__create__',
					label: `Create "${ui.searchQuery}"`,
					_type: 'create' as const
				};
			}
		});
	}

	const commandItems = $derived.by(() => buildCommandItems());
	const navigableItems = $derived(commandItems.filter((item) => item._type !== 'group'));

	const initialActiveValue = $derived.by(() => {
		if (navigableItems.length === 0) return undefined;

		if (scrollToSelection && value) {
			const selectedValue = JSON.stringify(value);
			const found = navigableItems.find((item) => item.value === selectedValue);
			if (found) return found.value;
		}

		return navigableItems[0]?.value;
	});

	const selectionDescription = $derived.by(() => {
		if (multiple && Array.isArray(value)) {
			const count = value.length;
			if (count === 0) return 'No items selected';
			return count === 1 ? '1 item selected' : `${count} items selected`;
		}
		if (value) {
			const option = sortedOptions.find((o) => isEqual(o.value, value));
			return option && typeof option.label === 'string'
				? `Selected: ${option.label}`
				: 'Item selected';
		}
		return 'No selection';
	});

	/* ═══════════════════════════════════════════════════════════════════ */
	/* EVENTS                                                              */
	/* ═══════════════════════════════════════════════════════════════════ */
	function handleOpenChange(newOpen: boolean) {
		open = newOpen;
		if (!newOpen) {
			ui.showCreateForm = false;
			ui.submitting = false;
			ui.searchQuery = '';
			if (type === 'server' && serverConfig) serverConfig.onSearch('');
		}
	}

	function handleSearchInput(event: Event) {
		const target = event.target as HTMLInputElement;
		ui.searchQuery = target.value;
		if (type === 'server' && serverConfig) serverConfig.onSearch(ui.searchQuery);
	}

	function handleCommandSelect(selectedValue: string) {
		if (selectedValue === '__create__') {
			ui.showCreateForm = true;
			return;
		}
		if (selectedValue === '__select_all__') {
			handleSelectAll();
			return;
		}

		const item = commandItems.find((candidate) => candidate.value === selectedValue);
		if (item?._type === 'option') handleOptionSelect(item._option);
	}

	function handleSelectAll(): void {
		if (readonly || !canSelectAll) return;
		value = (
			allOptionsSelected ? [] : options.map((option) => option.value)
		) as TMultiple extends true ? T[] | null : T | null;
		onValueChange?.(value);
	}

	async function handleOptionSelect(option: TOption<T, TAdditionalProps>) {
		if (readonly) return;

		if (multiple) {
			let newValue = Array.isArray(value) ? [...value] : ([] as T[]);
			const isSelected = newValue.some((v) => isEqual(v, option.value));
			newValue = isSelected
				? newValue.filter((v) => !isEqual(v, option.value))
				: [...newValue, option.value];
			value = newValue as TMultiple extends true ? T[] | null : T | null;
			onValueChange?.(value);
		} else {
			if (allowClickToSetNull && isEqual(option.value, value as T)) {
				value = null as TMultiple extends true ? T[] | null : T | null;
				onValueChange?.(value);
				await handleOpenChange(false);
				return;
			}
			value = option.value as TMultiple extends true ? T[] | null : T | null;
			onValueChange?.(value);
			await handleOpenChange(false);
		}
	}

	function removeItem(itemValue: T, event: Event) {
		if (readonly) return;
		event.stopPropagation();
		if (multiple && Array.isArray(value)) {
			const newValue = value.filter((v) => !isEqual(v, itemValue));
			value = newValue as TMultiple extends true ? T[] | null : T | null;
			onValueChange?.(value);
		}
	}

	async function handleClear(event: Event) {
		if (readonly) return;
		event.preventDefault();
		event.stopPropagation();
		value = (multiple ? [] : null) as TMultiple extends true ? T[] | null : T | null;
		await handleOpenChange(false);
		onValueChange?.(value);
	}

	async function handleInlineCreateSuccess(newOption: TOption<T, TAdditionalProps>) {
		if (readonly) return;
		options = [...options, newOption];
		if (multiple) {
			const currentValue = Array.isArray(value) ? value : [];
			value = [...currentValue, newOption.value] as TMultiple extends true ? T[] | null : T | null;
		} else {
			value = newOption.value as TMultiple extends true ? T[] | null : T | null;
			await handleOpenChange(false);
		}
		ui.submitting = false;
		ui.showCreateForm = false;
		ui.searchQuery = '';
		onValueChange?.(value);
	}

	function isValueSelected(optionValue: T): boolean {
		if (!multiple) return isEqual(value, optionValue);
		return Array.isArray(value) && value.some((v) => isEqual(v, optionValue));
	}
</script>

{#snippet renderSelectionContent()}
	<ComboboxSelection
		{value}
		{multiple}
		{display}
		{emptyPlaceholder}
		{readonly}
		{truncate}
		options={sortedOptions}
		{selectedOptions}
		onRemove={removeItem}
	/>
{/snippet}

{#snippet loadingState()}
	<Inline justify="center" gap="sm" class={cn('p-3', compactTextClass)}>
		<Spinner class="h-3 w-3" />
		Loading options...
	</Inline>
{/snippet}

{#snippet errorState()}
	<Stack
		gap="sm"
		class={cn('items-center p-3 text-destructive', compactTextClass)}
		role="alert"
	>
		<Icon icon="lucide:alert-circle" class="h-4 w-4" />
		<span>Error: {error}</span>
	</Stack>
{/snippet}

{#snippet emptyState()}
	<Stack
		gap="sm"
		class={cn(
			'items-center p-3 text-center text-muted-foreground',
			compactTextClass
		)}
	>
		<Icon icon="lucide:inbox" class="h-4 w-4 text-muted-foreground" />
		<span class="font-normal">{emptyMessage}</span>
	</Stack>
{/snippet}

{#if isReadonlySimple}
	<div
		class={cn(
			'flex w-full items-center justify-start rounded-md p-1 pl-2',
			'overflow-hidden select-text',
			baseHeight,
			className
		)}
		aria-readonly="true"
		{style}
	>
		{@render renderSelectionContent()}
	</div>
{:else}
	<ComboboxTrigger
		bind:open
		{readonly}
		{disabled}
		{invalid}
		{showClearButton}
		{isLoading}
		{hideChevron}
		{error}
		{comboboxId}
		{selectionDescription}
		{ariaLabel}
		{multiple}
		{truncate}
		{scrollToSelection}
		{value}
		{className}
		{triggerClass}
		{style}
		{baseHeight}
		{elementGap}
		{compactTextClass}
		{dropdownClass}
		{sameWidth}
		{minWidth}
		{maxWidth}
		{align}
		{snapToEnds}
		{renderSelectionContent}
		onOpenChange={handleOpenChange}
		onClear={handleClear}
		{readonlyContent}
		showCreateForm={ui.showCreateForm}
		submitting={ui.submitting}
		searchQuery={ui.searchQuery}
		{InlineCreateForm}
		{searchable}
		{searchPlaceholder}
		{commandValue}
		{commandItems}
		{initialActiveValue}
		onCommandSelect={handleCommandSelect}
		onSearchInput={handleSearchInput}
		{maxHeight}
		{itemHeight}
		{groupHeaderHeight}
		{overscan}
		{infiniteLoadingConfig}
		{filteredOptions}
		optionsLength={options.length}
		virtualItemsLength={virtualItems.length}
		{header}
		{footer}
		{loadingState}
		{errorState}
		{emptyState}
		{isValueSelected}
		onCancelCreate={() => (ui.showCreateForm = false)}
		onSetSubmitting={(v) => (ui.submitting = v)}
		onInlineCreateSuccess={handleInlineCreateSuccess}
	/>
{/if}
