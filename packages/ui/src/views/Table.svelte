<script lang="ts" module>
	import type { Snippet } from 'svelte';
	import type { ActionInputOf, ActionKey, CollectionKey, Json, ManyOf, Page, OrderByOf, Q, QueryInputOf, QueryKey, QueryOutputOf, RecordOf, Row, RowOf, WhereOf } from './bolt.js';
	import type { OrderBy, Where } from './filter.js';
	import type { Toolbar } from './ViewToolbar.svelte';

	/** A view's source (§3.6): a collection name, a collection query that pages, a `bolt` query, or a local array. */
	export type TableSource = CollectionKey | { [N in QueryKey]: { query: N; input?: QueryInputOf<N> } }[QueryKey] | Q<unknown> | readonly object[];
	type PageRow<T> = T extends { readonly rows: readonly (infer R)[] } ? R : T extends readonly (infer R)[] ? R : Row;
	/** The row a source yields: the collection's caller row, the query's or read's rows, or the array's element. */
	export type RowIn<S> = S extends string ? RowOf<S> : S extends { query: infer N } ? PageRow<QueryOutputOf<N>> : S extends Q<infer T> ? PageRow<T>
		: S extends readonly (infer R)[] ? R : Row;
	/** The fields a column may name: a collection's whole record (a heavy field is then read) and its many-relations (the
	 * related records, each `{ id, …label }`), else the row's. */
	export type ColumnsIn<S> = S extends string ? RecordOf<S> & { readonly [M in ManyOf<S>]: readonly Row[] } : RowIn<S>;
	/**
	 * A column: a field of `K` (default the row), or its literal; distributive, so a `cell` snippet's `value` is that field's
	 * type. Without `cell` the field kind's default renderer draws it (money, file, point, phone, enum chips, dates, …), and
	 * a relation its target's label as a link (a many-relation: the first label and "+N").
	 */
	export type Col<R = Row, K = R> = { [F in keyof K & string]: F | { field: F; label?: string; width?: number; hide?: 'narrow'; edit?: true;
		cell?: Snippet<[{ row: R; value: K[F] | undefined }]> } }[keyof K & string];
	/** A row action literal: `{ action: '<c>.<a>', input?, confirm? }`; the default input targets the row. */
	export type RowAction<R = Row> = { [A in ActionKey]: { action: A; input?: (row: R) => ActionInputOf<A>; confirm?: string; label?: string } }[ActionKey];
	/** Typed by the source `of` names (`TableProps<S, RowIn<S>>`); the view's own code reads the name-erased default. */
	export type TableProps<S = TableSource, R = Row, K = R> = {
		of: S;
		columns: readonly Col<R, K>[];
		/** The author's fixed scope: ANDed under every viewer filter, shown read-only in the view popover, never clearable. */
		where?: S extends string ? WhereOf<S> : Where;
		/** Seed rows of the view popover the viewer may edit or clear; a cleared choice is kept in the URL. */
		initialFilter?: S extends string ? WhereOf<S> : Where;
		/** The initial sort; a viewer's sort replaces it and clearing restores it. */
		orderBy?: S extends string ? OrderByOf<S> : OrderBy;
		pageSize?: 10 | 25 | 50 | 100 | 200;
		/** The chrome: title, description, search, filter and sort, the actions menu and New (`ViewToolbar`). */
		toolbar?: Toolbar<R>;
		actions?: readonly RowAction<R>[];
		/** The URL parameter prefix; defaults to the source's name. */
		key?: string;
		/** A clock query's refresh (`every`, rule 64). */
		every?: string;
		empty?: Snippet;
		onOpen?: (row: R) => void;
		/** Local arrays only: editable when given; each change is a fresh array. */
		onChange?: (next: R[]) => void;
		add?: () => R;
		remove?: boolean;
	};
</script>

