<script lang="ts" module>
	import type { Time } from '@internationalized/date';
	import type { TimeValue } from 'bits-ui';

	export type TimeRange<T extends TimeValue = Time> = {
		start: T | undefined;
		end: T | undefined;
	};
</script>

<script lang="ts" generics="T extends TimeValue = Time">
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { cn } from '#lib/utils';
	import { TimeRangeField } from 'bits-ui';
	import { watch } from 'runed';
	import { compareTimeValues } from '#lib/time-range/compare';

	const { t } = useI18n<UiKeys>();

	let {
		value = $bindable(),
		placeholder = $bindable(),
		label,
		startName,
		endName,
		error,
		required = false,
		disabled = false,
		readonly = false,
		granularity = 'minute',
		locale,
		hourCycle,
		minValue,
		maxValue,
		validate,
		hideTimeZone = false,
		readonlySegments,
		separatorText = t('misc.timeRangeSeparator'),
		autoAdjustConflicts = false,
		allowStartAfterEnd = false,
		startAfterEndError = t('misc.timeRangeStartAfterEnd'),
		class: className,
		inputClass,
		labelClass,
		segmentClass,
		separatorClass,
		onValueChange,
		onPlaceholderChange,
		onStartValueChange,
		onEndValueChange,
		onInvalid,
		...restProps
	}: {
		value?: TimeRange<T>;
		placeholder?: T;
		label?: string;
		startName?: string;
		endName?: string;
		error?: string;
		required?: boolean;
		disabled?: boolean;
		readonly?: boolean;
		granularity?: 'hour' | 'minute' | 'second';
		locale?: string;
		hourCycle?: 12 | 24;
		minValue?: T;
		maxValue?: T;
		validate?: (range: TimeRange<T>) => string | string[] | void;
		hideTimeZone?: boolean;
		readonlySegments?: Array<'hour' | 'minute' | 'second' | 'dayPeriod'>;
		separatorText?: string;
		autoAdjustConflicts?: boolean;
		allowStartAfterEnd?: boolean;
		startAfterEndError?: string;
		class?: string;
		inputClass?: string;
		labelClass?: string;
		segmentClass?: string;
		separatorClass?: string;
		onValueChange?: (value: TimeRange<T> | undefined) => void;
		onPlaceholderChange?: (placeholder: T | undefined) => void;
		onStartValueChange?: (value: T | undefined) => void;
		onEndValueChange?: (value: T | undefined) => void;
		onInvalid?: (reason: 'min' | 'max' | 'custom', msg?: string | string[]) => void;
	} & Record<string, unknown> = $props();

	const localeEffective = $derived(locale ?? useI18n<UiKeys>().intlLocale);

	// Internal state
	let isAdjusting = $state(false);
	let lastInvalidErrorKey = $state('');

	// Handle validation errors
	function handleInvalid(reason: 'min' | 'max' | 'custom', msg?: string | string[]) {
		if (onInvalid) {
			onInvalid(reason, msg);
		}
	}

	// Handle start value changes with potential auto-adjustment
	function handleStartValueChange(startValue: T | undefined) {
		if (isAdjusting) return;

		// Auto-adjust end if needed
		if (autoAdjustConflicts && startValue && value?.end) {
			const comparison = compareTimeValues(startValue, value.end);
			if (comparison > 0) {
				isAdjusting = true;
				value = { start: startValue, end: startValue };
				isAdjusting = false;

				// Call both callbacks
				if (onStartValueChange) onStartValueChange(startValue);
				if (onEndValueChange) onEndValueChange(startValue);
				return;
			}
		}

		if (onStartValueChange) {
			onStartValueChange(startValue);
		}
	}

	// Handle end value changes with potential auto-adjustment
	function handleEndValueChange(endValue: T | undefined) {
		if (isAdjusting) return;

		// Auto-adjust start if needed
		if (autoAdjustConflicts && endValue && value?.start) {
			const comparison = compareTimeValues(value.start, endValue);
			if (comparison > 0) {
				isAdjusting = true;
				value = { start: endValue, end: endValue };
				isAdjusting = false;

				// Call both callbacks
				if (onStartValueChange) onStartValueChange(endValue);
				if (onEndValueChange) onEndValueChange(endValue);
				return;
			}
		}

		if (onEndValueChange) {
			onEndValueChange(endValue);
		}
	}

	const validationResult = $derived.by(() => {
		if (!value) {
			return {
				errors: [] as string[],
				hasStartAfterEndError: false,
				hasCustomValidationError: false
			};
		}

		const errors: string[] = [];
		let startAfterEnd = false;
		let customError = false;

		// Run user-provided validation first
		if (validate) {
			const userValidation = validate(value);
			if (userValidation) {
				customError = true;
				if (Array.isArray(userValidation)) {
					errors.push(...userValidation);
				} else {
					errors.push(userValidation);
				}
			}
		}

		// Check start vs end constraint (unless explicitly allowed)
		if (!allowStartAfterEnd && value.start && value.end) {
			const comparison = compareTimeValues(value.start, value.end);
			if (comparison > 0) {
				startAfterEnd = true;
				errors.push(startAfterEndError);
			}
		}

		return {
			errors,
			hasStartAfterEndError: startAfterEnd,
			hasCustomValidationError: customError
		};
	});
	const internalError = $derived(validationResult.errors.join(', '));
	const hasStartAfterEndError = $derived(validationResult.hasStartAfterEndError);
	const hasCustomValidationError = $derived(validationResult.hasCustomValidationError);

	watch(
		() => validationResult.errors.join('\u0000'),
		(errorKey) => {
			if (!errorKey) {
				lastInvalidErrorKey = '';
				return;
			}
			if (errorKey === lastInvalidErrorKey) return;
			lastInvalidErrorKey = errorKey;
			handleInvalid('custom', validationResult.errors);
		}
	);

	// Combined error display using $derived
	const displayError = $derived(error || internalError);

	// Determine which segments should be highlighted
	const shouldHighlightStart = $derived(hasStartAfterEndError || hasCustomValidationError);
