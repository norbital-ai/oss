<script lang="ts">
	// ============================================================================
	// IMPORTS & DEPENDENCIES
	// ============================================================================
	import * as Popover from '#lib/popover';
	import Progress from './progress.svelte';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { cn } from '#lib/utils';
	import Icon from '@iconify/svelte';
	import { onDestroy, onMount } from 'svelte';
	import Button, { buttonVariants } from '../button/button.svelte';
	import { Inline, Stack } from '#lib/layout';

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

	let activeDragCleanup: (() => void) | null = null;

	// Internal editing state - keeps ALL progress values
	let editingProgress = $state<number[]>([]);

	// Initialize internal state once on mount
	onMount(() => {
		if (!value) {
			editingProgress = multiple ? [] : [0];
		} else if (Array.isArray(value)) {
			editingProgress = [...value];
		} else {
			editingProgress = [value];
		}
	});

	onDestroy(() => {
		activeDragCleanup?.();
	});

	// Helper to check if a progress value is meaningful (> 0)
	const isValidProgress = (progress: number): boolean => {
		return progress > 0;
	};

	// Get only meaningful progress values for parent component
	const validProgress = $derived.by(() => editingProgress.filter(isValidProgress));

	const hasValidProgress = $derived(validProgress.length > 0);

	// For single mode - always returns number | null
	const currentSingleValue = $derived.by((): number | null => {
		if (multiple) return validProgress[0] || null;
		if (Array.isArray(value)) return value[0] || null;
		return value || null;
	});

	// ============================================================================
	// DISPLAY HELPERS
	// ============================================================================
	const triggerText = $derived.by((): string => {
		if (!hasValidProgress) {
			return multiple ? t('misc.noProgressSelected') : t('misc.selectProgress');
		}

		if (multiple) {
			const progressText = validProgress.map((p) => `${p}%`).join(', ');
			return progressText;
		} else {
			return `${validProgress[0]}%`;
		}
	});

	const hasValue = $derived.by((): boolean => {
		if (multiple) {
			return validProgress.length > 0;
		} else {
			return currentSingleValue !== null;
		}
	});

	// ============================================================================
	// SLIDER/DRAG FUNCTIONALITY
	// ============================================================================
	const handleProgressClick = (event: MouseEvent, index: number = 0) => {
		if (!onValueChange || readonly || disabled) return;

		const target = event.currentTarget as HTMLElement;
		const rect = target.getBoundingClientRect();
		const percentage = Math.round(((event.clientX - rect.left) / rect.width) * 100);
		const clampedPercentage = Math.max(0, Math.min(100, percentage));

		updateProgress(index, clampedPercentage);
	};

	const handleProgressDrag = (event: MouseEvent, index: number = 0) => {
		if (!onValueChange || readonly || disabled) return;

		// FIXED: Capture the target element before setting up event listeners
		const target = event.currentTarget as HTMLElement;

		const handleMouseMove = (e: MouseEvent) => {
			const rect = target.getBoundingClientRect();
			const percentage = Math.round(((e.clientX - rect.left) / rect.width) * 100);
			const clampedPercentage = Math.max(0, Math.min(100, percentage));

			updateProgress(index, clampedPercentage);
		};

		const handleMouseUp = () => {
			document.removeEventListener('mousemove', handleMouseMove);
			document.removeEventListener('mouseup', handleMouseUp);
			activeDragCleanup = null;
		};

		document.addEventListener('mousemove', handleMouseMove);
		document.addEventListener('mouseup', handleMouseUp);
		activeDragCleanup = () => {
			document.removeEventListener('mousemove', handleMouseMove);
			document.removeEventListener('mouseup', handleMouseUp);
		};
	};

	const handleKeyDown = (event: KeyboardEvent, index: number = 0) => {
		if (!onValueChange || readonly || disabled) return;

		const currentValue = editingProgress[index] || 0;
		let newValue = currentValue;

		switch (event.key) {
			case 'ArrowRight':
			case 'ArrowUp':
				newValue = Math.min(100, currentValue + 5);
				event.preventDefault();
				break;
			case 'ArrowLeft':
			case 'ArrowDown':
				newValue = Math.max(0, currentValue - 5);
				event.preventDefault();
				break;
			case 'PageUp':
				newValue = Math.min(100, currentValue + 10);
				event.preventDefault();
				break;
			case 'PageDown':
				newValue = Math.max(0, currentValue - 10);
				event.preventDefault();
				break;
			case 'Home':
				newValue = 0;
				event.preventDefault();
				break;
			case 'End':
				newValue = 100;
				event.preventDefault();
				break;
			default:
				return;
		}

		updateProgress(index, newValue);
	};

	// ============================================================================
	// EVENT HANDLERS
	// ============================================================================
	const notifyParent = () => {
		if (readonly || !onValueChange) return;

		// Only send meaningful progress values to parent
		const meaningfulProgress = editingProgress.filter(isValidProgress);

		if (!multiple) {
			// Single mode: pass the first meaningful value or null
			const result = meaningfulProgress[0] || null;
			onValueChange(result);
		} else {
			// Multiple mode: pass array of meaningful values
			onValueChange(meaningfulProgress);
		}
	};

	const updateProgress = (index: number, progress: number) => {
		if (readonly || disabled) return;

		// Update internal state
		editingProgress[index] = progress;

		// Notify parent with valid progress values
		notifyParent();
	};

	const addProgress = () => {
		if (readonly || disabled) return;
		editingProgress = [...editingProgress, 0];
		// Don't notify parent until user sets a meaningful value
	};

	const removeProgress = (index: number) => {
		if (readonly || disabled) return;

		// For single mode, reset to 0 instead of removing
		if (!multiple && editingProgress.length <= 1) {
			editingProgress = [0];
		} else {
			editingProgress = editingProgress.filter((_, i) => i !== index);
		}
		notifyParent();
	};

	const handleClear = () => {
		if (!onValueChange || readonly || disabled) return;

		if (multiple) {
			editingProgress = [];
		} else {
			editingProgress = [0];
		}
		notifyParent();
	};

	// Get visual state for a progress entry
	const getEntryState = (progress: number) => {
		if (isValidProgress(progress)) return 'valid';
		return 'empty';
	};
