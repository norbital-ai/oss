<script lang="ts">
	// ============================================================================
	// IMPORTS & DEPENDENCIES
	// ============================================================================
	import * as Popover from '#lib/popover';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { cn } from '#lib/utils';
	import Icon from '@iconify/svelte';
	import Button, { buttonVariants } from '../button/button.svelte';
	import StarRating from './star-rating.svelte';
	import Star from './star-rating-star.svelte';
	import { Inline, Stack } from '#lib/layout';
	import { removeScalarRow, scalarPickerPayload } from '#lib/utils/scalar-picker';

	const { t } = useI18n<UiKeys>();

	// ============================================================================
	// COMPONENT PROPS
	// ============================================================================
	interface Props {
		value?: number | number[] | null;
		multiple?: boolean;
		onValueChange?: (value: number | number[] | null) => void;
		disabled?: boolean;
		readonly?: boolean;
		allowClear?: boolean;
		class?: string;
		style?: string;
	}

	let {
		value,
		multiple = false,
		onValueChange,
		disabled = false,
		readonly = false,
		allowClear = true,
		class: className = '',
		style
	}: Props = $props();

	// ============================================================================
	// STATE MANAGEMENT
	// ============================================================================
	let isOpen = $state(false);

	// Internal editing state - keeps ALL ratings (valid and unset)
	let coercedRatings = $derived.by(() => {
		if (!value) {
			return multiple ? [] : [0];
		} else if (Array.isArray(value)) {
			return [...value];
		} else {
			return [value];
		}
	});

	// Helper to check if a rating is valid (> 0)
	const isValidRating = (rating: number): boolean => {
		return rating > 0;
	};

	// Get only valid ratings for parent component
	const validRatings = $derived.by(() => coercedRatings.filter(isValidRating));

	const hasValidRatings = $derived(validRatings.length > 0);

	// For single mode - always returns number | null
	const currentSingleValue = $derived.by((): number | null => {
		if (multiple) return validRatings[0] || null;
		if (Array.isArray(value)) return value[0] || null;
		return value || null;
	});

	// ============================================================================
	// DISPLAY HELPERS
	// ============================================================================
	const triggerText = $derived.by((): string => {
		if (!hasValidRatings) {
			return multiple ? t('misc.noRatingsSelected') : t('misc.selectRating');
		}

		if (multiple) {
			const ratingsText = validRatings.map((r) => `${r}/5`).join(', ');
			return ratingsText;
		} else {
			return `${validRatings[0]}/5`;
		}
	});

	const hasValue = $derived.by((): boolean => {
		if (multiple) {
			return validRatings.length > 0;
		} else {
			return currentSingleValue !== null;
		}
	});

	// ============================================================================
	// EVENT HANDLERS
	// ============================================================================
	const notifyParent = () => {
		if (readonly || !onValueChange) return;
		onValueChange(scalarPickerPayload(coercedRatings.filter(isValidRating), multiple));
	};

	const updateRating = (index: number, rating: number) => {
		if (readonly || disabled) return;

		// Update internal state
		coercedRatings[index] = rating;

		// Notify parent with valid ratings
		notifyParent();
	};

	const addRating = () => {
		if (readonly || disabled) return;
		coercedRatings = [...coercedRatings, 0];
		// Don't notify parent until user sets a rating
	};

	const removeRating = (index: number) => {
		if (readonly || disabled) return;
		coercedRatings = removeScalarRow(coercedRatings, index, multiple);
		notifyParent();
	};

	const handleRatingChange = (newRating: number) => {
		if (!multiple) {
			updateRating(0, newRating);
		}
	};

	const handleClear = () => {
		if (!onValueChange || readonly || disabled) return;

		if (multiple) {
			coercedRatings = [];
		} else {
			coercedRatings = [0];
		}
		notifyParent();
	};

	// Get visual state for a rating entry
	const getEntryState = (rating: number) => {
		if (isValidRating(rating)) return 'valid';
		return 'empty';
	};
</script>

