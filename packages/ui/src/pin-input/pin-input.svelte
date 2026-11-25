<!--
@component
A one-time code in separate digit cells: the sign-in code step. Digits only, `one-time-code` autofill; focused on mount, since the code step appears only once a code is sent.
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import type { HTMLAttributes } from 'svelte/elements';
	import { create_pin_input } from '../behaviors/index.js';
	import { Inline } from '../layout/index.js';
	import { cn } from '../primitives/utils.js';

	type Props = Omit<HTMLAttributes<HTMLDivElement>, 'children'> & {
		/** Current code string; bindable. */
		value?: string;
		/** Number of digit cells (default 6). */
		maxlength?: number;
		/** Disables editing. */
		disabled?: boolean;
		/** Focuses the code input on mount (default `true`). */
		autofocus?: boolean;
		/** Classes added to every cell. */
		cell_class?: string;
		/** Called with the code on every keystroke or paste. */
		on_value_change?: (value: string) => void;
		/** Rewrites pasted text before it fills the cells (strip spaces or dashes). */
		paste_transformer?: (text: string) => string;
		/** The `id` of the hidden input, for a `Label for`. */
		input_id?: string;
		/** Optional HTML form `name` passed directly to the underlying `<input>`. */
		name?: string;
		/** The hidden input element (bindable). */
		input_ref?: HTMLInputElement | null;
		/** Called with the code once every cell is filled. */
		on_complete?: (value: string) => void;
		/** Marks the cells invalid. */
		'aria-invalid'?: boolean | 'true' | 'false';
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
		input_id,
		name,
		input_ref = $bindable(null),
		on_complete,
		'aria-invalid': ariaInvalid,
		...restProps
	}: Props = $props();

	const invalid = $derived(ariaInvalid === true || ariaInvalid === 'true');
	const uid = $props.id();
	const pin = create_pin_input({
		length: () => maxlength,
		value: () => value,
		disabled: () => disabled,
		pattern: /^\d$/,
		on_value_change: (next) => {
			value = next;
			on_value_change?.(next);
		},
		on_complete: (code) => untrack(() => on_complete?.(code)),
		control: {
			id: `pin-input:${untrack(() => input_id ?? name ?? uid)}`,
			secret: true,
			element: () => input_ref
		}
	});

	$effect(() => {
		if (autofocus && !disabled && input_ref !== null) {
			input_ref.focus({ preventScroll: true });
		}
	});
</script>

<div class={cn('relative w-fit', className)} data-pin-input {...restProps}>
	<input
		bind:this={input_ref}
		id={input_id}
		{name}
		type="text"
		inputmode="numeric"
		autocomplete="one-time-code"
		aria-invalid={ariaInvalid}
		{...pin.input_attrs()}
		onpaste={(e) => {
			if (paste_transformer === undefined) return;
			const text = e.clipboardData?.getData('text');
			if (text === undefined) return;
			e.preventDefault();
			pin.set_value(paste_transformer(text));
		}}
		class="absolute inset-0 h-full w-full cursor-text opacity-0 disabled:cursor-not-allowed"
	/>
	<Inline gap="sm" class="pointer-events-none">
		{#each pin.cells as cell (cell.index)}
			<div
				data-pin-cell={cell.index}
				data-active={cell.is_active ? '' : undefined}
				class={cn(
					'flex size-11 items-center justify-center rounded-control border border-border-control bg-surface-input text-base font-medium tabular-nums shadow-xs transition-[border-color,box-shadow,background-color] outline-none',
					cell.is_active && 'border-ring ring-[3px] ring-ring/50 ring-inset',
					invalid && 'border-destructive ring-ring-destructive ring-inset',
					disabled && 'cursor-not-allowed bg-muted opacity-50 shadow-none',
					cell_class
				)}
			>
				{#if cell.char}
					{cell.char}
				{:else if cell.has_fake_caret}
					<span class="h-5 w-px bg-foreground" aria-hidden="true"></span>
				{/if}
			</div>
		{/each}
	</Inline>
</div>
