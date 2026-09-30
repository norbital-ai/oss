<!--
@component
A text input (every `<input>` type), bindable `value`. `type="file"` binds `files` (or `onFiles`) instead: a file
input's value is not writable. `readonly` (or an enclosing readonly form) shows the value as
copyable text, no field chrome; `disabled` (or an enclosing disabled form) keeps the box, muted.
-->
<script lang="ts">
	import CopyText from '../copy-text/copy-text.svelte';
	import { cn, useControls, uiText, type WithElementRef } from '../utils.js';
	import type { HTMLInputAttributes, HTMLInputTypeAttribute } from 'svelte/elements';

	type InputType = Exclude<HTMLInputTypeAttribute, 'file'>;

	type Props = WithElementRef<
		Omit<HTMLInputAttributes, 'type'> &
			({ type: 'file'; files?: FileList; onFiles?: (files: FileList | null) => void } | { type?: InputType; files?: undefined; onFiles?: undefined })
	>;

	let {
		ref = $bindable(null),
		value = $bindable(),
		type,
		files = $bindable(),
		onFiles,
		class: className,
		'data-slot': dataSlot = 'input',
		readonly,
		disabled,
		...restProps
	}: Props = $props();
	const controls = useControls();
	const t = uiText();
	// a secret or a non-text control never turns into visible text
	const asText = $derived((readonly ?? controls.readonly) && !['file', 'password', 'hidden', 'checkbox', 'radio', 'range', 'color'].includes(type ?? 'text'));
	const off = $derived(disabled ?? controls.disabled);

	// Special classes to hide spinners on number inputs for a cleaner look
	const numberInputClasses =
		'[&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none [-moz-appearance:textfield]';
</script>

{#if asText}
	<CopyText id={restProps.id ?? undefined} text={value === undefined || value === null || value === '' ? '' : String(value)} class={cn('tabular-nums', className)}>
		{#if value === undefined || value === null || value === ''}<span class="text-muted-foreground">{t('none')}</span>{:else}{String(value)}{/if}
	</CopyText>
{:else if type === 'file'}
	<input
		bind:this={ref}
		data-slot={dataSlot}
		class={cn(
			'block h-9 w-full min-w-0 rounded-sm border border-input bg-background px-3 pt-1.5 text-base font-medium shadow-xs md:text-sm transition-[color,box-shadow] outline-none selection:bg-primary selection:text-primary-foreground placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30',
			'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset',
			'aria-invalid:border-destructive aria-invalid:ring-destructive/20 aria-invalid:ring-inset dark:aria-invalid:ring-destructive/40',
			'disabled:bg-muted disabled:shadow-none',
			className
		)}
		type="file"
		bind:files
		{readonly}
		disabled={off}
		{...restProps}
		onchange={(e) => (onFiles?.(e.currentTarget.files), restProps.onchange?.(e))}
	/>
{:else}
	<input
		bind:this={ref}
		data-slot={dataSlot}
		class={cn(
			'block h-9 w-full min-w-0 rounded-sm border border-input bg-background px-3 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none selection:bg-primary selection:text-primary-foreground placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 md:text-sm dark:bg-input/30',
			'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset',
			'aria-invalid:border-destructive aria-invalid:ring-destructive/20 aria-invalid:ring-inset dark:aria-invalid:ring-destructive/40',
			'disabled:bg-muted disabled:shadow-none',
			type === 'number' && numberInputClasses,
			className
		)}
		{type}
		bind:value
		{readonly}
		disabled={off}
		{...restProps}
	/>
{/if}
