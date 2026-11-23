<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLAttributes } from 'svelte/elements';
	import { cn } from '../utils.js';
	import { slide } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import { get_accordion_item } from './context.js';

	let {
		class: className,
		children,
		force_mount = true,
		hidden_until_found,
		...restProps
	}: HTMLAttributes<HTMLDivElement> & {
		/** Keep the transition container mounted cleanly (default `true`). */
		force_mount?: boolean;
		/** Optional HTML `hidden="until-found"` flag. */
		hidden_until_found?: boolean;
		/** Collapsible body content. */
		children?: Snippet;
	} = $props();

	const item = get_accordion_item();
	const open = $derived(item?.open ?? false);
</script>

{#if open}
	<div
		id={item?.content_id}
		role="region"
		aria-labelledby={item?.trigger_id}
		data-slot="accordion-content"
		data-state="open"
		class={cn('overflow-clip text-sm', className)}
		transition:slide={{ duration: 300, easing: cubicOut }}
		{...restProps}
	>
		<div class="pt-0 pb-4">
			{@render children?.()}
		</div>
	</div>
{:else if hidden_until_found && force_mount}
	<div
		id={item?.content_id}
		role="region"
		aria-labelledby={item?.trigger_id}
		data-slot="accordion-content"
		data-state="closed"
		hidden
	></div>
{/if}
