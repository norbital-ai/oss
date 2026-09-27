<!--
@component
A checkbox, bindable `checked` (and `indeterminate`). `readonly` (or an enclosing readonly form) shows Yes/No as text;
`disabled` keeps the box, muted.
-->
<script lang="ts">
	import { Inline } from '../../layout/index.js';
	import CopyText from '../copy-text/copy-text.svelte';
	import { cn, useControls, uiText } from '../utils.js';
	import Icon from '@iconify/svelte';
	import { Checkbox as CheckboxPrimitive, type WithoutChildrenOrChild } from 'bits-ui';

	let {
		ref = $bindable(null),
		checked = $bindable(false),
		indeterminate = $bindable(false),
		class: className,
		readonly,
		disabled,
		...restProps
	}: WithoutChildrenOrChild<CheckboxPrimitive.RootProps> & { readonly?: boolean } = $props();
	const controls = useControls();
	const t = uiText();
</script>

{#if readonly ?? controls.readonly}
	<CopyText id={restProps.id ?? undefined} text={checked ? t('yes') : t('no')} />
{:else}
<CheckboxPrimitive.Root
	bind:ref
	class={cn(
		'peer box-content size-4 shrink-0 rounded-sm border border-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset disabled:cursor-not-allowed disabled:opacity-50 data-[disabled=true]:cursor-not-allowed data-[disabled=true]:opacity-50 data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground',
		className
	)}
	bind:indeterminate
	bind:checked
	disabled={disabled ?? controls.disabled}
	{...restProps}
>
	{#snippet children({ checked })}
		<Inline as="span" justify="center" class="size-4 text-current">
			{#if indeterminate}
				<Icon icon="lucide:minus" class="size-3.5" />
			{:else}
				<Icon icon="lucide:check" class={cn('size-3.5', !checked && 'text-transparent')} />
			{/if}
		</Inline>
	{/snippet}
</CheckboxPrimitive.Root>
{/if}
