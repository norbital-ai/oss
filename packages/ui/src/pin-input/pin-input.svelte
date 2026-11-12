<!--
@component
A one-time code in separate cells (bits-ui PinInput): the sign-in code step. Focused on mount: the code step appears only once a code is sent.
-->
<script lang="ts">
	import { Inline } from '../layout/index.js';
	import { cn } from '../primitives/utils.js';
	import {
		PinInput as PinInputPrimitive,
		REGEXP_ONLY_DIGITS,
		type WithoutChildrenOrChild
	} from 'bits-ui';
	import type { SnakeProps } from '../primitives/bits.js';

	type Props = SnakeProps<Omit<WithoutChildrenOrChild<PinInputPrimitive.RootProps>, 'maxlength' | 'onComplete'>, {
		on_value_change: 'onValueChange';
		paste_transformer: 'pasteTransformer';
		push_password_manager_strategy: 'pushPasswordManagerStrategy';
		input_id: 'inputId';
		input_ref: 'inputRef';
	}> & {
		maxlength?: number;
		cell_class?: string;
		on_complete?: (value: string) => void;
	};

	let {
		value = $bindable(''),
		maxlength = 6,
		disabled = false,
		autofocus = true,
		class: className,
		cell_class,
		on_value_change,
		paste_transformer,
		push_password_manager_strategy,
		input_id,
		input_ref = $bindable(null),
		on_complete,
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
	{autofocus}
	pattern={REGEXP_ONLY_DIGITS}
	inputmode="numeric"
	autocomplete="one-time-code"
	aria-invalid={ariaInvalid}
	class={cn('w-full', className)}
	{...restProps}
	onValueChange={on_value_change}
	pasteTransformer={paste_transformer}
	pushPasswordManagerStrategy={push_password_manager_strategy}
	inputId={input_id}
	bind:inputRef={input_ref}
	onComplete={on_complete}
>
	{#snippet children({ cells })}
		<Inline justify="between" class="w-full">
			{#each cells as cell, index (index)}
				<PinInputPrimitive.Cell
					{cell}
					class={cn(
						'h-11 rounded-sm border border-input bg-background text-base font-medium tabular-nums shadow-xs transition-[border-color,box-shadow,background-color] outline-none dark:bg-input/30',
						cell.isActive && 'border-ring ring-[3px] ring-ring/50 ring-inset dark:bg-input/40',
						invalid && 'border-destructive ring-destructive/20 ring-inset dark:ring-destructive/40',
						disabled && 'cursor-not-allowed bg-muted opacity-50 shadow-none',
						cell_class
					)}
				>
					{#snippet child({ props })}
						<Inline gap="none" justify="center" size="fill" {...props}>
							{#if cell.char}
								{cell.char}
							{:else if cell.hasFakeCaret}
								<span class="h-5 w-px bg-foreground" aria-hidden="true"></span>
							{/if}
						</Inline>
					{/snippet}
				</PinInputPrimitive.Cell>
			{/each}
		</Inline>
	{/snippet}
</PinInputPrimitive.Root>
