<!--
@component
A one-time code in separate digit cells (bits-ui PinInput): the sign-in code step. Digits only, `one-time-code` autofill; focused on mount, since the code step appears only once a code is sent.
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import { Inline } from '../layout/index.js';
	import { cn } from '../primitives/utils.js';
	import {
		PinInput as PinInputPrimitive,
		REGEXP_ONLY_DIGITS,
		type WithoutChildrenOrChild
	} from 'bits-ui';
	import type { SnakeProps } from '../primitives/bits.js';

	type Props = SnakeProps<
		Omit<WithoutChildrenOrChild<PinInputPrimitive.RootProps>, 'maxlength' | 'onComplete'>,
		{
			/** Called with the code on every keystroke or paste. */
			on_value_change: 'onValueChange';
			/** Rewrites pasted text before it fills the cells (strip spaces or dashes). */
			paste_transformer: 'pasteTransformer';
			/** How the hidden input makes room for a password manager's badge (bits-ui `pushPasswordManagerStrategy`). */
			push_password_manager_strategy: 'pushPasswordManagerStrategy';
			/** The `id` of the hidden input, for a `Label for`. */
			input_id: 'inputId';
			/** The hidden input element (bindable). */
			input_ref: 'inputRef';
		}
	> & {
		/** Number of digit cells (default 6). */
		maxlength?: number;
		/** Classes added to every cell. */
		cell_class?: string;
		/** Called with the code once every cell is filled. */
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

<!-- Fixed-size cells. Completion runs in the primitive's effect; caller state must not retrigger it. -->
<PinInputPrimitive.Root
	bind:value
	{maxlength}
	{disabled}
	{autofocus}
	pattern={REGEXP_ONLY_DIGITS}
	inputmode="numeric"
	autocomplete="one-time-code"
	aria-invalid={ariaInvalid}
	class={cn('w-fit', className)}
	{...restProps}
	onValueChange={on_value_change}
	pasteTransformer={paste_transformer}
	pushPasswordManagerStrategy={push_password_manager_strategy}
	inputId={input_id}
	bind:inputRef={input_ref}
	onComplete={(code) => untrack(() => on_complete?.(code))}
>
	{#snippet children({ cells })}
		<Inline gap="sm">
			{#each cells as cell, index (index)}
				<PinInputPrimitive.Cell
					{cell}
					class={cn(
						'size-11 rounded-sm border border-input bg-background text-base font-medium tabular-nums shadow-xs transition-[border-color,box-shadow,background-color] outline-none dark:bg-input/30',
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
