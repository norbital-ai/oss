<script lang="ts" module>
	import type { Snippet } from 'svelte';
	import type { HTMLAttributes } from 'svelte/elements';

	export type VirtualListItemProps = HTMLAttributes<HTMLElement> &
		Record<`data-${string}`, string | undefined>;

	export interface VirtualListProps<T> extends Omit<HTMLAttributes<HTMLElement>, 'children'> {
		items: readonly T[];
		/** Stable identity; measured heights follow the key through reorders and remounts. */
		key: (item: T) => string;
		item: Snippet<[T, number]>;
		/** `ol`/`ul` render each item as an `li`. */
		as?: 'div' | 'ol' | 'ul';
		/** First-paint height guess in px; every mounted item is measured afterwards. */
		estimateSize?: number;
		/** Space after every item but the last, in px. */
		gap?: number;
		overscan?: number;
		/** Attributes for the item element itself — no wrapper between it and the list (Sortable). */
		itemProps?: (item: T, index: number) => VirtualListItemProps;
		/** Called with the last mounted index whenever the window moves; drives infinite loading. */
		onRange?: (lastIndex: number) => void;
		/** Defaults to the nearest `Scroll`. Without either, every item renders in flow. */
		scrollElement?: HTMLElement | null;
		/** The list element; its direct children are exactly the mounted items. */
		ref?: HTMLElement | null;
	}
</script>

<script lang="ts" generics="T">
	import { getContext } from 'svelte';
	import { SCROLL_PORT_CONTEXT, type ScrollPort } from '#lib/layout/layout.shared';
	import { createVirtualizer } from '#lib/utils/virtualizer.svelte';
	import { cn } from '#lib/utils';

	let {
		items,
		key,
		item,
		as = 'div',
		estimateSize = 48,
		gap = 0,
		overscan = 4,
		itemProps,
		onRange,
		scrollElement,
		ref = $bindable(null),
		class: className,
		style,
		...rest
	}: VirtualListProps<T> = $props();

	const port = getContext<ScrollPort | undefined>(SCROLL_PORT_CONTEXT);
	const scroller = $derived(scrollElement === undefined ? (port?.element ?? null) : scrollElement);
	const virtual = $derived(scrollElement !== undefined || port !== undefined);
	const itemTag = $derived(as === 'div' ? 'div' : 'li');

	const virtualizer = createVirtualizer({
		count: () => items.length,
		scrollElement: () => (virtual ? scroller : null),
		listElement: () => ref,
		estimateSize: () => estimateSize + gap,
		overscan: () => overscan,
		getItemKey: (index) => key(items[index]!),
		onChange: (instance) => {
			const last = instance.virtualItems.at(-1);
			if (last) onRange?.(last.index);
		}
	});

	const slots = $derived(
		virtual ? virtualizer.virtualItems : items.map((entry, index) => ({ index, key: key(entry) }))
	);
	const padTop = $derived(virtual ? (virtualizer.virtualItems[0]?.start ?? 0) : 0);

	// One observer for every mounted item: a row that grows (a streamed reply, an opened
	// disclosure) re-measures itself without the list having to know why.
	const observer =
		typeof ResizeObserver === 'undefined'
			? null
			: new ResizeObserver((entries) => {
					for (const entry of entries) {
						if (entry.target instanceof HTMLElement) virtualizer.measureElement(entry.target);
					}
				});

	function measured(element: HTMLElement) {
		observer?.observe(element);
		return () => observer?.unobserve(element);
	}
</script>

<svelte:element
	this={as}
	bind:this={ref}
	class={cn('[overflow-anchor:none]', className)}
	style={virtual
		? `box-sizing:border-box;height:${virtualizer.totalSize}px;padding-top:${padTop}px;${style ?? ''}`
		: style}
	{...rest}
>
	{#each slots as slot (slot.key)}
		{@const entry = items[slot.index]}
		{#if entry !== undefined}
			{@const extra = itemProps?.(entry, slot.index)}
			<svelte:element
				this={itemTag}
				{...extra}
				data-index={slot.index}
				class={cn('flow-root', extra?.class)}
				style={gap > 0 && slot.index < items.length - 1
					? `padding-bottom:${gap}px;${extra?.style ?? ''}`
					: extra?.style}
				{@attach measured}
			>
				{@render item(entry, slot.index)}
			</svelte:element>
		{/if}
	{/each}
</svelte:element>