</script>

<!-- ============================================================================ -->
<!-- READONLY MODE -->
<!-- ============================================================================ -->
{#if readonly}
	<Popover.Root bind:open={isOpen}>
		<Popover.Trigger class={cn('w-full', className)} {style}>
			{#if multiple && validProgress.length > 1}
				<!-- Multiple progress bars stacked -->
				<Stack
					gap="sm"
					class="rounded-md border border-input bg-background p-2 shadow-xs transition-colors hover:bg-accent"
				>
					{#each validProgress as progress, index (index)}
						<Inline gap="sm">
							<span class="w-8 text-meta">#{index + 1}</span>
							<Progress value={progress} class="h-2 flex-1" />
							<span class="w-10 text-xs">{progress}%</span>
						</Inline>
					{/each}
				</Stack>
			{:else}
				<!-- Single progress bar -->
				<Inline gap="sm">
					<Progress
						value={currentSingleValue || 0}
						class={cn('h-3 flex-1 cursor-pointer', !hasValue && 'opacity-50')}
					/>
					<span class="w-12 text-xs text-secondary-foreground">
						{hasValue ? `${currentSingleValue}%` : '0%'}
					</span>
				</Inline>
			{/if}
		</Popover.Trigger>

		<Popover.Content class="w-80 p-4" align="start">
			<Stack gap="sm">
				<Inline gap="sm">
					<Icon icon="lucide:trending-up" class="h-5 w-5 text-brand" />
					<h4 class="font-semibold text-foreground">{t('misc.progressDetails')}</h4>
				</Inline>

				{#if hasValidProgress}
					<Stack gap="sm">
						{#each validProgress as progress, index (index)}
							<Inline justify="between" gap="sm" class="rounded-md bg-muted/40 p-3">
								<span class="text-sm font-medium">
									{multiple
										? t('misc.progressIndex', { index: index + 1 })
										: t('misc.currentProgress')}
								</span>
								<Inline gap="sm">
									<Progress value={progress} class="h-2 w-20" />
									<span class="text-sm font-semibold">{progress}%</span>
								</Inline>
							</Inline>
						{/each}
					</Stack>
				{:else}
					<div class="py-4 text-center">
						<Icon icon="lucide:trending-up" class="mx-auto mb-2 h-8 w-8 text-muted-foreground" />
						<p class="text-sm text-muted-foreground">{t('misc.noProgressAssigned')}</p>
					</div>
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
				icon="lucide:trending-up"
				class={cn('h-4 w-4', hasValidProgress ? 'text-brand' : 'text-muted-foreground')}
			/>
			<span
				class={cn(
					'truncate text-xs',
					hasValidProgress ? 'text-foreground' : 'text-muted-foreground'
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
				{#if editingProgress.length === 0}
					<!-- Empty state -->
					<Stack gap="sm" class="p-4 py-8 text-center">
						<Icon icon="lucide:trending-up" class="mx-auto h-12 w-12 text-muted-foreground" />
						<h4 class="font-medium text-foreground">{t('misc.noProgressConfigured')}</h4>
						<p class="text-sm text-muted-foreground">
							{t('misc.addFirstProgressHint')}
						</p>
						<Button variant="outline" onclick={addProgress} class="border-dashed" {disabled}>
							<Icon icon="lucide:plus" class="mr-2 h-4 w-4" />
							{t('misc.addFirstProgress')}
						</Button>
					</Stack>
				{:else}
					<!-- Progress list -->
					<Stack gap="sm" class="p-4">
						{#each editingProgress as progress, index (index)}
							{@const entryState = getEntryState(progress)}
							<Inline gap="md">
								<!-- Visual indicator for entry state -->
								<div class="flex shrink-0">
									{#if entryState === 'valid'}
										<div
											class="h-2 w-2 rounded-full bg-success"
											title={t('misc.progressComplete')}
										></div>
									{:else}
										<div
											class="h-2 w-2 rounded-full bg-border"
											title={t('misc.progressEmpty')}
										></div>
									{/if}
								</div>

								<!-- Progress Input -->
								<Inline gap="sm" grow>
									<span class="w-8 text-sm text-muted-foreground">#{index + 1}</span>

									<!-- Draggable Progress Bar -->
									<div
										class="flex-1 cursor-pointer select-none"
										onclick={(e) => handleProgressClick(e, index)}
										onmousedown={(e) => handleProgressDrag(e, index)}
										onkeydown={(e) => handleKeyDown(e, index)}
										role="slider"
										tabindex="0"
										aria-label={t('misc.progressAria', { index: index + 1 })}
										aria-valuenow={progress}
										aria-valuemin="0"
										aria-valuemax="100"
									>
										<Progress
											value={progress}
											class={cn(
												'h-4 transition-all hover:h-5',
												disabled ? 'cursor-not-allowed opacity-50' : 'hover:shadow-sm'
											)}
										/>
									</div>

									<span class="w-12 text-sm font-medium text-secondary-foreground">{progress}%</span
									>
								</Inline>

								<!-- Remove button -->
								{#if editingProgress.length > 1}
									<Button
										variant="ghost"
										size="sm"
										onclick={() => removeProgress(index)}
										class="h-8 w-8 p-0 text-red-500 hover:bg-red-50 hover:text-red-700"
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
							onclick={addProgress}
							class="w-full border-dashed text-muted-foreground hover:text-foreground"
							{disabled}
						>
							<Icon icon="lucide:plus" class="mr-2 h-4 w-4" />
							{t('misc.addProgress')}
						</Button>
					</Stack>
				{/if}
			</Stack>
		</Popover.Content>
	</Popover.Root>

	<!-- ============================================================================ -->
	<!-- SINGLE EDIT MODE: Simple progress picker -->
	<!-- ============================================================================ -->
{:else}
	<Stack gap="sm" class={className} {style}>
		<!-- Single draggable progress bar -->
		<Inline gap="md">
			<!-- Draggable Progress Bar -->
			<div
				class="flex-1 cursor-pointer select-none"
				onclick={(e) => handleProgressClick(e)}
				onmousedown={(e) => handleProgressDrag(e)}
				onkeydown={(e) => handleKeyDown(e)}
				role="slider"
				tabindex="0"
				aria-label={t('misc.progress')}
				aria-valuenow={currentSingleValue || 0}
				aria-valuemin="0"
				aria-valuemax="100"
			>
				<Progress
					value={currentSingleValue || 0}
					class={cn(
						'h-4 transition-all hover:h-5',
						disabled ? 'cursor-not-allowed opacity-50' : 'hover:shadow-sm'
					)}
				/>
			</div>

			<span class="w-12 text-sm font-medium text-secondary-foreground">
				{currentSingleValue || 0}%
			</span>

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