</script>

<TimeRangeField.Root
	bind:value
	bind:placeholder
	{required}
	{disabled}
	{readonly}
	{granularity}
	locale={localeEffective}
	{hourCycle}
	{minValue}
	{maxValue}
	{hideTimeZone}
	onInvalid={(reason, msg) => handleInvalid(reason, msg)}
	{readonlySegments}
	{onValueChange}
	onPlaceholderChange={(value) => onPlaceholderChange?.(value as T | undefined)}
	onStartValueChange={handleStartValueChange}
	onEndValueChange={handleEndValueChange}
	errorMessageId={displayError ? `${startName || endName}-error` : undefined}
	class={cn('group flex w-full flex-col gap-1.5', className)}
	{...restProps}
>
	{#if label}
		<TimeRangeField.Label
			class={cn(
				'block text-sm font-medium text-secondary-foreground select-none dark:text-muted-foreground',
				required && "after:ml-0.5 after:text-red-500 after:content-['*']",
				disabled && 'cursor-not-allowed opacity-50',
				labelClass
			)}
		>
			{label}
		</TimeRangeField.Label>
	{/if}

	<div
		class={cn(
			// Base styles
			'flex w-full items-center rounded-sm border border-input bg-background px-3 py-2 text-sm tracking-[0.01em] transition-colors select-none',
			// Focus styles
			'focus-within:border-brand focus-within:ring-2 focus-within:ring-brand/20',
			// Hover styles
			'hover:border-input',
			// Dark mode
			'dark:border-input dark:bg-input/30 dark:text-foreground dark:focus-within:border-brand-400',
			// States
			disabled && 'cursor-not-allowed bg-muted opacity-50 dark:bg-muted',
			readonly && 'bg-muted dark:bg-muted',
			displayError && 'border-red-500 focus-within:border-red-500 focus-within:ring-red-500/20',
			inputClass
		)}
	>
		{#each ['start', 'end'] as const as type (type)}
			<TimeRangeField.Input {type} name={type === 'start' ? startName : endName}>
				{#snippet children({ segments })}
					{#each segments as { part, value }, i (i)}
						<div class="inline-block select-none">
							{#if part === 'literal'}
								<TimeRangeField.Segment
									{part}
									class={cn('px-1 text-muted-foreground dark:text-muted-foreground', segmentClass)}
								>
									{value}
								</TimeRangeField.Segment>
							{:else}
								{@const isErrorSegment =
									(type === 'start' && shouldHighlightStart) ||
									(type === 'end' && hasCustomValidationError)}
								<TimeRangeField.Segment
									{part}
									class={cn(
										// Base styles
										'rounded px-1 py-0.5 tabular-nums transition-colors outline-none',
										// Interactive styles (conditional based on error state)
										!isErrorSegment && 'hover:bg-muted focus:bg-brand-100 focus:text-brand-900',
										!isErrorSegment &&
											'dark:hover:bg-muted dark:focus:bg-brand-900/20 dark:focus:text-brand-300',
										// Error state highlighting
										isErrorSegment &&
											'border border-red-200 bg-destructive/10 text-destructive-foreground hover:bg-destructive/10 focus:bg-destructive/10 focus:text-destructive-foreground',
										isErrorSegment &&
											'dark:border-destructive dark:bg-destructive/30 dark:text-destructive dark:hover:bg-destructive/50 dark:focus:bg-destructive/50',
										// Empty state
										'aria-[valuetext=Empty]:text-muted-foreground dark:aria-[valuetext=Empty]:text-muted-foreground',
										// Invalid state (keep existing invalid styling)
										'data-invalid:text-destructive dark:data-invalid:text-destructive',
										// Disabled state
										disabled && 'cursor-not-allowed',
										// Custom class
										segmentClass
									)}
								>
									{value}
								</TimeRangeField.Segment>
							{/if}
						</div>
					{/each}
				{/snippet}
			</TimeRangeField.Input>

			{#if type === 'start'}
				<div
					aria-hidden="true"
					class={cn(
						'px-2 text-muted-foreground select-none dark:text-muted-foreground',
						separatorClass
					)}
				>
					{separatorText}
				</div>
			{/if}
		{/each}
	</div>

	{#if displayError}
		<p
			id="{startName || endName}-error"
			class="text-sm text-destructive dark:text-destructive"
			role="alert"
		>
			{displayError}
		</p>
	{/if}
</TimeRangeField.Root>

<style>
	/* Additional focus styles if needed */
	:global(.time-range-field-segment:focus-visible) {
		outline: none;
	}
</style>
