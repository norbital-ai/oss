<script lang="ts">
	import { Button } from '#lib/button';
	import * as Command from '#lib/command';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { Inline, SCROLL_AXIS_CLASSES, Stack } from '#lib/layout';
	import { cn } from '#lib/utils';
	import { humanize, toError } from '@norbital-ai/std';
	import { Effect } from 'effect';
	import { isEqual } from 'es-toolkit/predicate';
	import { tick } from 'svelte';
	import TagsInputTag from './tags-input-tag.svelte';
	import {
		INPUT_TYPE_CONFIGS,
		type ColoredTag,
		type ColoredTagsInputProps,
		type TagColor
	} from '#lib/tags-input/types';

	const { t } = useI18n<UiKeys>();

	const AVAILABLE_COLORS: TagColor[] = [
		'red',
		'orange',
		'yellow',
		'green',
		'blue',
		'purple',
		'pink',
		'brown',
		'grey',
		'black'
	];
	const DEFAULT_COLOR: TagColor = 'grey';

	// ================================
	// PROPS & STATE
	// ================================
	let {
		value = [],
		onValueChange,
		fixedTag,
		placeholder = t('misc.addTags'),
		class: className,
		disabled = false,
		readonly = false,
		type = 'text',
		validate: customValidate,
		parseValue: customParseValue,
		displayValue: customDisplayValue,
		maxVisible,
		enableColorSelection = false,
		maxTags,
		...inputProps
	}: ColoredTagsInputProps = $props();

	// Local UI state
	let inputValue = $state<string | number>('');
	let selectedDynamicTagIndex = $state<number | undefined>();
	let isInputInvalid = $state(false);
	let inputElement: HTMLInputElement | null = $state(null);

	// Color selection state
	let isSelectingColor = $state(false);
	let validatedInput = $state<string | number>('');
	let colorSearchValue = $state('');

	// ================================
	// TYPE CONFIGURATION
	// ================================
	const typeConfig = $derived(INPUT_TYPE_CONFIGS[type] || INPUT_TYPE_CONFIGS.text);
	const parseInputValue = $derived(
		customParseValue || ((input: string) => typeConfig.parse(input))
	);
	const formatDisplayValue = $derived(customDisplayValue || ((val: ColoredTag) => val.value));

	// ================================
	// DERIVED STATE (CORE ARCHITECTURE)
	// ================================
	const allTags = $derived.by(() => {
		const combined = fixedTag !== undefined ? [fixedTag, ...value] : [...value];
		const uniqueTags: ColoredTag[] = [];
		for (const tag of combined) {
			if (!uniqueTags.some((t) => isEqual(t.value, tag.value))) {
				uniqueTags.push(tag);
			}
		}
		return uniqueTags;
	});

	const visibleTags = $derived.by(() => {
		if (!maxVisible || maxVisible >= allTags.length) return allTags;
		return allTags.slice(0, maxVisible);
	});

	const hiddenTagCount = $derived(allTags.length - visibleTags.length);
	const isMaxTagsReached = $derived(maxTags !== undefined && value.length >= maxTags);

	const filteredColors = $derived.by(() => {
		if (!colorSearchValue.trim()) return AVAILABLE_COLORS;
		return AVAILABLE_COLORS.filter((color) =>
			color.toLowerCase().includes(colorSearchValue.toLowerCase())
		);
	});

	// Command items for color selection
	const colorItems = $derived(
		filteredColors.map((color) => ({
			value: color,
			label: humanize(color),
			disabled,
			_color: color
		}))
	);

	// ================================
	// VALIDATION & EVENT EMISSION
	// ================================
	const validateInput = (input: string | number): string | number | undefined => {
		const trimmedInput = String(input).trim();
		if (!trimmedInput) return undefined;

		const parsedValue = parseInputValue(trimmedInput);
		if (parsedValue === undefined) return undefined;

		// For duplicate check, compare string versions to handle mixed types
		const isDuplicate = allTags.some((t) => String(t.value) === String(parsedValue));
		if (isDuplicate) return undefined;

		if (customValidate) {
			const testTag: ColoredTag = { value: String(parsedValue), color: DEFAULT_COLOR };
			const validatedTag = customValidate(testTag, value);
			return validatedTag?.value;
		}

		if (
			typeConfig.validate &&
			!typeConfig.validate(
				parsedValue,
				value.map((v) => v.value)
			)
		)
			return undefined;

		return parsedValue;
	};

	const addTag = () => {
		if (readonly || isMaxTagsReached) return;

		const validatedValue = validateInput(inputValue);
		if (validatedValue !== undefined) {
			if (enableColorSelection) {
				validatedInput = validatedValue;
				isSelectingColor = true;
				colorSearchValue = '';
				isInputInvalid = false;
			} else {
				// FIX: Use the original validatedValue to preserve its type (e.g., number)
				const newTag: ColoredTag = { value: String(validatedValue), color: DEFAULT_COLOR };
				onValueChange?.([...value, newTag]);
				inputValue = '';
				isInputInvalid = false;
			}
		} else {
			isInputInvalid = !!String(inputValue).trim();
		}
	};

	const addTagWithColor = (color: TagColor) => {
		if (validatedInput === '' || isMaxTagsReached) return;

		// FIX: Use the original validatedInput to preserve its type
		const newTag: ColoredTag = { value: String(validatedInput), color };
		onValueChange?.([...value, newTag]);

		inputValue = '';
		validatedInput = '';
		isSelectingColor = false;
		colorSearchValue = '';
		isInputInvalid = false;
	};

	const cancelColorSelection = () => {
		isSelectingColor = false;
		validatedInput = '';
		colorSearchValue = '';
		Effect.runFork(
			Effect.tryPromise({ try: () => tick(), catch: toError }).pipe(
				Effect.map(() => inputElement?.focus()),
				Effect.ignoreCause({
					log: true,
					message: '[TagsInput] Failed to restore input focus'
				})
			)
		);
	};

	const deleteTag = (tagToDelete: ColoredTag) => {
		if (readonly || isEqual(tagToDelete, fixedTag)) return;
		onValueChange?.(value.filter((tag) => !isEqual(tag.value, tagToDelete.value)));
		selectedDynamicTagIndex = undefined;
	};

	const deleteDynamicTagAtIndex = (index: number) => {
		if (readonly || index < 0 || index >= value.length) return;
		const newValue = [...value];
		newValue.splice(index, 1);
		onValueChange?.(newValue);
	};

	// ================================
	// KEYBOARD NAVIGATION
	// ================================
	const handleKeydown = (event: KeyboardEvent) => {
		if (readonly || disabled) return;

		if (event.key === 'Enter') {
			event.preventDefault();
			event.stopPropagation();
			if (!isMaxTagsReached) {
				addTag();
			}
			return;
		}

		if (event.key === 'Escape' && isSelectingColor) {
			event.preventDefault();
			cancelColorSelection();
			return;
		}

		const target = event.target as HTMLInputElement;
		const currentInputValue = String(inputValue);

		if (currentInputValue.length > 0 || (target.selectionStart ?? 0) > 0) {
			selectedDynamicTagIndex = undefined;
			return;
		}

		if (event.key === 'Backspace') {
			event.preventDefault();
			if (selectedDynamicTagIndex !== undefined) {
				deleteDynamicTagAtIndex(selectedDynamicTagIndex);
				selectedDynamicTagIndex =
					selectedDynamicTagIndex > 0 ? selectedDynamicTagIndex - 1 : undefined;
			} else if (value.length > 0) {
				selectedDynamicTagIndex = value.length - 1;
			}
		}
	};
