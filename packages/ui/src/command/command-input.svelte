<script lang="ts">
	import Icon from '@iconify/svelte';
	import { cn } from '#lib/utils';
	import { getCommandState } from './command-state.svelte.js';
	import type { CommandInputProps } from '#lib/command/types';

	let {
		ref = $bindable(null),
		value = $bindable(''),
		placeholder,
		disabled,
		prefix,
		suffix,
		outerClass,
		class: className,
		oninput,
		onfocus,
		onblur,
		...restProps
	}: CommandInputProps = $props();
	type InputEvent = Parameters<NonNullable<CommandInputProps['oninput']>>[0];
	type FocusEvent = Parameters<NonNullable<CommandInputProps['onfocus']>>[0];
	type BlurEvent = Parameters<NonNullable<CommandInputProps['onblur']>>[0];

	// Get state from context (getter pattern)
	const commandState = getCommandState()();

	// Handle input changes
	function handleInput(event: InputEvent) {
		const target = event.currentTarget;
		commandState.setInputFocused(true);
		commandState.inputMode = 'keyboard';
		commandState.setFilter(target.value);
		value = target.value;
		oninput?.(event);
	}

	function handleFocus(event: FocusEvent) {
		commandState.setInputFocused(true);
		commandState.inputMode = 'keyboard';
		onfocus?.(event);
	}

	function handleBlur(event: BlurEvent) {
		commandState.setInputFocused(false);
		onblur?.(event);
	}
</script>

<!-- stupidity:allow UI6 -- this leaf component root is the reusable layout boundary being defined -->
<div
	class={cn('flex items-center gap-2 border-b px-2', outerClass)}
	data-command-input-wrapper="true"
>
	{#if prefix}
		{@render prefix()}
	{:else}
		<Icon icon="ic:baseline-search" class="flex-none text-muted-foreground" />
	{/if}
	<input
		bind:this={ref}
		type="text"
		{value}
		{placeholder}
		{disabled}
		data-command-input="true"
		class={cn(
			'flex h-9 w-full rounded-md bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50',
			className
		)}
		oninput={handleInput}
		onfocus={handleFocus}
		onblur={handleBlur}
		{...restProps}
	/>
	{#if suffix}
		{@render suffix()}
	{/if}
</div>
