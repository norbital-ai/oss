<script lang="ts">
	// The view popover of `Table` and `Board` (rule 16b, P34): one filter-and-sort toolbar icon. The main control is
	// "Describe what to show…" (when the host can describe, rule 16a); the author's scope read-only, relations by their
	// label; explicit conditions and sort (≤ 4 keys) stay in a collapsed accordion when a describer is available.
	import type { CollectionExposure } from '../kinds/context.js';
	import Icon from '@iconify/svelte';
	import { CONTROL } from '../kinds/classes.js';
	import Combobox from '../primitives/combobox/combobox.svelte';
	import * as Popover from '../primitives/popover/index.js';
	import { cn } from '../primitives/utils.js';
	import type { Json } from './bolt.js';
	import { useBolt } from './bolt.js';
	import { fromWhere, nodeText, ORDER_MAX_KEYS, pathLabel, pathOf, sortText, type Node as FilterRow, type SortKey } from './filter.js';
	import FilterNode from './FilterNode.svelte';
	import Glyph from './Glyph.svelte';
	import { recordLabels } from './live.svelte.js';
	import { humanize, msg } from './model.js';
	import { useKinds } from '../kinds/context.js';
	import type { ViewState } from './view-state.svelte.js';

	let { view, catalog, collection, author, sortable }: {
		view: ViewState;
		catalog: { readonly [c: string]: CollectionExposure };
		collection: string;
		/** The author's `where`: shown, never removable. */
		author?: Json;
		sortable: readonly string[];
	} = $props();
	const bolt = useBolt();
	const kinds = useKinds();
	const named = recordLabels(bolt, () => kinds.catalog ?? catalog);
	let open = $state(false), text = $state(''), busy = $state(false), applied = $state(false), failed = $state(false);
	let details: HTMLDetailsElement | null = $state(null);
	const blank: FilterRow = { t: 'cond', path: '', op: 'eq', arg: null };
	const count = $derived(view.rows.length + view.order.length);
	const describes = $derived(bolt.describe !== undefined);
	/** The catalogue's words for an operator on a path (the fallback is the machine operator). */
	const opWords = (op: string, path: string) => view.offers.find((o) => o.op === op && pathOf(o.path).endsWith(path))?.opLabel ?? op;
	const authorText = $derived.by(() => {
		if (author === undefined || author === null) return null;
		const rows = fromWhere(catalog, collection, author);
		return rows === null ? JSON.stringify(author) : rows.map((n) => nodeText(catalog, collection, n, humanize, named, opWords)).join(' and ');
	});
	const setRow = (i: number, n: FilterRow) => view.setRows(view.rows.map((x, j) => j === i ? n : x));
	const setKey = (i: number, k: SortKey) => view.setOrder(view.order.map((x, j) => j === i ? k : x));
	const move = (i: number, d: -1 | 1) => { const o = [...view.order]; [o[i], o[i + d]] = [o[i + d]!, o[i]!]; view.setOrder(o); };
	async function describe(e: SubmitEvent) {
		e.preventDefault();
		if (text.trim() === '') return;
		busy = true;
		applied = failed = false;
		try { applied = await view.describe(text); failed = !applied; } finally { busy = false; }
	}
</script>