<script lang="ts">
	import { getAllContexts, untrack } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { watch as onChange_ } from 'runed';
	import { Button } from '../primitives/button/index.js';
	import * as Popover from '../primitives/popover/index.js';
	import { Combobox } from '../primitives/combobox/index.js';
	import { virtualList } from '../primitives/virtual/virtual.svelte.js';
	import { useKinds } from '../kinds/context.js';
	import { NUMERIC } from '../kinds/kind.js';
	import { openRecord, useBolt, type Outcome } from './bolt.js';
	import EmptyState from './EmptyState.svelte';
	import Glyph, { type GlyphName } from './Glyph.svelte';
	import { watch } from './live.svelte.js';
	import { notify } from './notify.js';
	import { localExposure, matches, orderOf, sortable, sortRows } from './filter.js';
	import {
		and, compact, COUNT_EVERY_MS, countOf, filesOf, humanize, isRow, label, like, msg, nextOf,
		listSelect, once, pageRead, queryIds, plain, rangeText, readTableState, removeRow, rowsOf, refOf, show, unref, searchRows, setCell, valueAt, writeTableState, type ReadState, type TableState,
	} from './model.js';
	import { viewState } from './view-state.svelte.js';
	import ViewToolbar from './ViewToolbar.svelte';
	import ReadGate from './ReadGate.svelte';
	import Value from './Value.svelte';

	let { of, columns, where, initialFilter, orderBy, pageSize = 25, toolbar = {}, actions = [], key, every, empty, onOpen, onChange, add, remove }: TableProps = $props();
	const bolt = useBolt();
	const kinds = useKinds();

	const kind = $derived(Array.isArray(of) ? 'local' : typeof of === 'string' ? 'collection' : isRow(of) && 'query' in of ? 'query' : 'q');
	const name = $derived(typeof of === 'string' ? of : isRow(of) && typeof of['query'] === 'string' ? of['query'] : '');
	/** The collection a source reads: its name, the query's collection, or the query's first argument. */
	const collection = $derived(kind === 'collection' ? name : kind === 'query' ? name.slice(0, name.lastIndexOf('.'))
		: kind === 'q' && typeof (of as Q<unknown>).read.a[0] === 'string' ? String((of as Q<unknown>).read.a[0]) : '');
	const urlKey = $derived(key ?? (name || collection || 'rows'));
	const fields = $derived(columns.map((c) => typeof c === 'string' ? c : c.field));
	const colOf = (c: Col) => typeof c === 'string' ? { field: c } : c;
	// a relation column (a FK or a many-relation) without an authored `cell` shows its targets' labels, read with the page
	// in the same statement (kind `collection` only)
	const refs = $derived(kind === 'collection' ? columns.filter((c) => colOf(c).cell === undefined).map((c) => colOf(c).field) : []);
	const tb = $derived(toolbar === false ? {} : toolbar);
	// search where the collection declares search fields (rule 16), or over a local array's columns
	// or through a named similarity or query (the toolbar's `/<name>`)
	const exposed = $derived(kinds.catalog?.[collection]);
	const canSearch = $derived(kind === 'local' || (kind === 'collection' && ((exposed?.search?.length ?? 0) > 0 || exposed?.similarity !== undefined || exposed?.queries !== undefined)));
	const kindOf = (f: string) => kinds.catalog?.[collection]?.fields[f];
	/** A number column reads right-aligned in tabular figures (staging's money and number cells). */
	const numeric = (f: string) => NUMERIC.has(kindOf(f)?.kind ?? '');
	const colLabel = (c: Col) => colOf(c).label ?? kindOf(colOf(c).field)?.label ?? (collection === '' ? fieldLabel(colOf(c).field) : label(bolt, collection, colOf(c).field));
	const fieldLabel = (f: string) => kindOf(f)?.label ?? (collection === '' ? humanize(f) : label(bolt, collection, f));
	const canFilter = $derived(kind === 'collection' || kind === 'local');
	// the view popover's catalog: the caller's exposure, or a local array's columns (kinds from its values)
	const LOCAL = '$local';
	const source = $derived(kind === 'local' ? LOCAL : collection);
	const catalog = $derived(kind === 'local' ? { [LOCAL]: localExposure(of as readonly Row[], fields, (f) => fieldLabel(f)) }
		: kinds.catalog?.[collection] !== undefined ? kinds.catalog : { ...kinds.catalog, [collection]: localExposure([], fields, (f) => fieldLabel(f)) });
	const sorts = $derived(kind === 'collection' || kind === 'local' ? sortable(catalog[source], kind !== 'local', catalog) : []);
	const vs = viewState(bolt, { key: () => urlKey, collection: () => source, catalog: () => catalog, initialFilter: () => initialFilter });
	const selectable = $derived(kind !== 'local' && (tb.select === true || tb.delete === true || (tb.actions || []).some((t) => t.requiresSelection || t.group === 'bulk' || typeof t.disabled === 'function')));
	const contexts = getAllContexts(); // a New's sheet mounts outside the page; the page's create scope rides along
	const canNew = $derived(tb.new !== false && kind === 'collection' && (typeof tb.new === 'function' || kinds.catalog?.[collection]?.create !== undefined));

	// ── the viewer's columns (staging's grid): order, widths, hidden and pinned columns, and the page size, kept per table in
	// this browser (staging's persisted state); pinned columns lead and stay put ──
	const LAYOUT = $derived(`ui.table.${urlKey}`);
	type Layout = { pinned?: string[]; widths?: { [f: string]: number }; size?: number; order?: string[]; hidden?: string[] };
	const stored = (): Layout => {
		try { return JSON.parse(localStorage.getItem(untrack(() => LAYOUT)) ?? '{}'); } catch { return {}; }
	};
	let pinned = $state<string[]>(stored().pinned ?? []);
	let widths = $state<{ [f: string]: number }>(stored().widths ?? {});
	let arranged = $state<string[]>(stored().order ?? []);
	let hidden = $state<string[]>(stored().hidden ?? []);
	// the viewer's page size (the footer's select), kept with the layout; the author's `pageSize` is the default
	const SIZES = [10, 25, 50, 100, 200] as const;
	let size = $state<number>(untrack(() => SIZES.find((n) => n === stored().size) ?? pageSize));
	const keep = () => { try { localStorage.setItem(LAYOUT, JSON.stringify({ pinned, widths, size, order: arranged, hidden } satisfies Layout)); } catch { /* not kept; this view still has it */ } };
	// ── view state in the URL (rule 8) ──
	const params = () => typeof location === 'undefined' ? new URLSearchParams() : new URL(location.href).searchParams;
	let st = $state<TableState>(untrack(() => readTableState(params(), urlKey)));
	let back = $state<(string | null)[]>([]);
	let qText = $state(untrack(() => st.q));
	// a typed index the toolbar runs, a named similarity (§3.3.4) or query: its rows, in its order, in place of the page;
	// read once, not live
	let probe = $state<{ name: string; via: 'similar' | 'query'; input: Json } | null>(null);
	async function probed(p: { name: string; via: 'similar' | 'query'; input: Json }): Promise<Page> {
		const select = listSelect(kinds.catalog, name, fields, refs), where = scope;
		if (p.via === 'similar') {
			if (bolt.similar === undefined) throw new Error('this host answers no similar read');
			return { rows: rowsOf(await bolt.similar(name, p.name, p.input, compact({ where, select, limit: size }))), next: null };
		}
		const out = queryIds(await bolt.query(`${name}.${p.name}`, p.input), exposed?.queries?.[p.name]?.output, name);
		if ('rows' in out) return { rows: out.rows, next: null };
		if (out.ids.length === 0) return { rows: [], next: null };
		const byId = new Map(rowsOf(await bolt.read(name, compact({ where: and(where, { id: { in: out.ids } }), select, limit: out.ids.length }))).map((r) => [r['id'], r]));
		return { rows: out.ids.map((id) => byId.get(id)).filter((r) => r !== undefined), next: null };
	}
	let notice = $state<string | null>(null);
	$effect(() => {
		const next = writeTableState(params(), urlKey, st);
		if (typeof location !== 'undefined') history.replaceState(history.state, '', `${location.pathname}${next.size > 0 ? `?${next}` : ''}${location.hash}`);
	});
	$effect(() => {
		const q = qText;
		const timer = setTimeout(() => { if (q !== untrack(() => st.q)) st = { ...untrack(() => st), q, after: null }, back = []; }, 300);
		return () => clearTimeout(timer);
	});
	const restart = (patch: Partial<TableState>) => { st = { ...st, ...patch, after: null }; back = []; selected.clear(); };
	// a new filter or sort starts from the first page
	onChange_(() => [vs.where, vs.order], () => restart({}), { lazy: true });

	// ── the page (rule 7: cursor-only, live) ──
	const scope = $derived(and(where, vs.where));
	const order = $derived(vs.order.length > 0 ? orderOf(vs.order) : orderBy as Json | undefined);
	const page = watch(() => {
		const after = st.after ?? undefined;
		// hook:agent-ui — a later page stays live (its index is the pages behind it; a cursor restored from the URL has none)
		if (kind === 'collection' && probe !== null) return once(probed(probe));
		if (kind === 'collection') return pageRead(bolt, (limit, at) => bolt.read(name, compact({ where: scope, orderBy: order, search: st.q || undefined, select: listSelect(kinds.catalog, name, fields, refs), limit, after: at })),
			size, back.length > 0 ? back.length : null, after, every);
		if (kind === 'query') {
			const input = isRow(of) && isRow(of['input']) ? of['input'] : {};
			return bolt.live(bolt.query(name, compact({ ...input, limit: size, after })), { on: [collection] });
		}
		if (kind === 'q') return bolt.live(of as Q<unknown>, every === undefined ? {} : { every });
		return null;
	});
	$effect(() => {
		const s = page.state;
		if (s.kind === 'error' && s.code === 'badCursor') untrack(() => {
			notice = msg(bolt, 'table.badCursor', 'That page is no longer available; showing the first page.');
			restart({});
		});
	});
	const local = $derived(kind === 'local' ? sortRows(searchRows(of as readonly Row[], st.q, fields).filter((r) => matches(r, { t: 'group', join: 'and', of: vs.rows })), vs.order) : []);
	const view: ReadState<readonly Row[]> = $derived(kind === 'local' ? { kind: 'ready', value: local } : page.state.kind === 'ready' ? { kind: 'ready', value: unref(kinds.catalog, collection, refs, rowsOf(page.state.value), bolt.locale) } : page.state);
	const next = $derived(page.state.kind === 'ready' ? nextOf(page.state.value) : null);
	// a long page (pageSize 100/200, a local grid) renders a window of rows, one per layout, measured and keyed by id
	const shownRows = $derived(view.kind === 'ready' ? view.value : []);
	const rowKey = (i: number) => String(shownRows[i]?.['id'] ?? i);
	const wide = virtualList({ count: () => shownRows.length, key: rowKey, estimate: 37 });
	const narrow = virtualList({ count: () => shownRows.length, key: rowKey, estimate: 64 });

	// ── one-shot count (rule 7): on scope change, then at most every 30 s while the page changes ──
	let count = $state<number | null>(null);
	let countedAt = 0;
	const recount = () => {
		if (kind !== 'collection' || st.q !== '' || probe !== null) return void (count = null);
		countedAt = Date.now();
		bolt.aggregate(name, compact({ count: true, where: scope })).then((v) => (count = countOf(v)), () => (count = null));
	};
	$effect(() => { void name; void scope; void st.q; void probe; untrack(recount); });
	$effect(() => { void page.value; if (Date.now() - countedAt > COUNT_EVERY_MS) untrack(recount); });

	// ── selection and row actions (the toolbar runs its own) ──
	const selected = new SvelteSet<string>();
	const say = (o: Outcome) => {
		notify(bolt, o);
		if (o.kind === 'committed') for (const f of filesOf(o.output)) window.open(bolt.fileUrl(f), '_blank', 'noopener');
		if (o.kind === 'committed' || o.kind === 'pendingApproval') selected.clear();
	};
	async function rowAct(a: RowAction, row: Row) {
		if (a.confirm !== undefined && !confirm(a.confirm)) return;
		say(await bolt.act(a.action, a.input?.(row) ?? { target: row['id'] ?? null }));
	}
	// the toolbar's CSV: every row of the current scope, search and sort, over the view's columns
	const exporter = $derived(kind === 'collection' ? { fields, labels: columns.map(colLabel),
		read: () => bolt.read(name, compact({ where: scope, orderBy: order, search: st.q || undefined, select: listSelect(kinds.catalog, name, fields, refs), all: true })) }
		: kind === 'local' && tb.export === true ? { fields, labels: columns.map(colLabel), read: () => Promise.resolve(local) } : undefined);
	// the footer (staging's pagination bar): the range, the page size, "page X of Y" and previous/next over the cursor
	const paged = $derived(kind === 'collection' || kind === 'query');
	const range = $derived(view.kind !== 'ready' ? null : rangeText(bolt, back.length * size, view.value.length, paged ? count : view.value.length));
	const pages = $derived(count === null || !paged ? null : Math.max(1, Math.ceil(count / size)));
	const setSize = (n: number) => { size = n; keep(); restart({}); };
	const filtered = $derived(st.q !== '' || probe !== null || vs.rows.length > 0);

	const togglePin = (f: string) => { pinned = pinned.includes(f) ? pinned.filter((x) => x !== f) : [...pinned, f]; keep(); };
	const toggleHidden = (f: string) => { hidden = hidden.includes(f) ? hidden.filter((x) => x !== f) : [...hidden, f]; keep(); };
	// the viewer's order over the authored columns (a column the author added since keeps its place at the end)
	const rank = (f: string) => { const i = arranged.indexOf(f); return i < 0 ? arranged.length + fields.indexOf(f) : i; };
	const arrangedCols = $derived([...columns].sort((a, b) => rank(colOf(a).field) - rank(colOf(b).field)));
	const ordered = $derived([...arrangedCols.filter((c) => pinned.includes(colOf(c).field)), ...arrangedCols.filter((c) => !pinned.includes(colOf(c).field))]
		.filter((c) => !hidden.includes(colOf(c).field)));
	const hiddenCols = $derived(columns.filter((c) => hidden.includes(colOf(c).field)));
	const pinCount = $derived(ordered.filter((c) => pinned.includes(colOf(c).field)).length);
	const span = $derived(ordered.length + (selectable ? 1 : 0) + (actions.length > 0 || (kind === 'local' && onChange && remove) ? 1 : 0));
	/** Moves column `f` to `to`'s place (a drag onto a header), or one step (`±1`, the column menu's keyboard way). */
	function moveColumn(f: string, to: string | -1 | 1) {
		const now = ordered.map((c) => colOf(c).field), from = now.indexOf(f);
		const at = typeof to === 'number' ? from + to : now.indexOf(to);
		if (from < 0 || at < 0 || at >= now.length || at === from) return;
		now.splice(at, 0, ...now.splice(from, 1));
		arranged = [...now, ...hidden];
		keep();
	}
	let dragging = $state<string | null>(null);
	// a pinned column's left edge: the checkbox, then each pinned column before it as rendered (measured)
	let measured = $state<{ [f: string]: number }>({});
	const measure = (f: string) => (el: HTMLElement) => {
		const ro = new ResizeObserver(() => { if (measured[f] !== el.offsetWidth) measured[f] = el.offsetWidth; });
		ro.observe(el);
		return () => ro.disconnect();
	};
	const leftOf = (i: number) => (selectable ? 32 : 0) + ordered.slice(0, i).reduce((n, c) => n + (measured[colOf(c).field] ?? 0), 0);
	const widthOf = (c: Col) => widths[colOf(c).field] ?? colOf(c).width;
	const sized = (w: number | undefined) => w === undefined ? undefined : `width:${w}px;min-width:${w}px;max-width:${w}px`;
	function resize(e: PointerEvent, f: string) {
		const th = (e.currentTarget as HTMLElement).parentElement!, x0 = e.clientX, w0 = th.offsetWidth;
		const move = (m: PointerEvent) => { widths = { ...widths, [f]: Math.max(64, Math.round(w0 + m.clientX - x0)) }; };
		const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); document.body.style.cursor = ''; keep(); };
		e.preventDefault();
		document.body.style.cursor = 'col-resize';
		addEventListener('pointermove', move);
		addEventListener('pointerup', up);
	}
	const PIN_EDGE = 'shadow-[inset_-1px_0_0_0_var(--color-border)]';
	const held = (row: Row) => typeof row['approval_id'] === 'string';

	const opens = $derived(kind === 'collection' || onOpen !== undefined);
	const open = (row: Row) => onOpen ? onOpen(row) : kind === 'collection' && typeof row['id'] === 'string' && openRecord(collection, row['id']);
	/** A cell's full text, its tooltip when the single line truncates. */
	const fullText = (row: Row, f: string) => refOf(row, f)?.text ?? show(valueAt(row, f), bolt.locale);

	// ── local-array edits ──
	const edit = (i: number, field: string, text: string) => {
		const rows = of as readonly Row[];
		onChange?.(setCell(rows, i, field, like(plain(rows[i]?.[field]), text)));
	};
