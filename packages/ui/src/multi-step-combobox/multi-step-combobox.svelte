<script
	lang="ts"
	generics="TValueMap extends Record<string, unknown>, TMultiple extends boolean = false"
>
	import Icon from '@iconify/svelte';
	import { AutoTruncator } from '#lib/auto-truncater';
	import { Badge } from '#lib/badge';
	import { buttonVariants } from '#lib/button';
	import type { TOption } from '#lib/combobox';
	import * as Command from '#lib/command';
	import {
		buildCustomFilterFn,
		type CommandClientConfig,
		type CommandServerConfig,
		type TInfiniteLoadingConfig
	} from '#lib/command';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { Input } from '#lib/input';
	import { Bound, Inline } from '#lib/layout';
	import * as Popover from '#lib/popover';
	import { cn } from '#lib/utils';
	import { toError } from '@norbital-ai/std';
	import { decodeNumber } from '@norbital-ai/std/json';
	import { isEqual } from 'es-toolkit/predicate';
	import { watch } from 'runed';
	import { tick, type Snippet } from 'svelte';
	import { Spinner } from '#lib/spinner';
	import { Effect, Number as Number_ } from 'effect';
	import MultiStepSelectionSidebar from './multi-step-selection-sidebar.svelte';
	import MultiStepHeader from './multi-step-header.svelte';
	import MultiStepValueLabel from './multi-step-value-label.svelte';

	const { t } = useI18n<UiKeys>();

	type TOutputValue<M extends boolean> = M extends true ? TValueMap[] : TValueMap;

	type TStepLabel = string | Snippet<[{ compact: boolean }]>;

	type StepOption<K extends keyof TValueMap> = TOption<TValueMap[K], { compact: boolean }>;
	type BuiltinStepDef<K extends keyof TValueMap> = {
		type: 'client' | 'server';
		label?: TStepLabel;
		options: StepOption<K>[];
		clientConfig?: CommandClientConfig;
		serverConfig?: CommandServerConfig;
		infiniteLoading?: TInfiniteLoadingConfig;
	};

	type CustomPickerParams<K extends keyof TValueMap> = {
		value: TValueMap[K] | undefined;
		onValueChange: (next: TValueMap[K] | undefined) => void;
		selection: Partial<TValueMap>;
	};

	type CustomStep<K extends keyof TValueMap> = {
		type: 'custom';
		label?: TStepLabel;
		render: Snippet<[CustomPickerParams<K>]>;
		formatSelection?: Snippet<[TValueMap[K], { compact: boolean } & Partial<TValueMap>]>;
	};

	type StepDef<K extends keyof TValueMap> = BuiltinStepDef<K> | CustomStep<K>;
	type StepsConfig = { [K in keyof TValueMap]: StepDef<K> };

	type SelectionDraft = Partial<TValueMap>;
	type TLocalState<M extends boolean> = M extends true ? SelectionDraft[] : SelectionDraft | null;

	type TMultiStepComboboxProps<M extends boolean> = {
		steps: StepsConfig;
		value?: TOutputValue<M> | null;
		onValueChange?: (value: TOutputValue<M> | null) => void;
		onSelectionChange?: (selection: Partial<TValueMap>) => void;

		multiple?: M;

		display?: Snippet<[TOutputValue<M> | null]>;
		emptyPlaceholder?: string | Snippet;
		disabled?: boolean;
		class?: string;
		sameWidth?: boolean;
		dropdownClass?: string;
		align?: 'start' | 'center' | 'end';
		allowClear?: boolean;
		hideChevron?: boolean;
		style?: string;
		itemHeight?: number;
		maxHeight?: number;
		overscan?: number;
		stepSeparator?: string;
		entityName?: string;
		panelHeight?: number;

		ariaLabelSelections?: string;
		ariaLabelList?: string;
	};

	/* ─────────────── Props ─────────────── */
	let {
		steps,
		value = null as TOutputValue<TMultiple> | null,
		onValueChange,
		onSelectionChange,
		multiple = false as TMultiple,
		display,
		emptyPlaceholder,
		disabled = false,
		class: className,
		sameWidth = false,
		dropdownClass,
		align,
		allowClear = false,
		hideChevron = false,
		style = '',
		itemHeight = 40,
		maxHeight = 300,
		overscan = 10,
		stepSeparator = ' → ',
		panelHeight = 420,
		ariaLabelSelections,
		ariaLabelList
	}: TMultiStepComboboxProps<TMultiple> = $props();

	const ariaLabelSelectionsEffective = $derived(
		ariaLabelSelections ?? t('common.existingSelections')
	);
	const ariaLabelListEffective = $derived(ariaLabelList ?? t('common.options'));

	const normalizeValue = (input: TOutputValue<TMultiple> | null): TValueMap[] => {
		if (!input) return [];
		return Array.isArray(input) ? (input as TValueMap[]) : [input as TValueMap];
	};

	const cloneSelection = (selection: TValueMap): SelectionDraft => ({ ...selection });

	const initializeLocalState = (): TLocalState<TMultiple> => {
		const base = normalizeValue(value);
		if (multiple) {
			const rows = base.map(cloneSelection);
			return rows as TLocalState<TMultiple>;
		}
		return (base[0] ? cloneSelection(base[0]) : null) as TLocalState<TMultiple>;
	};

	/* ─────────────── State ─────────────── */
	let open = $state(false);
	let searchValue = $state('');
	let currentStepIndex = $state(0);
	let currentSelectionIndex = $state(0);
	let localState = $state<TLocalState<TMultiple>>(initializeLocalState());

	let refs = $state({
		searchInput: null as HTMLInputElement | null,
		listContainer: null as HTMLDivElement | null
	});
	const comboboxId = $props.id();

	/* ─────────────── Type Guards ─────────────── */
	function isCustom<K extends keyof TValueMap>(def?: StepDef<K>): def is CustomStep<K> {
		return !!def && def.type === 'custom';
	}

	function isBuiltin<K extends keyof TValueMap>(def?: StepDef<K>): def is BuiltinStepDef<K> {
		return !!def && (def.type === 'client' || def.type === 'server');
	}

	function isServer<K extends keyof TValueMap>(
		def: BuiltinStepDef<K>
	): def is BuiltinStepDef<K> & { type: 'server' } {
		return def.type === 'server';
	}

	/* ─────────────── Derived State ─────────────── */
	const normalizedValue = $derived(normalizeValue(value));
	const stepKeys = $derived(Object.keys(steps) as Array<keyof TValueMap>);
	const currentStepKey = $derived(stepKeys[currentStepIndex]);
	const currentStepDef = $derived(currentStepKey ? steps[currentStepKey] : undefined);
	const isCustomStep = $derived(isCustom(currentStepDef));

	const normalizedLocalSelections = $derived(
		multiple
			? ((localState as SelectionDraft[]) ?? [])
			: localState
				? [localState as SelectionDraft]
				: []
	);
	const currentSelection = $derived(normalizedLocalSelections.at(currentSelectionIndex) ?? null);
	const hasLocalSelections = $derived(normalizedLocalSelections.length > 0);
	const hasDisplaySelections = $derived(normalizedValue.length > 0);
	const showSelectionsSidebar = $derived(multiple || hasLocalSelections);
	const isFirstStep = $derived(currentStepIndex === 0);
	const isFinalStep = $derived(stepKeys.length === 0 || currentStepIndex >= stepKeys.length - 1);

	const isSelectionComplete = (
		selection: SelectionDraft | null | undefined
	): selection is TValueMap => {
		if (!selection) return false;
		return stepKeys.every((key) => selection[key] != null);
	};

	// Extract configs from current step for Command.List
	const currentClientConfig = $derived(
		isBuiltin(currentStepDef) && !isServer(currentStepDef) ? currentStepDef.clientConfig : undefined
	);
	const currentServerConfig = $derived(
		isBuiltin(currentStepDef) && isServer(currentStepDef) ? currentStepDef.serverConfig : undefined
	);

	// Derived for local use (loading/error states)
	const currentIsLoading = $derived(
		currentClientConfig?.isLoading || currentServerConfig?.isLoading
	);

	const stepOptions = $derived(
		(isBuiltin(currentStepDef) ? currentStepDef.options : []) as TOption<
			TValueMap[keyof TValueMap],
			{ compact: boolean }
		>[]
	);

	const filteredOptions = $derived.by(() => {
		if (!isBuiltin(currentStepDef)) return [];
		if (isServer(currentStepDef) || !searchValue.trim()) return stepOptions;

		const search = searchValue.toLowerCase().trim();
		return stepOptions.filter((option) => {
			const label = (typeof option.label === 'string' ? option.label : '').toLowerCase();
			return label.includes(search);
		});
	});

	const isOptionSelected = $derived((optionValue: unknown): boolean => {
		if (!currentSelection || !currentStepKey) return false;
		return isEqual(currentSelection[currentStepKey], optionValue);
	});

	const disabledForwardNavigation = $derived.by(() => {
		if (isFinalStep || !currentSelection) return true;
		const currentKey = stepKeys[currentStepIndex];
		const nextKey = stepKeys[currentStepIndex + 1];
		const currentHasValue = currentKey != null && currentSelection[currentKey] != null;
		const nextHasValue = nextKey != null && currentSelection[nextKey] != null;
		return !(currentHasValue || nextHasValue);
	});

	/* ─────────────── Command Items for virtualization ─────────────── */
	const commandItems = $derived.by(() => {
		if (!isBuiltin(currentStepDef)) return [];

		return filteredOptions.map((option, index) => ({
			value: String(index),
			label: typeof option.label === 'string' ? option.label : String(option.value),
			_type: 'option' as const,
			_option: option,
			_index: index
		}));
	});

	/* ─────────────── Infinite Loading ─────────────── */
	// Adapt step's TInfiniteLoadingConfig to CommandInfiniteLoadingConfig for Command.List
	const currentInfiniteLoading = $derived.by(() => {
		if (!isBuiltin(currentStepDef) || !currentStepDef.infiniteLoading) return undefined;
		const stepConfig = currentStepDef.infiniteLoading;
		return {
			total: stepConfig.total,
			hasMore: stepConfig.hasMore,
			onLoadMore: (info: { loadedCount: number; lastVisibleIndex: number }) => {
				stepConfig.handleInfiniteLoad({
					loadedCount: info.loadedCount,
					lastVirtualIndex: info.lastVisibleIndex
				});
			}
		};
	});

	function handleCommandSelect(value: string) {
		const index = decodeNumber(value);
		if (!Number.isInteger(index)) return;
		const option = filteredOptions[index];
		if (option) handleSelect(option.value);
	}

	/* ─────────────── Watchers ─────────────── */
	watch(
		() => ({ normalized: normalizedValue, isOpen: open }),
		({ normalized, isOpen }) => {
			if (multiple) {
				const currentList = getSelectionsArray();
				const partials = currentList.filter((draft) => !isSelectionComplete(draft));
				const committedDrafts = normalized.map((item) => {
					const existing = currentList.find((draft) => isEqual(draft, item));
					return existing ?? cloneSelection(item);
				});
				const nextList = [
					...committedDrafts,
					...partials.filter(
						(draft) => !committedDrafts.some((candidate) => isEqual(candidate, draft))
					)
				];

				if (!isEqual(currentList, nextList)) {
					setSelectionsArray(nextList);
				}

				if (nextList.length === 0) {
					currentSelectionIndex = 0;
					currentStepIndex = 0;
				} else if (currentSelectionIndex >= nextList.length) {
					currentSelectionIndex = nextList.length - 1;
					currentStepIndex = firstIncompleteStep(nextList[currentSelectionIndex]);
				}
				// On open, default the visible step to the first incomplete step,
				// or the last step if the selection is fully configured
				if (isOpen && nextList.length > 0) {
					const selIdx = Number_.clamp(currentSelectionIndex, {
						minimum: 0,
						maximum: Math.max(nextList.length - 1, 0)
					});
					currentStepIndex = firstIncompleteStep(nextList[selIdx]);
				}
				return;
			}

			const current = (localState as SelectionDraft | null) ?? null;
			const nextSingle = normalized[0] ? cloneSelection(normalized[0]) : null;

			if (!isOpen) {
				if (!isEqual(current, nextSingle)) {
					localState = nextSingle as TLocalState<TMultiple>;
				}
				currentSelectionIndex = 0;
				currentStepIndex = nextSingle ? firstIncompleteStep(nextSingle) : 0;
				return;
			}

			if (!current) {
				if (!isEqual(current, nextSingle)) {
					localState = nextSingle as TLocalState<TMultiple>;
				}
				currentSelectionIndex = 0;
				currentStepIndex = nextSingle ? firstIncompleteStep(nextSingle) : 0;
				return;
			}

			if (isSelectionComplete(current) && !isEqual(current, nextSingle)) {
				localState = nextSingle as TLocalState<TMultiple>;
				currentSelectionIndex = 0;
				currentStepIndex = nextSingle ? firstIncompleteStep(nextSingle) : 0;
			}

			// When open with a complete selection, prefer showing the last step
			if (isOpen && current && isSelectionComplete(current)) {
				currentStepIndex = Math.max(0, stepKeys.length - 1);
			}
		}
	);

	/* ─────────────── Helpers & Event Handlers ─────────────── */
	const getSelectionsArray = () =>
		multiple
			? ((localState as SelectionDraft[]) ?? [])
			: localState
				? [localState as SelectionDraft]
				: [];

	const setSelectionsArray = (next: SelectionDraft[]): void => {
		localState = (multiple ? next : (next[0] ?? null)) as TLocalState<TMultiple>;
	};

	const emitValueFrom = (list: SelectionDraft[]) => {
		if (!onValueChange) return;
		const committed = list.filter(isSelectionComplete) as TValueMap[];
		const result = multiple
			? ((committed.length > 0 ? committed : null) as TOutputValue<TMultiple> | null)
			: ((committed[0] ?? null) as TOutputValue<TMultiple> | null);
		onValueChange(result);
	};

	function firstIncompleteStep(selection: SelectionDraft | null | undefined): number {
		if (!selection || stepKeys.length === 0) return 0;
		const idx = stepKeys.findIndex((key) => selection[key] == null);
		return idx === -1 ? Math.max(0, stepKeys.length - 1) : idx;
	}

	function focusInputSoon() {
		Effect.runFork(
			Effect.tryPromise({ try: () => tick(), catch: toError }).pipe(
				Effect.map(() => refs.searchInput?.focus()),
				Effect.ignoreCause({
					log: true,
					message: '[MultiStepCombobox] Failed to focus the search input'
				})
			)
		);
	}

	const ensureSelectionExists = () => {
		let list = getSelectionsArray();
		if (list.length === 0) {
			list = [{} as SelectionDraft];
			setSelectionsArray(list);
			onSelectionChange?.({} as Partial<TValueMap>);
		}

		currentSelectionIndex = Math.min(currentSelectionIndex, list.length - 1);
		currentSelectionIndex = Math.max(currentSelectionIndex, 0);
		currentStepIndex = firstIncompleteStep(list[currentSelectionIndex]);
	};

	const updateSelection = (mutator: (draft: SelectionDraft) => SelectionDraft) => {
		const list = getSelectionsArray();
		const index = Number_.clamp(currentSelectionIndex, {
			minimum: 0,
			maximum: Math.max(list.length - 1, 0)
		});
		const base = list[index] ?? ({} as SelectionDraft);
		const updated = mutator({ ...base });
		const nextList = [...list];
		nextList[index] = updated;
		setSelectionsArray(nextList);
		onSelectionChange?.(updated);
		return { index, updated, nextList };
	};

	function handleSelect(optionValue: TValueMap[keyof TValueMap]) {
		if (disabled) return;
		if (!currentStepKey) return;

		const list = getSelectionsArray();
		const selection = list[currentSelectionIndex] ?? ({} as SelectionDraft);
		const alreadySelected = isEqual(selection?.[currentStepKey], optionValue);

		const { updated } = updateSelection((prev) => ({
			...prev,
			[currentStepKey]: alreadySelected ? undefined : optionValue
		}));

		searchValue = '';

		if (alreadySelected) {
			return;
		}

		if (currentStepIndex < stepKeys.length - 1) {
			const nextIncomplete = stepKeys.findIndex(
				(key, idx) => idx > currentStepIndex && updated[key] == null
			);
			currentStepIndex =
				nextIncomplete !== -1
					? nextIncomplete
					: Math.min(currentStepIndex + 1, stepKeys.length - 1);
			focusInputSoon();
		}

		if (isSelectionComplete(updated)) {
			emitValueFrom(getSelectionsArray());
		}
	}

	function completeCurrentSelection() {
		if (disabled) return;
		const list = getSelectionsArray();
		const selection = list[currentSelectionIndex];

		if (!selection || !isSelectionComplete(selection)) return;

		emitValueFrom([...list]);
		if (multiple) {
			addPartialSelection();
		} else {
			handleClose();
		}
	}

	function addPartialSelection() {
		if (disabled) return;
		const nextList = [...getSelectionsArray(), {} as SelectionDraft];
		setSelectionsArray(nextList);
		currentSelectionIndex = nextList.length - 1;
		currentStepIndex = 0;
		searchValue = '';
		onSelectionChange?.({} as Partial<TValueMap>);
		focusInputSoon();
	}

	function selectSelection(index: number, event?: Event) {
		event?.stopPropagation();
		const list = getSelectionsArray();
		if (!list[index]) return;
		currentSelectionIndex = index;
		currentStepIndex = firstIncompleteStep(list[index]);
		searchValue = '';
		focusInputSoon();
		onSelectionChange?.(list[index]);
	}

	function removeSelectionAt(index: number, event?: Event) {
		if (disabled) return;
		event?.stopPropagation();
		const list = getSelectionsArray();
		if (!list[index]) return;

		const updated = list.filter((_, i) => i !== index);
		setSelectionsArray(updated);
		emitValueFrom(updated);

		currentSelectionIndex = updated.length === 0 ? 0 : Math.min(index, updated.length - 1);
		currentStepIndex =
			updated.length === 0 ? 0 : firstIncompleteStep(updated[currentSelectionIndex]);
		onSelectionChange?.(updated[currentSelectionIndex] ?? ({} as Partial<TValueMap>));
	}

	function handleClear(event?: Event) {
		if (disabled) return;
		event?.stopPropagation();
		setSelectionsArray([]);
		emitValueFrom([]);
		onSelectionChange?.({} as Partial<TValueMap>);
		handleClose();
	}

	function goToPreviousStep() {
		if (currentStepIndex > 0) {
			currentStepIndex--;
			searchValue = '';
			focusInputSoon();
		} else {
			handleClose();
		}
	}

	function goToNextStep() {
		if (isFinalStep) return;
		currentStepIndex = Math.min(currentStepIndex + 1, stepKeys.length - 1);
		searchValue = '';
		focusInputSoon();
	}

	function handleOpenChange(isOpen: boolean) {
		if (isOpen) {
			open = true;
			if (!disabled) {
				ensureSelectionExists();
			}
			if (isBuiltin(currentStepDef)) {
				focusInputSoon();
			}
		} else {
			handleClose();
		}
	}

	function handleClose() {
		open = false;
		searchValue = '';
		currentStepIndex = 0;
		currentSelectionIndex = 0;
		localState = initializeLocalState();
	}

	function handleSearchInput(event: Event) {
		if (disabled) return;
		const target = event.target as HTMLInputElement;
		searchValue = target.value;
		if (isBuiltin(currentStepDef) && isServer(currentStepDef)) {
			currentStepDef.serverConfig?.onSearch(searchValue);
		}
	}