<!-- ============================================================================ -->
<!-- READONLY MODE -->
<!-- ============================================================================ -->
{#if readonly}
	<Popover.Root bind:open={isOpen}>
		<Popover.Trigger
			class={cn(
				'flex h-auto min-h-8 w-full cursor-pointer items-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm shadow-xs transition-colors hover:bg-accent',
				className
			)}
			{style}
		>
			<Icon
				icon="lucide:star"
				class={cn('h-4 w-4', hasValue ? 'text-yellow-500' : 'text-muted-foreground')}
			/>
			<span class="flex-1 truncate text-left text-xs">{triggerText}</span>
		</Popover.Trigger>

		<Popover.Content class="w-80 p-4" align="start">
			<Stack gap="sm">
				<Inline gap="sm">
					<Icon icon="lucide:star" class="h-5 w-5 text-yellow-500" />
					<h4 class="font-semibold text-foreground">{t('misc.ratingDetails')}</h4>
				</Inline>

				{#if hasValidRatings}
					<Stack gap="sm">
						{#each validRatings as rating, index (index)}
							<Inline justify="between" gap="sm" class="rounded-md bg-muted/40 p-3">
								<span class="text-sm font-medium">
									{multiple ? t('misc.ratingIndex', { index: index + 1 }) : t('misc.currentRating')}
								</span>
								<Inline gap="sm">
									<StarRating value={rating} readonly class="text-yellow-400">
										{#snippet children({ items })}
											{#each items as item (item.index)}
												<Star {...item} class="h-4 w-4" />
											{/each}
										{/snippet}
									</StarRating>
									<span class="text-sm font-semibold">{rating}/5</span>
								</Inline>
							</Inline>
						{/each}
					</Stack>
				{:else}
					<Stack gap="sm" align="center" class="py-4 text-center">
						<Icon icon="lucide:star" class="h-8 w-8 text-muted-foreground" />
						<p class="text-sm text-muted-foreground">{t('misc.noRatingsAssigned')}</p>
					</Stack>
				{/if}
			</Stack>
		</Popover.Content>
	</Popover.Root>

	<!-- ============================================================================ -->
	<!-- EDIT MODE -->
	<!-- ============================================================================ -->
{:else if multiple}
	<!-- Multiple mode uses popover interface like Money component -->
	<Popover.Root bind:open={isOpen}>
		<Popover.Trigger
			class={cn(
				'group relative flex h-auto min-h-8 w-full items-center gap-2 rounded-md p-1 pl-2 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none focus-visible:ring-inset',
				buttonVariants({ variant: 'outline', class: 'bg-background px-2 shadow-xs' }),
				className
			)}
			{style}
			{disabled}
		>
			<!-- Trigger Content -->
			<Icon
				icon="lucide:star"
				class={cn('h-4 w-4', hasValidRatings ? 'text-yellow-500' : 'text-muted-foreground')}
			/>
			<span
				class={cn(
					'truncate text-xs',
					hasValidRatings ? 'text-foreground' : 'text-muted-foreground'
				)}
			>
				{triggerText}
			</span>
			<Icon
				icon="lucide:chevrons-up-down"
				class={cn(
					'ml-auto h-4 w-4 flex-none text-muted-foreground',
					allowClear && hasValue ? 'group-hover:invisible' : ''
				)}
			/>

			<!-- Clear button -->
			{#if allowClear && hasValue}
				<Button
					size="icon"
					variant="ghost"
					class="invisible absolute top-1/2 right-1 h-6 w-6 -translate-y-1/2 rounded-full p-0 group-hover:visible focus:visible"
					onclick={handleClear}
					aria-label={t('dataRenderer.clearSelection')}
					tabindex={-1}
				>
					<Icon icon="lucide:x" class="h-4 w-4" />
				</Button>
			{/if}
		</Popover.Trigger>

		<Popover.Content class="p-0" align="start" sideOffset={4}>
			<Stack gap="md" class="p-1">
				{#if coercedRatings.length === 0}
					<!-- Empty state -->
					<Stack gap="sm" class="p-4 py-8 text-center">
						<Icon icon="lucide:star" class="mx-auto h-12 w-12 text-muted-foreground" />
						<h4 class="font-medium text-foreground">{t('misc.noRatingsConfigured')}</h4>
						<p class="text-sm text-muted-foreground">{t('misc.addFirstRatingHint')}</p>
						<Button variant="outline" onclick={addRating} class="gap-2 border-dashed" {disabled}>
							<Icon icon="lucide:plus" class="h-4 w-4" />
							{t('misc.addFirstRating')}
						</Button>
					</Stack>
				{:else}
					<!-- Ratings list -->
					<Stack gap="sm" class="p-4">
						{#each coercedRatings as rating, index (index)}
							{@const entryState = getEntryState(rating)}
							<Inline gap="md">
								<!-- Visual indicator for entry state -->
								<div class="flex shrink-0">
									{#if entryState === 'valid'}
										<div
											class="h-2 w-2 rounded-full bg-green-500"
											title={t('misc.progressComplete')}
										></div>
									{:else}
										<div
											class="h-2 w-2 rounded-full bg-border"
											title={t('misc.progressEmpty')}
										></div>
									{/if}
								</div>

								<!-- Star Rating Input -->
								<Inline gap="sm" grow>
									<StarRating
										value={rating || undefined}
										onValueChange={(newRating) => updateRating(index, newRating)}
										{disabled}
										class="text-yellow-400"
									>
										{#snippet children({ items })}
											{#each items as item (item.index)}
												<Star
													{...item}
													class="h-5 w-5 cursor-pointer transition-transform hover:scale-105"
												/>
											{/each}
										{/snippet}
									</StarRating>
									{#if rating > 0}
										<span class="text-sm text-muted-foreground">{rating}/5</span>
									{/if}
								</Inline>

								<!-- Remove button -->
								{#if coercedRatings.length > 1}
									<Button
										variant="ghost"
										size="sm"
										onclick={() => removeRating(index)}
										class="h-8 w-8 p-0 text-destructive hover:bg-destructive/10 hover:text-destructive-foreground"
										{disabled}
									>
										<Icon icon="lucide:x" class="h-4 w-4" />
									</Button>
								{/if}
							</Inline>
						{/each}

						<!-- Add button -->
						<Button
							variant="outline"
							onclick={addRating}
							class="w-full gap-2 border-dashed text-muted-foreground hover:text-foreground"
							{disabled}
						>
							<Icon icon="lucide:plus" class="h-4 w-4" />
							{t('dataRenderer.addRating')}
						</Button>
					</Stack>
				{/if}
			</Stack>
		</Popover.Content>
	</Popover.Root>

	<!-- ============================================================================ -->
	<!-- SINGLE EDIT MODE: Simple star picker -->
	<!-- ============================================================================ -->
{:else}
	<Stack gap="sm" class={className} {style}>
		<Inline gap="md">
			<!-- Star Rating Component -->
			<StarRating
				allowHalf={true}
				value={currentSingleValue || undefined}
				onValueChange={handleRatingChange}
				{disabled}
				class="text-yellow-400"
			>
				{#snippet children({ items })}
					{#each items as item (item.index)}
						<Star {...item} class="h-6 w-6 cursor-pointer transition-transform hover:scale-105" />
					{/each}
				{/snippet}
			</StarRating>

			<!-- Rating Display -->
			{#if hasValue}
				<span class="text-sm font-medium text-secondary-foreground">
					{currentSingleValue}/5
				</span>
			{/if}

			<!-- Clear Button -->
			{#if allowClear && hasValue && !disabled}
				<Button
					variant="ghost"
					size="sm"
					onclick={handleClear}
					class="h-6 w-6 p-0 text-muted-foreground hover:text-muted-foreground"
				>
					<Icon icon="lucide:x" class="h-4 w-4" />
				</Button>
			{/if}
		</Inline>
	</Stack>
{/if}
