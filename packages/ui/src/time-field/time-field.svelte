<script lang="ts" module>
	import type { Time } from '@internationalized/date';
	import type { TimeValue } from 'bits-ui';
</script>

<script lang="ts" generics="T extends TimeValue = Time">
	import { cn } from '#lib/utils';
	import { TimeField, type WithoutChildrenOrChild } from 'bits-ui';

	let {
		value = $bindable(),
		placeholder = $bindable(),
		label,
		name,
		error,
		required = false,
		disabled = false,
		readonly = false,
		granularity = 'minute',
		locale = 'en-US',
		hourCycle,
		minValue,
		maxValue,
		validate,
		hideTimeZone = false,
		readonlySegments,
		class: className,
		inputClass,
		labelClass,
		segmentClass,
		onValueChange,
		onPlaceholderChange,
		onInvalid,
		...restProps
	}: WithoutChildrenOrChild<TimeField.RootProps<T>> & {
		label?: string;
		name?: string;
		error?: string;
		class?: string;
		inputClass?: string;
		labelClass?: string;
		segmentClass?: string;
	} = $props();

	// Handle validation errors
	function handleInvalid(reason: 'min' | 'max' | 'custom', msg?: string | string[]) {
		if (onInvalid) {
			onInvalid(reason, msg);
		}
	}
</script>

<TimeField.Root
	bind:value
	bind:placeholder
	{required}
	{disabled}
	{readonly}
	{granularity}
	{locale}
	{hourCycle}
	{minValue}
	{maxValue}
	{validate}
	{hideTimeZone}
	{readonlySegments}
	{onValueChange}
	{onPlaceholderChange}
	onInvalid={handleInvalid}
	errorMessageId={error ? `${name}-error` : undefined}
	{...restProps}
>
	<!-- stupidity:allow UI6 -- this leaf component root is the reusable layout boundary being defined -->
	<div class={cn('flex w-full flex-col gap-1.5', className)}>
		{#if label}
			<TimeField.Label
				class={cn(
					'block text-sm font-medium text-secondary-foreground select-none dark:text-muted-foreground',
					required && "after:ml-0.5 after:text-red-500 after:content-['*']",
					disabled && 'cursor-not-allowed opacity-50',
					labelClass
				)}
			>
				{label}
			</TimeField.Label>
		{/if}

		<TimeField.Input
			{name}
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
				error && 'border-red-500 focus-within:border-red-500 focus-within:ring-red-500/20',
				inputClass
			)}
		>
			{#snippet children({ segments })}
				{#each segments as { part, value }, i (i)}
					<div class="inline-block select-none">
						{#if part === 'literal'}
							<TimeField.Segment
								{part}
								class={cn('px-1 text-muted-foreground dark:text-muted-foreground', segmentClass)}
							>
								{value}
							</TimeField.Segment>
						{:else}
							<TimeField.Segment
								{part}
								class={cn(
									// Base styles
									'rounded px-1 py-0.5 tabular-nums transition-colors outline-none',
									// Interactive styles
									'hover:bg-muted focus:bg-brand-100 focus:text-brand-900',
									'dark:hover:bg-muted dark:focus:bg-brand-900/20 dark:focus:text-brand-300',
									// Empty state
									'aria-[valuetext=Empty]:text-muted-foreground dark:aria-[valuetext=Empty]:text-muted-foreground',
									// Invalid state
									'data-invalid:text-destructive dark:data-invalid:text-destructive',
									// Disabled state
									disabled && 'cursor-not-allowed',
									// Custom class
									segmentClass
								)}
							>
								{value}
							</TimeField.Segment>
						{/if}
					</div>
				{/each}
			{/snippet}
		</TimeField.Input>

		{#if error}
			<p id="{name}-error" class="text-sm text-destructive dark:text-destructive" role="alert">
				{error}
			</p>
		{/if}
	</div>
</TimeField.Root>

<style>
	/* Additional focus styles if needed */
	:global(.time-field-segment:focus-visible) {
		outline: none;
	}
</style>