</script>

{#snippet cell(row: Row, col: { field: string; cell?: Snippet<[{ row: Row; value: Json | undefined }]> })}
	{@const value = valueAt(row, col.field)}
	{#if col.cell}{@render col.cell({ row, value })}{:else}<Value {value} kind={kindOf(col.field)} {row} ref={refOf(row, col.field)} name={col.field} dense />{/if}
{/snippet}

{#snippet footer()}
	<footer class="text-muted-foreground flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t px-2 py-1 text-xs" data-table-footer>
		<span class="px-1 tabular-nums" data-range>{range}</span>
		{#if paged}
			<div class="flex items-center gap-1" data-pager>
				<Combobox variant="ghost" class="w-24" size="sm" aria-label={msg(bolt, 'table.pageSize', 'Rows per page')} searchable={false}
					options={SIZES.map((n) => ({ value: String(n), label: msg(bolt, 'table.perPage', '{n} / page', { n }) }))}
					value={String(size)} onChange={(v) => v !== null && setSize(Number(v))} />
				<Button size="icon" variant="ghost" class="size-8 max-sm:size-11" hint={msg(bolt, 'table.prev', 'Previous')} aria-label={msg(bolt, 'table.prev', 'Previous')} disabled={back.length === 0}
					onclick={() => { st = { ...st, after: back.at(-1) ?? null }; back = back.slice(0, -1); }}><Glyph name="left" /></Button>
				<span class="min-w-16 text-center tabular-nums" data-page>{pages === null ? msg(bolt, 'table.page', 'Page {page}', { page: back.length + 1 }) : msg(bolt, 'table.pageOf', 'Page {page} of {pages}', { page: back.length + 1, pages })}</span>
				<Button size="icon" variant="ghost" class="size-8 max-sm:size-11" hint={msg(bolt, 'table.next', 'Next')} aria-label={msg(bolt, 'table.next', 'Next')} disabled={next === null}
					onclick={() => { back = [...back, st.after]; st = { ...st, after: next }; }}><Glyph name="right" /></Button>
			</div>
		{/if}
	</footer>
{/snippet}

{#snippet colItem(text: string, glyph: GlyphName, onclick: () => void, off = false)}
	<button type="button" class="hover:bg-accent flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left disabled:opacity-40" disabled={off} {onclick}>
		<Glyph name={glyph} class="text-muted-foreground size-3.5 shrink-0" />{text}
	</button>
{/snippet}

{#snippet rowActions(row: Row, i: number)}
	{#each actions as a (a.action)}
		<Button size="sm" variant="ghost" onclick={(e: MouseEvent) => { e.stopPropagation(); rowAct(a, row); }}>{a.label ?? humanize(a.action.slice(a.action.lastIndexOf('.') + 1))}</Button>
	{/each}
	{#if kind === 'local' && onChange && remove}
		<Button size="sm" variant="ghost" onclick={() => onChange(removeRow(of as readonly Row[], i))}>{msg(bolt, 'table.remove', 'Remove')}</Button>
	{/if}
{/snippet}

<!-- the view fills a bounded parent (a flex column or a definite height) and scrolls inside its card; it never grows the
     parent past its own minimum. The card: the grid (wide) or the list (narrow), then the footer, pinned at the card's foot. -->
<section class="@container flex h-full min-w-0 flex-1 flex-col gap-2" data-view="table" data-source={kind}>
	<ViewToolbar config={toolbar} {collection} view={canFilter ? vs : undefined} {catalog} {source} author={where} sortable={sorts}
		bind:q={qText} searchable={canSearch} selected={selectable ? [...selected] : undefined} onSettled={() => selected.clear()} {exporter}
		onAdd={kind === 'local' && onChange && add ? () => onChange([...(of as readonly Row[]), add()]) : undefined}
		onProbe={kind === 'collection' ? (p) => { probe = p; restart({}); } : undefined} />
	{#if notice}<p role="status" class="text-muted-foreground text-sm">{notice}</p>{/if}

	<ReadGate state={view} what={collection === '' ? msg(bolt, 'table.rows', 'these rows') : label(bolt, collection)}>
		{#snippet children(rows)}
			{#if rows.length === 0}
				{#if empty}{@render empty()}
				{:else}
					<!-- an empty view says what is missing and offers the way forward, inside the table's own card -->
					{@const what = collection === '' ? msg(bolt, 'table.rows', 'rows') : label(bolt, collection).toLowerCase()}
					<div class="bg-card flex min-h-72 min-w-0 flex-1 flex-col justify-center rounded-md border" data-table-card>
						{#if filtered}
							<EmptyState icon="search" title={msg(bolt, 'table.noMatch', 'No {what} match this search or filter', { what })} hint={msg(bolt, 'table.noMatchHint', 'Try a different search, or clear the filters.')}>
								<Button size="sm" variant="outline" onclick={() => { vs.clear(); qText = ''; }}>{msg(bolt, 'view.clearAll', 'Clear all')}</Button>
							</EmptyState>
						{:else}
							<EmptyState title={msg(bolt, 'table.empty', 'No {what} yet', { what })} hint={canNew ? msg(bolt, 'table.noneHint', 'Create the first one to get started.') : msg(bolt, 'table.emptyHint', 'Nothing has been added here yet.')}>
								{#if canNew}<Button size="sm" onclick={() => typeof tb.new === 'function' ? tb.new() : openRecord(collection, 'new', contexts)}><Glyph name="plus" />{msg(bolt, 'table.new', 'New')}</Button>{/if}
							</EmptyState>
						{/if}
					</div>
				{/if}
			{:else}
				<div class="bg-card flex max-h-[calc(100dvh-8rem)] min-h-72 min-w-0 flex-1 flex-col rounded-md border" data-table-card>
					<!-- its own scroll port (staging's grid): the grey header sticks, pinned columns stay while the rest scrolls sideways -->
					<div class={['min-h-0 flex-1 overflow-auto rounded-t-md', !(kind === 'local' && onChange) && 'hidden @3xl:block']} data-table-wide>
						<table class="w-full border-separate border-spacing-0 text-xs [&_td]:h-9 [&_td]:border-b [&_td]:px-3 [&_td]:py-0 [&_td]:whitespace-nowrap [&_td:not(:last-child)]:border-r [&_th]:h-9 [&_th]:border-b [&_th]:px-3 [&_th]:text-left [&_th]:text-[13px] [&_th]:font-medium [&_th:not(:last-child)]:border-r">
							<thead class="bg-muted sticky top-0 z-20">
								<tr>
									{#if selectable}
										<th class="bg-muted sticky left-0 z-10 w-8 px-2!"><input type="checkbox" aria-label={msg(bolt, 'table.selectAll', 'Select all')} checked={rows.every((r) => selected.has(String(r['id'])))}
											onchange={(e) => { for (const r of rows) e.currentTarget.checked ? selected.add(String(r['id'])) : selected.delete(String(r['id'])); }} /></th>
									{/if}
									{#each ordered as c, ci (colOf(c).field)}
										{@const f = colOf(c).field}
										{@const isPinned = ci < pinCount}
										<!-- drag a header onto another to move it (the column menu moves it by keyboard); sorting is the toolbar's -->
										<th class={['group bg-muted relative', isPinned && 'sticky z-10', isPinned && ci === pinCount - 1 && PIN_EDGE, numeric(f) && 'text-right']}
											style={[sized(widthOf(c)), isPinned ? `left:${leftOf(ci)}px` : ''].filter(Boolean).join(';') || undefined}
											draggable="true" data-column={f}
											ondragstart={(e) => { dragging = f; e.dataTransfer?.setData('text/x-bolt-column', f); }}
											ondragend={() => (dragging = null)}
											ondragover={(e) => { if (dragging !== null) e.preventDefault(); }}
											ondrop={(e) => { e.preventDefault(); if (dragging !== null) moveColumn(dragging, f); dragging = null; }}
											{@attach measure(f)}>
											<span class={['flex min-w-0 items-center gap-1', numeric(f) && 'justify-end']}>
												<span class="truncate whitespace-nowrap">{colLabel(c)}</span>
												{#if isPinned}<Glyph name="pin" class="text-muted-foreground size-3 shrink-0" />{/if}
												<Popover.Root>
													<Popover.Trigger class={['text-muted-foreground hover:bg-background hover:text-foreground ml-auto grid size-6 shrink-0 place-items-center rounded-sm transition-opacity focus-visible:opacity-100 data-[state=open]:opacity-100', 'opacity-0 group-hover:opacity-100']}
														aria-label={msg(bolt, 'table.columnMenu', 'Column options for {column}', { column: colLabel(c) })} data-column-menu={f}><Glyph name="more" class="size-3.5" /></Popover.Trigger>
													<Popover.Content align="start" class="flex w-52 flex-col gap-0.5 p-1.5 text-xs font-normal">
														{@render colItem(isPinned ? msg(bolt, 'table.unpin', 'Unpin column') : msg(bolt, 'table.pin', 'Pin column'), 'pin', () => togglePin(f))}
														{@render colItem(msg(bolt, 'table.hideColumn', 'Hide column'), 'eyeOff', () => toggleHidden(f), ordered.length === 1)}
														{@render colItem(msg(bolt, 'table.moveLeft', 'Move left'), 'left', () => moveColumn(f, -1), ci === 0)}
														{@render colItem(msg(bolt, 'table.moveRight', 'Move right'), 'right', () => moveColumn(f, 1), ci === ordered.length - 1)}
														{#if widths[f] !== undefined}{@render colItem(msg(bolt, 'table.resetWidth', 'Reset width'), 'sync', () => { const { [f]: _, ...rest } = widths; widths = rest; keep(); })}{/if}
														{#if hiddenCols.length > 0}
															<p class="text-muted-foreground mt-1 border-t px-2 pt-2 pb-1 font-medium">{msg(bolt, 'table.hiddenColumns', 'Hidden columns')}</p>
															{#each hiddenCols as h (colOf(h).field)}{@render colItem(colLabel(h), 'eye', () => toggleHidden(colOf(h).field))}{/each}
														{/if}
													</Popover.Content>
												</Popover.Root>
											</span>
											<!-- the resize handle: drag the column's right edge -->
											<span role="separator" aria-orientation="vertical" aria-label={msg(bolt, 'table.resize', 'Resize column')} data-column-resize
												class="group/resize absolute inset-y-0 -right-1 z-10 flex w-2 cursor-col-resize touch-none justify-center select-none" onpointerdown={(e) => resize(e, f)}>
												<span class="bg-muted-foreground/40 group-hover/resize:bg-brand my-auto h-5 w-px opacity-0 transition-opacity group-hover:opacity-100 group-hover/resize:w-0.5"></span>
											</span>
										</th>
									{/each}
									{#if actions.length > 0 || (kind === 'local' && onChange && remove)}<th></th>{/if}
								</tr>
							</thead>
							<tbody>
								{#if wide.on}<tr aria-hidden="true" {@attach wide.anchor}><td colspan={span} style="height:{wide.before}px;padding:0;border:0"></td></tr>{/if}
								{#each wide.slice(rows) as row, j (row['id'] ?? wide.start + j)}
									{@const i = wide.start + j}
									<tr class="group/row hover:[&>td]:bg-[color-mix(in_oklab,var(--color-muted)_50%,var(--color-card))]" {@attach wide.measure(rowKey(i))}>
										{#if selectable}
											<td class="bg-card sticky left-0 z-[1] px-2!">
												{#if held(row)}<span class="bg-brand absolute inset-y-1 left-0 w-1 rounded-r-full" title={msg(bolt, 'record.pending', 'Pending review')} aria-hidden="true"></span>{/if}
												<input type="checkbox" aria-label={msg(bolt, 'table.select', 'Select')} checked={selected.has(String(row['id']))} onchange={(e) => e.currentTarget.checked ? selected.add(String(row['id'])) : selected.delete(String(row['id']))} />
											</td>
										{/if}
										{#each ordered as c, ci (colOf(c).field)}
											{@const col = colOf(c)}
											{@const w = widthOf(c)}
											{@const isPinned = ci < pinCount}
											<td class={['bg-card', isPinned ? 'sticky z-[1]' : ci === 0 && 'relative', isPinned && ci === pinCount - 1 && PIN_EDGE, numeric(col.field) && 'text-right tabular-nums']}
												style={[sized(w), isPinned ? `left:${leftOf(ci)}px` : ''].filter(Boolean).join(';') || undefined}>
												{#if ci === 0 && !selectable && held(row)}<span class="bg-brand absolute inset-y-1 left-0 w-1 rounded-r-full" title={msg(bolt, 'record.pending', 'Pending review')} aria-hidden="true"></span>{/if}
												{#if kind === 'local' && onChange && col.edit && !col.cell}
													{@const value = valueAt(row, col.field)}
													<input class="border-input h-7 w-full rounded-sm border px-1" type={typeof plain(value) === 'number' ? 'number' : 'text'}
														value={String(plain(value) ?? '')} onchange={(e) => edit(i, col.field, e.currentTarget.value)} />
												{:else}
													<!-- one line: a long value truncates, its full text is the tooltip -->
													<div class={['truncate', w === undefined && 'max-w-80', ci === 0 && opens && 'pr-7']} title={fullText(row, col.field) || undefined}>{@render cell(row, col)}</div>
												{/if}
												{#if ci === 0 && opens}
													<!-- the open button (staging's expand): shown on hover or focus; a click on a cell itself opens nothing -->
													<button type="button" class="bg-card text-muted-foreground hover:text-foreground hover:bg-accent focus-visible:ring-ring absolute top-1/2 right-1 grid size-6 -translate-y-1/2 place-items-center rounded-sm border opacity-0 shadow-xs outline-none group-hover/row:opacity-100 focus-visible:opacity-100 focus-visible:ring-2"
														aria-label={msg(bolt, 'table.openRow', 'Open')} title={msg(bolt, 'table.openRow', 'Open')} onclick={() => open(row)} data-row-open><Glyph name="expand" class="size-3.5" /></button>
												{/if}
											</td>
										{/each}
										{#if actions.length > 0 || (kind === 'local' && onChange && remove)}
											<td class="bg-card">{@render rowActions(row, i)}</td>
										{/if}
									</tr>
								{/each}
								{#if wide.after > 0}<tr aria-hidden="true"><td colspan={span} style="height:{wide.after}px;padding:0;border:0"></td></tr>{/if}
							</tbody>
						</table>
					</div>
					{#if !(kind === 'local' && onChange)}
						<ul class="min-h-0 flex-1 divide-y overflow-auto rounded-t-md @3xl:hidden" data-table-list>
							{#if narrow.on}<li aria-hidden="true" style="height:{narrow.before}px" {@attach narrow.anchor}></li>{/if}
							{#each narrow.slice(rows) as row, j (row['id'] ?? narrow.start + j)}
								{@const i = narrow.start + j}
								{@const [lead, ...rest] = ordered.map(colOf).filter((c) => c.hide !== 'narrow')}
								<li class={['relative flex min-w-0 items-start gap-2 px-3 py-2.5 transition-colors', selected.has(String(row['id'])) ? 'bg-accent/40' : 'hover:bg-muted/40']} {@attach narrow.measure(rowKey(i))}>
									<!-- a held row's leading accent and pill (staging's record metadata): it is going through approval -->
									{#if held(row)}<span class="bg-brand absolute inset-y-1 left-0 w-1 rounded-r-full" title={msg(bolt, 'record.pending', 'Pending review')} aria-hidden="true"></span>{/if}
									{#if selectable}
										<input class="mt-1" type="checkbox" aria-label={msg(bolt, 'table.select', 'Select')} checked={selected.has(String(row['id']))}
											onchange={(e) => e.currentTarget.checked ? selected.add(String(row['id'])) : selected.delete(String(row['id']))} />
									{/if}
									<!-- a phone has no hover: the card itself opens the record; not a <button>, so a relation's link inside
									     receives its own tap (it opens the related record) -->
									<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_static_element_interactions -->
									<div role={opens ? 'button' : undefined} tabindex={opens ? 0 : undefined} class="flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5 text-left" data-row-card
										onclick={(e) => { if (opens && !(e.target as Element).closest('a, button, [role=dialog]')) open(row); }}
										onkeydown={(e) => { if (opens && e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); open(row); } }}>
										{#if lead}<span class="truncate text-sm font-medium">{@render cell(row, lead)}</span>{/if}
										{#if rest.length > 0}
											<span class="text-muted-foreground flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
												{#each rest.slice(0, 4) as c (c.field)}
													<span class="inline-flex min-w-0 gap-1"><span class="shrink-0">{colLabel(c)}</span><span class="text-foreground/80 min-w-0 truncate">{@render cell(row, c)}</span></span>
												{/each}
												{#if rest.length > 4}<span>{msg(bolt, 'table.moreFields', '+{n} fields', { n: rest.length - 4 })}</span>{/if}
											</span>
										{/if}
									</div>
									{#if held(row)}<span class="border-brand/30 bg-brand/10 text-brand my-auto shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium">{msg(bolt, 'record.pending', 'Pending review')}</span>{/if}
									{#if actions.length > 0}<div class="flex shrink-0 flex-wrap justify-end">{@render rowActions(row, i)}</div>{/if}
								</li>
							{/each}
							{#if narrow.after > 0}<li aria-hidden="true" style="height:{narrow.after}px"></li>{/if}
						</ul>
					{/if}
					{@render footer()}
				</div>
			{/if}
		{/snippet}
	</ReadGate>
</section>
