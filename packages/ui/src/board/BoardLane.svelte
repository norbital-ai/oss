<script lang="ts" generics="C extends ModelKey">
	import type { UiContext } from '../client/contract.js';
	// One lane: a stack of keyset pages, each its own live view. Scrolling near the lane's end opens the next page (server-side
	// infinite loading); the "Load more" button is the same step for a keyboard or where nothing observes the scroll.
	import { watch } from 'runed';
	import { Button } from '../primitives/button/index.js';
	import type { ModelKey } from '../model/types.js';
	import { bolt_of } from '../client/context.js';
	import BoardPage, { type BoardPageProps } from './BoardPage.svelte';
	import { msg } from '../text/messages.js';

	let {
		ctx,
		of,
		card,
		lane,
		where,
		order_by,
		search,
		page_size,
		selectable = false,
		selected,
		on_select,
		on_rows,
		on_change,
		grid = false,
		on_open,
		moves
	}: Omit<BoardPageProps<C>, 'index' | 'after' | 'on_next'> = $props();
	const bolt = $derived(bolt_of(ctx));
	let pages = $state<(string | null)[]>([null]);
	let nexts = $state<(string | null)[]>([]);
	// a new filter or sort starts the lane over (cursors are bound to the query)
	const query = $derived(JSON.stringify({ of, where, order_by, search }));
	watch(
		() => query,
		() => {
			pages = [null];
			nexts = [];
		},
		{ lazy: true }
	);
	/** The last page's cursor: null until it has loaded, and at the lane's end. */
	const more = $derived(nexts[pages.length - 1] ?? null);
	const load = () => {
		if (more !== null) pages = [...pages, more];
	};
	// the button mounts once the last page has its cursor; in view (within 240px of the lane's end) it loads the next, and a
	// page too short to fill the lane chains the one after it
	const nearEnd = (el: HTMLElement) => {
		if (typeof IntersectionObserver === 'undefined') return;
		const io = new IntersectionObserver(
			(es) => {
				if (es.some((e) => e.isIntersecting)) load();
			},
			{ root: el.closest('[data-lane-scroll]'), rootMargin: '0px 0px 240px 0px' }
		);
		io.observe(el);
		return () => io.disconnect();
	};
</script>

{#each pages as after, i (after ?? '')}
	<BoardPage {ctx}
		{of}
		{card}
		{lane}
		{where}
		{order_by}
		{search}
		{page_size}
		{selectable}
		{selected}
		{on_select}
		{on_rows}
		{on_change}
		{grid}
		{on_open}
		{moves}
		index={i}
		{after}
		on_next={(n) => (nexts[i] = n)}
	/>
{/each}
{#if more !== null}
	<Button
		variant="ghost"
		class={grid ? 'col-span-full' : undefined}
		onclick={load}
		data-lane-more
		{@attach nearEnd}>{msg(bolt, 'board.more')}</Button
	>
{/if}
