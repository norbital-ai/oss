<!--
@component
A paged view's pager: the page size, previous and next, and "Page X of Y" (`pages` unknown: "Page X").
@example
<TablePager {ctx} size={25} page={1} pages={4} has_previous={false} has_next on_size={…} on_previous={…} on_next={…} />
-->
<script lang="ts">
	import type { UiContext } from '../client/contract.js';
	import { words_of } from '../client/context.js';
	import { create_pagination } from '../behaviors/index.js';
	import { Button } from '../primitives/button/index.js';
	import Combobox from '../primitives/combobox/combobox.svelte';
	import Glyph from '../primitives/icon/Glyph.svelte';
	import { msg } from '../text/messages.js';

	let {
		ctx,
		size,
		sizes = [10, 25, 50, 100, 200],
		page,
		pages = null,
		has_previous,
		has_next,
		on_size,
		on_previous,
		on_next
	}: {
		/** The page context (`ctx`), passed whole. */
		ctx: UiContext;
		/** Rows per page. */
		size: number;
		/** The page sizes offered. */
		sizes?: readonly number[];
		/** The page shown, from 1. */
		page: number;
		/** The page count, or `null` when unknown. */
		pages?: number | null;
		/** A page comes before this one. */
		has_previous: boolean;
		/** A page comes after this one. */
		has_next: boolean;
		/** The viewer picked a page size. */
		on_size: (size: number) => void;
		/** Go to the previous page. */
		on_previous: () => void;
		/** Go to the next page. */
		on_next: () => void;
	} = $props();
	const text = $derived(words_of(ctx));
	const pager = create_pagination({
		page: () => page,
		total_pages: () => pages,
		has_previous: () => has_previous,
		has_next: () => has_next,
		on_page_change: (next) => {
			if (next > page) on_next();
			else if (next < page) on_previous();
		},
		control: { id: 'table:pager', label: 'Table pagination' }
	});
</script>

<div class="flex items-center gap-1" data-pager>
	<Combobox
		variant="ghost"
		class="w-24"
		readonly={false}
		aria-label={msg(text, 'table.pageSize')}
		searchable={false}
		options={sizes.map((n) => ({ value: String(n), label: msg(text, 'table.perPage', { n }) }))}
		value={String(size)}
		on_change={(v) => v !== null && on_size(Number(v))}
	/>
	<Button
		size="icon"
		variant="ghost"
		hint={msg(text, 'table.prev')}
		aria-label={msg(text, 'table.prev')}
		disabled={!pager.has_previous}
		onclick={() => pager.previous()}><Glyph name="left" /></Button
	>
	<span class="min-w-16 text-center tabular-nums" data-page
		>{pager.pages === null
			? msg(text, 'table.page', { page: pager.page })
			: msg(text, 'table.pageOf', { page: pager.page, pages: pager.pages })}</span
	>
	<Button
		size="icon"
		variant="ghost"
		hint={msg(text, 'table.next')}
		aria-label={msg(text, 'table.next')}
		disabled={!pager.has_next}
		onclick={() => pager.next()}><Glyph name="right" /></Button
	>
</div>
