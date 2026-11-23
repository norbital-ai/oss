<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLAttributes } from 'svelte/elements';
	import { cn, type WithElementRef } from '../utils.js';
	import { get_dialog_context } from './context.js';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLHeadingElement>, HTMLHeadingElement> & {
		children?: Snippet;
	} = $props();

	const dialog = get_dialog_context();
	$effect(() => {
		dialog?.mark_title(true);
		return () => dialog?.mark_title(false);
	});
</script>

<h2 bind:this={ref} id={dialog?.title_id} class={cn('text-heading', className)} {...restProps}>
	{@render children?.()}
</h2>
