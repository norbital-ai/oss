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
		/** Optional render delegation snippet receiving close props. */
		child?: Snippet<[{ props: Record<string, unknown> }]>;
		/** Close button content. */
		children?: Snippet;
	} = $props();

	const dialog = get_dialog_context();
	const closeProps = $derived({
		type: 'button' as const,
		onclick: (e: MouseEvent & { currentTarget: EventTarget & HTMLButtonElement }) => {
			dialog?.set_open(false);
			onclick?.(e);
		},
		...restProps
	});
</script>

{#if child}
	{@render child({ props: closeProps })}
{:else}
	<button bind:this={ref} {...closeProps}>
		{@render children?.()}
	</button>
{/if}