</script>

{#if isSelectingColor}
	<Stack gap="sm" class="rounded-md border border-input bg-background p-2">
		<p class="text-xs font-medium">{t('misc.selectColorFor', { value: String(validatedInput) })}</p>

		<Command.Root
			shouldFilter={false}
			class="gap-2"
			items={colorItems}
			onValueChange={(value) => addTagWithColor(value as TagColor)}
		>
			<Command.Input
				autofocus={true}
				bind:value={colorSearchValue}
				placeholder={t('misc.searchColors')}
				{disabled}
				class="text-xs"
			>
				{#snippet prefix()}
					<svg
						class="h-3 w-3 text-muted-foreground"
						fill="none"
						stroke="currentColor"
						viewBox="0 0 24 24"
					>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width="2"
							d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zM21 5H9M21 9H9M21 13H9M21 17H9"
						></path>
					</svg>
				{/snippet}
			</Command.Input>

			<Command.List class="max-h-[200px]" itemHeight={28} gap={2}>
				{#snippet itemSnippet({ item })}
					{@const color = item._color as TagColor}
					<Inline gap="sm" class="cursor-pointer px-2 py-1">
						<div
							class={cn('h-3 w-3 rounded-full border', {
								'border-yellow-700 bg-yellow-200': color === 'yellow',
								'border-red-700 bg-red-200': color === 'red',
								'border-orange-700 bg-orange-200': color === 'orange',
								'border-green-700 bg-green-200': color === 'green',
								'border-blue-700 bg-blue-200': color === 'blue',
								'border-purple-700 bg-purple-200': color === 'purple',
								'border-pink-700 bg-pink-200': color === 'pink',
								'border-brown-700 bg-brown-200': color === 'brown',
								'border-gray-700 bg-gray-200': color === 'grey',
								'border-black bg-gray-800': color === 'black'
							})}
						></div>
						<span class="text-xs">{humanize(color)}</span>
					</Inline>
				{/snippet}
				{#if colorItems.length === 0}
					<Command.Empty class="text-xs">{t('misc.noColorsFound')}</Command.Empty>
				{/if}
			</Command.List>

			<Inline justify="end" gap="sm">
				<Button
					variant="secondary"
					size="sm"
					onclick={cancelColorSelection}
					{disabled}
					class="text-xs"
				>
					{t('common.back')}
				</Button>
			</Inline>
		</Command.Root>
	</Stack>
{:else}
	<div
		class={cn(
			'flex h-8 w-full flex-nowrap items-center gap-1 rounded-md border border-input bg-background px-1.5 py-0 shadow-xs',
			SCROLL_AXIS_CLASSES.x,
			{ 'cursor-not-allowed opacity-50': disabled },
			className
		)}
		aria-disabled={disabled || readonly}
	>
		{#each visibleTags as tag (tag.value)}
			<TagsInputTag
				value={String(formatDisplayValue(tag))}
				color={tag.color}
				{disabled}
				{readonly}
				onDelete={() => deleteTag(tag)}
				isFixed={isEqual(tag, fixedTag)}
				isSelected={value[selectedDynamicTagIndex ?? -1]?.value === tag.value}
			/>
		{/each}

		{#if hiddenTagCount > 0}
			<span
				class="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-meta"
				title={t('misc.moreTags', { count: hiddenTagCount })}
			>
				+{hiddenTagCount}
			</span>
		{/if}

		{#if !readonly}
			<input
				bind:this={inputElement}
				{...inputProps}
				{type}
				{placeholder}
				bind:value={inputValue}
				onkeydown={handleKeydown}
				disabled={disabled || isMaxTagsReached}
				data-invalid={isInputInvalid}
				class={cn(
					'h-8 min-w-16 shrink grow basis-0 border-none bg-transparent px-0.5 text-xs text-foreground outline-none placeholder:text-muted-foreground',
					'focus:outline-none disabled:cursor-not-allowed',
					'data-[invalid=true]:text-destructive'
				)}
				aria-label={t('misc.addTag')}
				aria-invalid={isInputInvalid}
			/>
		{/if}

		{#if isMaxTagsReached && !readonly}
			<span class="shrink-0 text-meta">
				{maxTags}/{maxTags}
			</span>
		{/if}
	</div>
{/if}
