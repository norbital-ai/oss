<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLAttributes } from 'svelte/elements';
	import { bind_findable } from '../../behaviors/index.js';
	import { cn } from '../utils.js';
	import { slide } from 'svelte/transition';
	import { get_accordion_item } from './context.js';

	// Critically-damped snappy spring (matches `--ease-spring-snappy`, zero height overshoot).
	const SPRING_W = 8.4;
	const SPRING_NORM = 1 - (1 + SPRING_W) * Math.exp(-SPRING_W);
	const snappySpring = (t: number) =>
		t <= 0 ? 0 : t >= 1 ? 1 : (1 - (1 + SPRING_W * t) * Math.exp(-SPRING_W * t)) / SPRING_NORM;

	let {
		class: className,
		children,
		force_mount = true,
		hidden_until_found = false,
		...restProps
	}: HTMLAttributes<HTMLDivElement> & {
		/** Keep the transition container mounted cleanly (default `true`). */
		force_mount?: boolean;
		/** Keep closed content findable via Ctrl/Cmd+F (`hidden="until-found"` + `beforematch` reveal). */
		hidden_until_found?: boolean;
		/** Collapsible body content. */
		children?: Snippet;
	} = $props();

	const item = get_accordion_item();
	const open = $derived(item?.open ?? false);
	const slideDuration = () =>
		typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
			? 0
			: 180;
</script>

{#if hidden_until_found && force_mount}
	<div
		id={item?.content_id}
		role="region"
		aria-labelledby={item?.trigger_id}
		data-slot="accordion-content"
		data-state={open ? 'open' : 'closed'}
		class={cn('overflow-clip text-sm', className)}
		{@attach bind_findable({
			open: () => open,
			findable: () => true,
			on_reveal: () => {
				if (!open) item?.toggle();
			}
		})}
		{...restProps}
	>
		<div class="pt-0 pb-4">
			{@render children?.()}
		</div>
	</div>
{:else if open}
	<div
		id={item?.content_id}
		role="region"
		aria-labelledby={item?.trigger_id}
		data-slot="accordion-content"
		data-state="open"
		class={cn('overflow-clip text-sm', className)}
		transition:slide={{ duration: slideDuration(), easing: snappySpring }}
		{...restProps}
	>
		<div class="pt-0 pb-4">
			{@render children?.()}
		</div>
	</div>
{/if}
