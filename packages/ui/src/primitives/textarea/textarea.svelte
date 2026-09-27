<!--
@component
A multi-line text input, bindable `value`. `readonly` (or an enclosing readonly form) shows the text, copyable, with no
field chrome; `disabled` keeps the box, muted.
-->
<script lang="ts">
	import CopyText from '../copy-text/copy-text.svelte';
	import { cn, useControls, uiText, type WithElementRef, type WithoutChildren } from '../utils.js';
	import type { HTMLTextareaAttributes } from 'svelte/elements';

	let {
		ref = $bindable(null),
		value = $bindable(),
		class: className,
		'data-slot': dataSlot = 'textarea',
		readonly,
		disabled,
		...restProps
	}: WithoutChildren<WithElementRef<HTMLTextareaAttributes>> = $props();
	const controls = useControls();
	const t = uiText();
	const text = $derived(value === undefined || value === null ? '' : String(value));
</script>

{#if readonly ?? controls.readonly}
	<CopyText id={restProps.id ?? undefined} {text} class={cn(className)}>
		{#if text === ''}<span class="text-muted-foreground">{t('none')}</span>{:else}{text}{/if}
	</CopyText>
{:else}
<textarea
	bind:this={ref}
	data-slot={dataSlot}
	class={cn(
		'block field-sizing-content min-h-16 w-full rounded-sm border border-input bg-background px-3 py-2 text-base shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 aria-invalid:ring-inset md:text-sm dark:bg-input/30 dark:aria-invalid:ring-destructive/40',
		className
	)}
	bind:value
	disabled={disabled ?? controls.disabled}
	{...restProps}></textarea>
{/if}
