<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLButtonAttributes } from 'svelte/elements';
	import type { WithElementRef } from '../utils.js';
	import { get_popover_context } from './context.js';

	let {
		ref = $bindable(null),
		child,
		children,
		onclick,
		...restProps
	}: WithElementRef<HTMLButtonAttributes, HTMLButtonElement> & {
		/** Optional render delegation snippet receiving close props. */
		child?: Snippet<[{ props: Record<string, unknown> }]>;
		/** Button content. */
		children?: Snippet;
	} = $props();

	const popover = get_popover_context();
	const closeProps = $derived({
		type: 'button' as const,
		onclick: (e: MouseEvent & { currentTarget: EventTarget & HTMLButtonElement }) => {
			popover?.set_open(false);
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
