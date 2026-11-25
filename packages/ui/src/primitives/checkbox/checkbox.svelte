<!--
@component
A checkbox, bindable `checked` (and `indeterminate`). `readonly` (or an enclosing readonly form) shows Yes/No as text;
`disabled` keeps the box, muted.
-->
<script lang="ts">
	import type { HTMLButtonAttributes } from 'svelte/elements';
	import { register_control } from '../../behaviors/index.js';
	import { Inline } from '../../layout/index.js';
	import CopyText from '../copy-text/copy-text.svelte';
	import { cn, use_controls, ui_text, type WithElementRef, type WithoutChildrenOrChild } from '../utils.js';
	import Icon from '@iconify/svelte';

	let {
		ref = $bindable(null),
		checked = $bindable(false),
		indeterminate = $bindable(false),
		class: className,
		readonly,
		disabled,
		name,
		value = 'on',
		required,
		on_checked_change,
		on_indeterminate_change,
		onclick,
		onkeydown,
		...restProps
	}: Omit<WithoutChildrenOrChild<WithElementRef<HTMLButtonAttributes, HTMLButtonElement>>, 'type' | 'name' | 'value'> & {
		/** Whether the checkbox is checked; bindable. */
		checked?: boolean;
		/** Mixed / indeterminate state; bindable. */
		indeterminate?: boolean;
		/** Shows Yes/No as copyable text. */
		readonly?: boolean;
		/** The form field name it submits under. */
		name?: string;
		/** Submitted form value when checked (default `'on'`). */
		value?: string;
		/** Whether the checkbox is required. */
		required?: boolean;
		/** Called with the next `checked` state when the person toggles it. */
		on_checked_change?: (checked: boolean) => void;
		/** Called with the next `indeterminate` state when it changes. */
		on_indeterminate_change?: (indeterminate: boolean) => void;
	} = $props();

	const controls = use_controls();
	const t = ui_text();
	const isDisabled = $derived(Boolean(disabled ?? controls.disabled));
	const isReadonly = $derived(Boolean(readonly ?? controls.readonly));
	const dataState = $derived(indeterminate ? 'indeterminate' : checked ? 'checked' : 'unchecked');
	const controlId = $derived(
		restProps.id ?? name ?? restProps['aria-label'] ?? undefined
	);

	function setChecked(next: boolean): void {
		if (isDisabled || isReadonly || next === checked) return;
		if (indeterminate) {
			indeterminate = false;
			on_indeterminate_change?.(false);
		}
		checked = next;
		on_checked_change?.(next);
	}

	function toggle(): void {
		if (isDisabled) return;
		if (indeterminate) {
			indeterminate = false;
			on_indeterminate_change?.(false);
		}
		const next = !checked;
		checked = next;
		on_checked_change?.(next);
	}

	$effect(() => {
		if (isReadonly || isDisabled || controlId === undefined) return;
		const ariaLabel = restProps['aria-label'];
		return register_control({
			id: `checkbox:${controlId}`,
			kind: 'checkbox',
			...(typeof ariaLabel === 'string' ? { label: ariaLabel } : {}),
			element: () => ref,
			disabled: () => isDisabled || isReadonly,
			state: () => ({ checked, indeterminate }),
			actions: {
				toggle,
				set: (v) => {
					if (typeof v === 'boolean') setChecked(v);
				}
			}
		});
	});
	function handleClick(
		e: MouseEvent & { currentTarget: EventTarget & HTMLButtonElement }
	): void {
		onclick?.(e);
		if (!e.defaultPrevented) toggle();
	}

	function handleKeydown(
		e: KeyboardEvent & { currentTarget: EventTarget & HTMLButtonElement }
	): void {
		onkeydown?.(e);
		if (e.defaultPrevented) return;
		if (e.key === ' ') {
			e.preventDefault();
			toggle();
		} else if (e.key === 'Enter') {
			e.preventDefault();
		}
	}
</script>

{#if readonly ?? controls.readonly}
	<CopyText id={restProps.id ?? undefined} text={checked ? t('yes') : t('no')} />
{:else}
	<button
		bind:this={ref}
		type="button"
		role="checkbox"
		aria-checked={indeterminate ? 'mixed' : checked}
		aria-required={required || undefined}
		data-state={dataState}
		data-disabled={isDisabled ? 'true' : undefined}
		disabled={isDisabled}
		{...restProps}
		onclick={handleClick}
		onkeydown={handleKeydown}
		class={cn(
			'peer box-content size-4 shrink-0 rounded-inset border border-border-control focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset disabled:cursor-not-allowed disabled:opacity-50 data-[disabled=true]:cursor-not-allowed data-[disabled=true]:opacity-50 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground',
			className
		)}
	>
		<Inline as="span" justify="center" class="size-4 text-current">
			{#if indeterminate}
				<Icon icon="lucide:minus" class="size-3.5" />
			{:else}
				<Icon icon="lucide:check" class={cn('size-3.5', !checked && 'text-transparent')} />
			{/if}
		</Inline>
	</button>
	{#if name !== undefined}
		<input type="checkbox" {name} {value} {checked} disabled={isDisabled} {required} tabindex="-1" aria-hidden="true" class="sr-only" />
	{/if}
{/if}