</script>

{#snippet stepValueLabel(
	selection: SelectionDraft,
	stepKey: keyof TValueMap,
	keyIndex: number,
	separatorClass: string,
	fallbackClass: string
)}
	<MultiStepValueLabel
		{selection}
		{stepKey}
		{keyIndex}
		{separatorClass}
		{fallbackClass}
		{stepSeparator}
		{steps}
	/>
{/snippet}

{#snippet selectionBadges(selections: TValueMap[])}
	<AutoTruncator items={selections} gap={4} class="min-w-0 flex-1 text-xs">
		{#snippet children(item: TValueMap, selectionIndex: number)}
			<Badge variant="outline" class="h-5 gap-1 truncate px-2 py-0 text-xs" data-truncate-item>
				{#each stepKeys as stepKey, keyIndex}
					{@render stepValueLabel(item, stepKey, keyIndex, 'opacity-50', 'opacity-75')}
				{/each}
			</Badge>
		{/snippet}
		{#snippet ellipsis(hidden: number)}
			<span class="text-muted-foreground" data-truncate-ellipsis> +{hidden} </span>
		{/snippet}
	</AutoTruncator>
{/snippet}

<Popover.Root {open} onOpenChange={handleOpenChange}>
	<div class={cn('group relative w-full', className)} {style}>
		<Popover.Trigger
			aria-expanded={open}
			aria-haspopup="listbox"
			class={cn(
				'flex min-h-8 w-full items-center rounded-md border border-input bg-background py-1 pr-2 pl-2',
				'hover:bg-accent hover:text-accent-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none focus-visible:ring-inset'
			)}
			role="combobox"
			aria-disabled={disabled}
		>
			<div class="flex min-w-0 grow items-center">
				{#if hasDisplaySelections}
					{#if display}
						{@render display(value)}
					{:else}
						{@render selectionBadges(normalizedValue)}
					{/if}
				{:else if typeof emptyPlaceholder === 'string'}
					<span class="text-xs font-normal text-muted-foreground">{emptyPlaceholder}</span>
				{:else if emptyPlaceholder}
					{@render emptyPlaceholder()}
				{:else}
					<span class="text-xs font-normal text-muted-foreground"
						>{multiple ? t('common.buildItemsStepByStep') : t('common.buildItemStepByStep')}</span
					>
				{/if}
			</div>
		</Popover.Trigger>
		<div
			class="pointer-events-none absolute top-1/2 right-1 flex -translate-y-1/2 items-center justify-center"
		>
			{#if allowClear && hasDisplaySelections && !disabled}
				<button
					type="button"
					class={cn(
						buttonVariants({ variant: 'outline' }),
						'pointer-events-auto h-4 w-min flex-none px-1 py-0 text-meta opacity-0 transition-opacity',
						'group-hover:opacity-100 group-focus-within:opacity-100'
					)}
					onclick={(e) => {
						e.preventDefault();
						handleClear(e);
					}}
					aria-label={t('common.clearSelection')}
				>
					{t('common.clear')}
				</button>
			{:else if !hideChevron}
				<Icon
					icon="lucide:chevrons-up-down"
					class="h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-50 group-focus-within:opacity-50"
					aria-hidden="true"
				/>
			{/if}
		</div>
	</div>

	<Popover.Content
		onCloseAutoFocus={(e) => e.preventDefault()}
		class={cn(
			'overflow-hidden p-0',
			dropdownClass,
			showSelectionsSidebar ? 'min-w-[800px]' : 'min-w-[320px]'
		)}
		{sameWidth}
		{align}
		sideOffset={4}
		aria-multiselectable={false}
		style={`max-height: ${panelHeight}px;`}
	>
		<Inline align="stretch" gap="none" style={`height: ${panelHeight}px;`}>
			{#if showSelectionsSidebar}
				<MultiStepSelectionSidebar
					selections={normalizedLocalSelections}
					{currentSelectionIndex}
					{multiple}
					{disabled}
					ariaLabel={ariaLabelSelectionsEffective}
					{steps}
					isComplete={isSelectionComplete}
					onSelect={selectSelection}
					onRemove={removeSelectionAt}
					onAdd={addPartialSelection}
					{stepValueLabel}
				/>
			{/if}

			{#if currentSelection && stepKeys.length > 0}
				<Bound size="full" clip grow>
					<Command.Root
						filter={buildCustomFilterFn(filteredOptions)}
						shouldFilter={false}
						class="flex h-full flex-col"
						items={commandItems}
						onValueChange={handleCommandSelect}
					>
						<MultiStepHeader
							{currentStepIndex}
							stepCount={stepKeys.length}
							{isFirstStep}
							{disabled}
							{disabledForwardNavigation}
							onPrevious={goToPreviousStep}
							onNext={goToNextStep}
						/>

						<Bound size="full" clip pad="sm" grow>
							{#if isCustomStep && isCustom(currentStepDef) && currentStepKey}
								{@render currentStepDef.render({
									value: currentSelection?.[currentStepKey],
									onValueChange: (nextValue) => {
										if (!currentStepKey) return;
										updateSelection((prev) => ({
											...prev,
											[currentStepKey]: nextValue
										}));
									},
									selection: currentSelection ?? {}
								})}
							{:else}
								<div class="relative w-full p-1">
									<Input
										type="text"
										placeholder={t('common.search')}
										bind:value={searchValue}
										class="w-full text-sm"
										tabindex={0}
										bind:ref={refs.searchInput}
										aria-label={t('common.searchTree')}
										{disabled}
										oninput={handleSearchInput}
									/>
									<Icon
										icon="lucide:search"
										class="absolute top-1/2 right-3 z-20 -translate-y-1/2 transform text-muted-foreground dark:text-muted-foreground"
										aria-hidden="true"
									/>
								</div>
								<Command.List
									bind:ref={refs.listContainer}
									class="relative w-full bg-transparent p-1"
									style={`max-height: ${Math.min(maxHeight, panelHeight - 140)}px;`}
									id="{comboboxId}-listbox"
									aria-label={ariaLabelListEffective}
									{itemHeight}
									{overscan}
									clientConfig={currentClientConfig}
									serverConfig={currentServerConfig}
									infiniteLoading={currentInfiniteLoading}
								>
									{#snippet itemSnippet({ item, isSelected })}
										{@const option = item._option as TOption<
											TValueMap[keyof TValueMap],
											{ compact: boolean }
										>}
										{@const selected = isOptionSelected(option.value)}
										<div
											class={cn(
												'relative z-10 flex w-full cursor-pointer items-center justify-between rounded-sm px-3 text-left',
												{
													'bg-brand-100 text-brand': selected
												}
											)}
											style={`height: ${itemHeight}px;`}
										>
											<Inline gap="sm" grow class="min-w-0 text-xs">
												<div class="min-w-0 flex-1 px-2">
													{#if typeof option.label === 'string'}
														<span
															class="truncate text-secondary-foreground dark:text-muted-foreground"
															>{option.label}</span
														>
													{:else}
														{@render option.label(option.value, { compact: false })}
													{/if}
												</div>
											</Inline>
											{#if selected}
												<div
													class="absolute right-2 flex h-4 w-4 items-center justify-center rounded-full bg-brand-100 dark:bg-brand-900"
												>
													<Icon
														icon="lucide:check"
														class="h-2.5 w-2.5 text-brand dark:text-brand-400"
													/>
												</div>
											{/if}
										</div>
									{/snippet}
									{#snippet placeholderSnippet({ index })}
										<div class="flex w-full items-center px-3" style={`height: ${itemHeight}px;`}>
											<div class="h-3 w-32 animate-pulse rounded bg-muted/40"></div>
										</div>
									{/snippet}
									{#if currentIsLoading && filteredOptions.length === 0}
										<Inline gap="sm" justify="center" class="p-3 text-xs">
											<Spinner class="h-3 w-3" />
											{t('common.loading')}
										</Inline>
									{:else if commandItems.length === 0}
										<div class="p-3 text-center text-xs">{t('common.noResultsFound')}</div>
									{/if}
								</Command.List>
							{/if}
						</Bound>
					</Command.Root>
				</Bound>
			{:else}
				<Inline justify="center" gap="none" grow class="p-4 text-meta">
					{multiple ? t('common.selectOrCreateToStart') : t('common.createToStart')}
				</Inline>
			{/if}
		</Inline>
	</Popover.Content>
</Popover.Root>