<!-- portaled, so a sticky table header never paints over it (it sat under the roster's day header on staging) -->
<Popover.Root bind:open onOpenChange={(o) => { if (o) { applied = failed = false; if (details) details.open = !describes; } }}>
	<Popover.Trigger>
		{#snippet child({ props })}
			<button {...props} type="button" class={cn('hover:bg-accent hover:text-accent-foreground focus-visible:ring-ring relative inline-flex h-8 min-w-8 items-center justify-center gap-1 rounded-sm px-2 focus-visible:ring-2 focus-visible:outline-none', count > 0 && 'bg-accent')}
				aria-label={msg(bolt, 'view.filterSort', 'Filter and sort')} title={msg(bolt, 'view.filterSort', 'Filter and sort')} data-view-popover data-view-trigger>
				<!-- sliders: filter and sort together (P34), not a funnel -->
				<svg viewBox="0 0 24 24" class="size-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" data-icon="sliders">
					<path d="M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3M14 2v4M8 10v4M16 18v4" />
				</svg>
				{#if count > 0}<span class="bg-primary text-primary-foreground rounded-full px-1.5 text-xs leading-5" data-view-count>{count}</span>{/if}
			</button>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content align="end" aria-label={msg(bolt, 'view.filterSort', 'Filter and sort')}
		class={cn('flex w-[min(46rem,calc(100vw-2rem))] flex-col gap-3 p-3',
			// one control height: on touch the kit raises buttons to the hit target, so inputs and selects follow
			'[&_input:not([type=checkbox])]:min-h-(--hit-target) [&_select]:min-h-(--hit-target)')} data-view-panel>
			<header class="flex items-center gap-2" data-view-header>
				{#if describes}
					<form class="flex min-w-0 flex-1 gap-2" onsubmit={describe} data-describe>
						<input class={cn(CONTROL, 'h-9 min-w-0 flex-1')} type="text" maxlength={500} bind:value={text} oninput={() => (applied = failed = false)} disabled={busy}
							placeholder={msg(bolt, 'view.describe', 'Describe what to show…')} aria-label={msg(bolt, 'view.describe', 'Describe what to show…')} />
						<button type="submit" disabled={busy || text.trim() === ''} class="bg-primary text-primary-foreground grid size-9 shrink-0 place-items-center rounded-md disabled:opacity-50" aria-label={msg(bolt, 'view.apply', 'Apply filter and sort')}>
							<Icon icon={busy ? 'lucide:loader-circle' : 'lucide:arrow-right'} class={cn('size-4', busy && 'animate-spin')} />
						</button>
					</form>
				{:else}<p class="flex-1 text-sm font-medium">{msg(bolt, 'view.title', 'Filters & sort')}</p>{/if}
				{#if count > 0}
					<button type="button" class="text-muted-foreground hover:text-foreground shrink-0 text-xs" data-clear onclick={() => view.clear()}>{msg(bolt, 'view.clearAll', 'Clear all')}</button>
				{/if}
			</header>
			{#if busy}<p role="status" class="text-muted-foreground text-xs" data-view-loading>{msg(bolt, 'view.applying', 'Applying filter and sort…')}</p>
			{:else if applied}<p role="status" class="text-xs text-primary" data-view-applied>{msg(bolt, 'view.applied', 'Filter and sort applied')}</p>{/if}
			<!-- a description that built nothing is an error the person must act on, never a quiet note beside "applied" -->
			{#if failed && view.notice}<p role="alert" class="text-destructive flex items-center gap-1 text-xs" data-view-error><Icon icon="lucide:circle-alert" class="size-3.5 shrink-0" />{view.notice}</p>
			{:else if view.notice}<p role="status" class="text-muted-foreground text-xs" data-view-notice>{view.notice}</p>{/if}
			<details bind:this={details} open={!describes} class="group" data-view-details>
				<summary class="text-muted-foreground hover:text-foreground flex cursor-pointer list-none items-center gap-1 text-xs" data-show-builder>
					<Icon icon="lucide:chevron-right" class="size-3.5 transition-transform group-open:rotate-90" />
					{msg(bolt, 'view.editConditions', 'Edit conditions')}{#if count > 0} ({count}){/if}
				</summary>
				<div class="mt-3 flex flex-col gap-3" data-view-builder>
			{#if authorText !== null}
				<p class="bg-muted/50 text-muted-foreground rounded-sm px-2 py-1.5 text-xs" data-author-where><Glyph name="lock" class="mr-1 inline size-3 align-[-2px]" />{msg(bolt, 'view.always', 'Always')}: {authorText}</p>
			{/if}
			<section class="flex flex-col gap-1.5" data-filter-rows>
				{#each view.rows as n, i (i)}
					<FilterNode node={n} {catalog} {collection} offers={view.offers} top onChange={(x) => setRow(i, x)} onRemove={() => view.setRows(view.rows.filter((_, j) => j !== i))} />
				{/each}
				<div class="flex gap-3 text-xs">
					<button type="button" class="text-muted-foreground hover:text-foreground" data-add-condition onclick={() => view.setRows([...view.rows, blank])}>+ {msg(bolt, 'view.addCondition', 'Add condition')}</button>
					<button type="button" class="text-muted-foreground hover:text-foreground" data-add-group onclick={() => view.setRows([...view.rows, { t: 'group', join: 'or', of: [blank] }])}>+ {msg(bolt, 'view.addGroup', 'Add group')}</button>
				</div>
			</section>

			{#if sortable.length > 0 || view.order.length > 0}
			<section class="flex flex-col gap-1.5 border-t pt-3" data-sort-rows>
				<p class="text-muted-foreground text-xs font-medium">{msg(bolt, 'view.sort', 'Sort')}</p>
				{#each view.order as k, i (k.field)}
					<div class="flex items-center gap-1.5" data-sort={k.field}>
						{#if k.near !== undefined}
							<!-- nearest first from a described place: shown, not re-pointed here -->
							<span class="text-sm" data-sort-near>{sortText(catalog, collection, k, humanize)}</span>
						{:else}
						<Combobox class="w-auto" aria-label={msg(bolt, 'view.sortField', 'Sort by')} value={k.field} onChange={(f) => { if (f !== null) setKey(i, { ...k, field: f }); }}
							options={sortable.filter((f) => f === k.field || !view.order.some((o) => o.field === f)).map((f) => ({ value: f, label: pathLabel(catalog, collection, f, humanize) }))} />
						<Combobox class="w-auto" aria-label={msg(bolt, 'view.direction', 'Direction')} value={k.dir} onChange={(d) => { if (d !== null) setKey(i, { ...k, dir: d }); }}
							options={[{ value: 'asc' as const, label: msg(bolt, 'view.asc', 'Ascending') }, { value: 'desc' as const, label: msg(bolt, 'view.desc', 'Descending') }]} />
						{/if}
						<button type="button" class="text-muted-foreground hover:bg-muted grid size-9 place-items-center rounded-sm disabled:opacity-40" disabled={i === 0}
							aria-label={msg(bolt, 'view.up', 'Move up')} onclick={() => move(i, -1)}>↑</button>
						<button type="button" class="text-muted-foreground hover:bg-muted grid size-9 place-items-center rounded-sm disabled:opacity-40" disabled={i === view.order.length - 1}
							aria-label={msg(bolt, 'view.down', 'Move down')} onclick={() => move(i, 1)}>↓</button>
						<span class="flex-1"></span>
						<button type="button" class="text-muted-foreground hover:bg-muted grid size-9 place-items-center rounded-sm" aria-label={msg(bolt, 'view.removeRow', 'Remove')}
							data-remove onclick={() => view.setOrder(view.order.filter((_, j) => j !== i))}>×</button>
					</div>
				{/each}
				{#if view.order.length < ORDER_MAX_KEYS && sortable.some((f) => !view.order.some((o) => o.field === f))}
					<button type="button" class="text-muted-foreground hover:text-foreground self-start text-xs" data-add-sort
						onclick={() => view.setOrder([...view.order, { field: sortable.find((f) => !view.order.some((o) => o.field === f))!, dir: 'asc' }])}>+ {msg(bolt, 'view.addSort', 'Add sort')}</button>
				{/if}
			</section>
			{/if}
				</div>
			</details>
	</Popover.Content>
</Popover.Root>
