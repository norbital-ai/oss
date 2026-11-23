<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLButtonAttributes } from 'svelte/elements';
	import type { WithElementRef } from '../utils.js';
	import { get_dialog_context } from './context.js';

	let {
		ref = $bindable(null),
		child,
		children,
		onclick,
		...restProps
	}: WithElementRef<HTMLButtonAttributes, HTMLButtonElement> & {
		/** Optional render delegation snippet receiving trigger props. */
		child?: Snippet<[{ props: Record<string, unknown> }]>;
		/** Trigger label content. */
		children?: Snippet;
	} = $props();

	const dialog = get_dialog_context();
	const triggerProps = $derived({
		type: 'button' as const,
		'aria-haspopup': 'dialog' as const,
		'aria-expanded': dialog?.open ?? false,
		onclick: (e: MouseEvent & { currentTarget: EventTarget & HTMLButtonElement }) => {
			dialog?.set_open(true);
			onclick?.(e);
		},
		...restProps
	});
</script>

{#if child}
	{@render child({ props: triggerProps })}
{:else}
	<button bind:this={ref} {...triggerProps}>
		{@render children?.()}
	</button>
{/if}
