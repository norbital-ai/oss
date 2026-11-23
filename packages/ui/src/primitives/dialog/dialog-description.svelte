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
	}: WithElementRef<HTMLAttributes<HTMLParagraphElement>, HTMLParagraphElement> & {
		children?: Snippet;
	} = $props();

	const dialog = get_dialog_context();
	$effect(() => {
		dialog?.mark_description(true);
		return () => dialog?.mark_description(false);
	});
</script>

<p
	bind:this={ref}
	id={dialog?.description_id}
	class={cn('text-sm text-muted-foreground', className)}
	{...restProps}
>
	{@render children?.()}
</p>
