<!--
@component
A multi-line text input, bindable `value`. `readonly` (or an enclosing readonly form) shows the text, copyable, with no
field chrome; `disabled` keeps the box, muted.
-->
<script lang="ts">
	import { register_control } from '../../behaviors/index.js';
	import CopyText from '../copy-text/copy-text.svelte';
	import { cn, use_controls, ui_text, type WithElementRef, type WithoutChildren } from '../utils.js';
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
	const controls = use_controls();
	const t = ui_text();
	const text = $derived(value === undefined || value === null ? '' : String(value));
	const isReadonly = $derived(Boolean(readonly ?? controls.readonly));
	const isDisabled = $derived(Boolean(disabled ?? controls.disabled));
	const controlId = $derived(
		restProps.id ?? restProps.name ?? restProps['aria-label'] ?? undefined
	);

	$effect(() => {
		if (isReadonly || isDisabled || controlId === undefined) return;
		const ariaLabel = restProps['aria-label'];
		return register_control({
			id: `textarea:${controlId}`,
			kind: 'textarea',
			...(typeof ariaLabel === 'string' ? { label: ariaLabel } : {}),
			element: () => ref,
			disabled: () => isDisabled || isReadonly,
			state: () => ({ value: text }),
			actions: {
				set: (next) => {
					if (typeof next === 'string') {
						value = next;
						if (ref instanceof HTMLTextAreaElement) {
							ref.value = next;
							ref.dispatchEvent(new Event('input', { bubbles: true }));
							ref.dispatchEvent(new Event('change', { bubbles: true }));
						}
					}
				},
				clear: () => {
					value = '';
					if (ref instanceof HTMLTextAreaElement) {
						ref.value = '';
						ref.dispatchEvent(new Event('input', { bubbles: true }));
						ref.dispatchEvent(new Event('change', { bubbles: true }));
					}
				}
			}
		});
	});
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
			// one control high when empty (the control size), growing with its lines
			'block field-sizing-content min-h-8 w-full rounded-control border border-border-control bg-surface-input px-2.5 py-1.5 text-xs shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-ring-destructive aria-invalid:ring-inset',
			className
		)}
		bind:value
		disabled={disabled ?? controls.disabled}
		{...restProps}></textarea>
{/if}
