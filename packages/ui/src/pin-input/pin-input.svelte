<!-- exported package component rendered by the core OTP challenge -->
<script lang="ts">
	import { cn } from '#lib/utils';
	import {
		PinInput as PinInputPrimitive,
		REGEXP_ONLY_DIGITS,
		type WithoutChildrenOrChild
	} from 'bits-ui';

	type Props = Omit<WithoutChildrenOrChild<PinInputPrimitive.RootProps>, 'maxlength'> & {
		maxlength?: number;
		cellClass?: string;
	};

	let {
		value = $bindable(''),
		maxlength = 6,
		disabled = false,
		class: className,
		cellClass,
		'aria-invalid': ariaInvalid,
		...restProps
	}: Props = $props();

	const invalid = $derived(ariaInvalid === true || ariaInvalid === 'true');
</script>

<!--
	Cells share the row rather than sitting at a fixed width. `flex-1` over a `min-w-0` basis lets
	six of them span exactly the container, so the group lines up with the full-width button beneath
	it instead of stopping short of it — `w-10` with `justify-start` was a fixed width the container
	could never fill, whatever it was given.
-->
<PinInputPrimitive.Root
	bind:value
	{maxlength}
	{disabled}
	pattern={REGEXP_ONLY_DIGITS}
	inputmode="numeric"
	autocomplete="one-time-code"
	aria-invalid={ariaInvalid}
	class={cn('flex w-full items-center justify-between gap-2', className)}
	{...restProps}
>
	{#snippet children({ cells })}
		{#each cells as cell, index (index)}
			<PinInputPrimitive.Cell
				{cell}
				class={cn(
					'flex h-11 min-w-0 flex-1 items-center justify-center rounded-sm border border-input bg-background text-base font-medium tabular-nums shadow-xs transition-[border-color,box-shadow,background-color] outline-none dark:bg-input/30',
					cell.isActive && 'border-ring ring-[3px] ring-ring/50 ring-inset dark:bg-input/40',
					invalid && 'border-destructive ring-destructive/20 ring-inset dark:ring-destructive/40',
					disabled && 'cursor-not-allowed bg-muted opacity-50 shadow-none',
					cellClass
				)}
			>
				{#if cell.char}
					{cell.char}
				{:else if cell.hasFakeCaret}
					<span class="h-5 w-px bg-foreground" aria-hidden="true"></span>
				{/if}
			</PinInputPrimitive.Cell>
		{/each}
	{/snippet}
</PinInputPrimitive.Root>
