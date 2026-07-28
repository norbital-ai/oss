<script lang="ts" module>
	type Entry<T> = { item: T; id: string; index: number };
	type Layout<T> = { visible: Entry<T>[]; hidden: Entry<T>[] };

	function availableWidth(node: HTMLElement): number {
		return node.clientWidth;
	}

	function rowWidth(indices: number[], widths: number[], gap: number): number {
		return indices.reduce(
			(sum, index, position) => sum + widths[index] + (position > 0 ? gap : 0),
			0
		);
	}

	function packEntries<T>(
		entries: Entry<T>[],
		widths: number[],
		available: number,
		gap: number,
		ellipsisWidth: number
	): Layout<T> {
		if (entries.length === 0) return { visible: [], hidden: [] };

		const all = entries.map((_, index) => index);
		if (rowWidth(all, widths, gap) <= available) {
			return { visible: entries, hidden: [] };
		}

		const narrowFirst = [...all].sort(
			(left, right) => widths[left] - widths[right] || left - right
		);

		for (let count = entries.length - 1; count >= 0; count--) {
			const hidden = entries.length - count;
			const picked = narrowFirst.slice(0, count).sort((left, right) => left - right);
			const need = rowWidth(picked, widths, gap) + (hidden > 0 ? gap + ellipsisWidth : 0);
			if (need <= available) {
				const visible = new Set(picked);
				return {
					visible: entries.filter((_, index) => visible.has(index)),
					hidden: entries.filter((_, index) => !visible.has(index))
				};
			}
		}

		return { visible: [], hidden: entries };
	}
</script>

<script lang="ts" generics="T extends { key?: string }">
	import { cn } from '#lib/utils';
	import { useResizeObserver, watch } from 'runed';
	import type { Snippet } from 'svelte';
	import { tick } from 'svelte';

	let {
		items = [] as T[],
		enabled = true,
		gap = 4,
		class: cls = '',
		children,
		ellipsis,
		overflow
	}: {
		items: T[];
		enabled?: boolean;
		gap?: number;
		class?: string;
		children: Snippet<[T, number]>;
		ellipsis?: Snippet<[number]>;
		overflow?: Snippet<[T[]]>;
	} = $props();

	const entries = $derived.by((): Entry<T>[] => {
		const seen: Record<string, number> = {};
		return items.map((item, index) => {
			const key = item?.key ?? String(index);
			const occurrence = seen[key] ?? 0;
			seen[key] = occurrence + 1;
			return { item, id: `${key}#${occurrence}`, index };
		});
	});

	const signature = $derived(entries.map((entry) => entry.id).join('\0'));

	let rootEl = $state<HTMLDivElement | null>(null);
	let measureEl = $state<HTMLDivElement | null>(null);
	let layout = $state<Layout<T>>({ visible: [], hidden: [] });

	const shown = $derived(enabled ? layout.visible : entries);
	const hiddenCount = $derived(enabled ? layout.hidden.length : 0);
	const hiddenItems = $derived(layout.hidden.map((entry) => entry.item));

	let layoutQueued = false;

	async function updateLayout(attempt = 0) {
		if (!enabled) {
			layout = { visible: entries, hidden: [] };
			return;
		}

		if (!rootEl || !measureEl) return;

		await tick();

		const available = availableWidth(rootEl);
		const itemNodes = measureEl.querySelectorAll<HTMLElement>('[data-measure-item]');
		const widths = [...itemNodes].map((node) => Math.ceil(node.getBoundingClientRect().width));
		const ellipsisNode = measureEl.querySelector<HTMLElement>('[data-measure-ellipsis]');
		const ellipsisWidth = Math.ceil(ellipsisNode?.getBoundingClientRect().width ?? 0);

		const waiting =
			attempt < 8 &&
			entries.length > 0 &&
			(available <= 0 ||
				itemNodes.length < entries.length ||
				widths.some((width) => width <= 0) ||
				(entries.length > 1 && ellipsisWidth <= 0));

		if (waiting) {
			requestAnimationFrame(() => void updateLayout(attempt + 1));
			return;
		}

		layout = packEntries(entries, widths, available, gap, ellipsisWidth);
	}

	function scheduleLayout() {
		if (layoutQueued) return;
		layoutQueued = true;
		requestAnimationFrame(() => {
			layoutQueued = false;
			void updateLayout();
		});
	}

	watch(
		() => [signature, rootEl, measureEl] as const,
		() => scheduleLayout()
	);

	useResizeObserver(
		() => rootEl,
		() => scheduleLayout()
	);
</script>

{#snippet fallbackEllipsis(count: number)}
	<span class="rounded-full bg-neutral-300 px-2 py-1">+{count}</span>
{/snippet}

{#snippet overflowIndicator(count: number)}
	{#if overflow}
		{@render overflow(hiddenItems)}
	{:else}
		<span class="shrink-0" aria-label={'Show ' + count + ' more'} title={'Show ' + count + ' more'}>
			{@render (ellipsis ?? fallbackEllipsis)(count)}
		</span>
	{/if}
{/snippet}

<div
	bind:this={rootEl}
	class={cn(
		'relative flex min-w-0 w-0 max-w-full flex-1 items-center overflow-hidden whitespace-nowrap',
		cls
	)}
>
	<div
		bind:this={measureEl}
		aria-hidden="true"
		class="pointer-events-none invisible absolute flex h-0 overflow-hidden whitespace-nowrap"
		style:gap="{gap}px"
	>
		{#each entries as entry (entry.id)}
			<div data-measure-item class="shrink-0">
				{@render children(entry.item, entry.index)}
			</div>
		{/each}
		{#if entries.length > 1}
			<span data-measure-ellipsis class="inline-flex shrink-0">
				{@render (ellipsis ?? fallbackEllipsis)(entries.length)}
			</span>
		{/if}
	</div>

	<div class="flex min-w-0 items-center overflow-hidden whitespace-nowrap" style:gap="{gap}px">
		{#each shown as entry (entry.id)}
			<div class="shrink-0">{@render children(entry.item, entry.index)}</div>
		{/each}
		{#if hiddenCount > 0}
			{@render overflowIndicator(hiddenCount)}
		{/if}
	</div>
</div>
