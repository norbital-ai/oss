<script lang="ts" module>
	import type { Snippet } from 'svelte';
	import { Effect, Result, Schema } from 'effect';
	const Strings = Schema.mutable(Schema.Array(Schema.String));
	const Layout = Schema.Struct({
		pinned: Schema.optionalKey(Strings),
		widths: Schema.optionalKey(Schema.Record(Schema.String, Schema.Number)),
		size: Schema.optionalKey(Schema.Number),
		order: Schema.optionalKey(Strings),
		hidden: Schema.optionalKey(Strings)
	});
	interface Layout extends Schema.Schema.Type<typeof Layout> {}
	const decodeLayout = Schema.decodeUnknownResult(Schema.fromJsonString(Layout));
	import type {
		ModelKey,
		ManyOf,
		Page,
		OrderByOf,
		RecordOf,
		Row,
		RowOf,
		Values,
		WhereOf
	} from '../model/types.js';
	import type { Json, Query, QueryAnswer } from '../client/contract.js';
	import type { OrderBy, Where } from '../filter/filter.js';
	import type { Toolbar, ToolbarItem } from '../model/ViewToolbar.svelte';
	import type { Kind } from '../kinds/kind.js';

	type TableData<R extends Values> = Page<R> | readonly R[];
	/** A table's source: a model name, a native `bolt.query` read request of one root, or a local row array. */
	export type TableSource<R extends Values = Values> =
		ModelKey | Query<{ readonly [root: string]: TableData<R> }> | readonly R[];
	type PageRow<T> = T extends { readonly rows: readonly (infer R extends Values)[] }
		? R
		: T extends readonly (infer R extends Values)[]
			? R
			: Values;
	/** The row a source yields: the model's caller row, the read's rows, or the array's element. */
	export type RowIn<S> = S extends string
		? RowOf<S> & Values
		: S extends Query<infer T>
			? PageRow<T[keyof T]>
			: S extends readonly (infer R extends Values)[]
				? R
				: Values;
	/** The fields a column may name: a model's whole record (a heavy field is then read) and its many-relations (the
	 * related records, each `{ id, …label }`), else the row's. */
	export type ColumnsIn<S> = S extends string
		? RecordOf<S> & { readonly [M in ManyOf<S>]: readonly Row[] }
		: RowIn<S>;
	type ColumnDefinition<R, K, F extends keyof K & string> = {
		field: F;
		/** The value's declared kind, including numeric scale, for authored value columns. */
		kind?: Kind;
		label?: string;
		description?: string;
		width?: number;
		hide?: 'narrow';
		edit?: true;
		align?: 'start' | 'end';
		cell?: Snippet<[{ row: R; value: K[F] | undefined; field: F }]>;
	};
	/**
	 * A column's field name or configuration, preserving that field's type in a custom cell snippet.
	 * Without a custom cell, the kind renderer shows scalar values and relations show their target labels.
	 */
	export type Col<R = Row, K = R> = {
		[F in keyof K & string]: F | ColumnDefinition<R, K, F>;
	}[keyof K & string];
	/** A row's labelled native handler, optionally confirmed before it runs. */
	export type RowAction<R = Row> = {
		label: string;
		confirm?: string;
		run: (row: R) => Effect.Effect<unknown, Error> | void;
	};
	/** Typed by the source `of` names, including the native row and authored column field types. */
	export type TableProps<S = TableSource, R extends Values = RowIn<S>, K = ColumnsIn<S>> = {
		of: S & TableSource<R & Partial<K>>;
		columns: readonly Col<R, K>[];
		/** The author's fixed scope: ANDed under every viewer filter, shown read-only in the view popover, never clearable. */
		where?: S extends string ? WhereOf<S> : Where;
		/** Seed rows of the view popover the viewer may edit or clear; a cleared choice is kept in the URL. */
		initialFilter?: S extends string ? WhereOf<S> : Where;
		/** The initial sort; a viewer's sort replaces it and clearing restores it. */
		orderBy?: S extends string ? OrderByOf<S> : OrderBy;
		pageSize?: 10 | 25 | 50 | 100 | 200;
		/** Financial reports retain a horizontally scrollable grid on narrow screens. */
		layout?: 'responsive' | 'grid';
		/** The chrome: title, description, search, filter and sort, the actions menu and New (`ViewToolbar`). */
		toolbar?: Toolbar<R>;
		/** A host-backed page may supply its own cursor controls in place of the default range and pager. */
		footer?: Snippet;
		/** For a supplied row array, the caller owns filtering, sorting and paging; display those rows verbatim. */
		controlled?: boolean;
		/** A controlled local matrix inside another surface: content height, no card, toolbar or footer. */
		embedded?: boolean;
		/** Semantic row treatment, shared by the grid and narrow layout. */
		rowClass?: (row: R) => string | undefined;
		/** An action revealed on row hover or keyboard focus, inside the final displayed cell. */
		rowTrailing?: Snippet<[R]>;
		actions?: readonly RowAction<R>[];
		/** The URL parameter prefix; defaults to the source's name. */
		key?: string;
		empty?: Snippet;
		onOpen?: (row: R) => void;
		/** Local arrays only: editable when given; each change is a fresh array. */
		onChange?: (next: R[]) => void;
		add?: () => R;
		remove?: boolean;
	};
	const localSource = <R extends Values>(value: TableSource<R>): value is readonly R[] =>
		Array.isArray(value);
	const tableInput = <R extends Values>(value: TableSource<R>) => {
		if (typeof value === 'string') return { _tag: 'model' as const, name: value };
		if (localSource(value)) return { _tag: 'local' as const, rows: value };
		return { _tag: 'read' as const, read: value };
	};
	const tableRows = <R extends Values>(value: TableData<R>): readonly R[] => {
		const array = (value: TableData<R>): value is readonly R[] => Array.isArray(value);
		return array(value) ? value : value.rows;
	};
</script>

<script lang="ts" generics="S extends TableSource">
	import { formatValue as show } from '../kinds/kind.js';
	import { fork } from '../effect/index.js';
	import { getAllContexts, onDestroy, untrack } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { Debounced, watch as onChange_ } from 'runed';
	import { Button } from '../primitives/button/index.js';
	import { confirmAction } from '../primitives/dialog/confirm.js';
	import * as Popover from '../primitives/popover/index.js';
	import Tooltip from '../primitives/tooltip/tooltip.svelte';
	import Combobox from '../primitives/combobox/combobox.svelte';
	import { virtualList } from '../primitives/virtual/virtual.svelte.js';
	import { useKinds } from '../kinds/context.js';
	import { likeWhere } from '../kinds/kind.js';
	import { KINDS } from '../kinds/registry.js';
	import { openRecord } from '../record/navigation.js';
	import { provideModel } from '../model/context.js';
	import { useOptionalBolt } from '../client/context.js';
	import type { ViewBolt } from '../client/contract.js';
	import EmptyState from '../primitives/empty-state/EmptyState.svelte';
	import Glyph, { type GlyphName } from '../primitives/icon/Glyph.svelte';
	import { toast } from '../toast/toast.svelte.js';
	import { localExposure, matches, orderOf, sortable, sortRows } from '../filter/filter.js';
	import { and, compact } from '../filter/scope.js';
	import { pageRead } from '../read/paging.js';
	import { like, valueAt } from '../cell/value.js';
	import { humanize, label, lowerLead, msg } from '../text/messages.js';
	import { listRequest, refOf, unref } from '../relations/select.js';
	import { pageOf, READ_LIMIT, requestJson, rootsOf } from '../read/request.js';
	import {
		rangeText,
		readTableState,
		searchRows,
		writeTableState,
		type TableState
	} from './model.js';
	import { mapped, queryState, type Reading, type ReadState } from '../read/state.js';
	import { viewState } from '../filter/view-state.svelte.js';
	import ViewToolbar, { selectionEnabled } from '../model/ViewToolbar.svelte';
	import ReadGate from '../read/ReadGate.svelte';
	import Value from '../cell/Value.svelte';
	import Overflow from '../cell/Overflow.svelte';
	import ApprovalAccent from '../approval/ApprovalAccent.svelte';
	import { approvalOf, approvalText } from '../approval/row.js';

	let {
		of,
		columns,
		where,
		initialFilter,
		orderBy,
		pageSize = 25,
		layout = 'responsive',
		toolbar = {},
		footer: customFooter,
		controlled = false,
		embedded = false,
		rowClass,
		rowTrailing,
		actions = [],
		key,
		empty,
		onOpen,
		onChange,
		add,
		remove
	}: TableProps<S, RowIn<S>, ColumnsIn<S>> = $props();
	const client = useOptionalBolt();
	if (client === undefined && !untrack(() => embedded && controlled && localSource(of)))
		throw new Error('A view needs the shell: call provideBolt(bolt) above it.');
	const host = () => {
		if (client === undefined) throw new Error('A remote table needs the shell.');
		return client;
	};
	const text: Pick<ViewBolt, 't'> = client ?? { t: (key) => key };
	const kinds = useKinds();

	type ReadRow = RowIn<S> & Partial<ColumnsIn<S>>;
	const tableSource = $derived(tableInput<ReadRow>(of));
	const kind = $derived(tableSource._tag === 'read' ? 'q' : tableSource._tag);
	const name = $derived(tableSource._tag === 'model' ? tableSource.name : '');
	const model = $derived(
		tableSource._tag === 'model'
			? tableSource.name
			: tableSource._tag === 'read'
				? (rootsOf(tableSource.read.read)[0] ?? '')
				: ''
	);

	const urlKey = $derived(key ?? (name || model || 'rows'));
	const fields = $derived(columns.map((c) => (typeof c === 'string' ? c : c.field)));
	type Column = Col<RowIn<S>, ColumnsIn<S>>;
	const colOf = <F extends keyof ColumnsIn<S> & string>(
		c: F | ColumnDefinition<RowIn<S>, ColumnsIn<S>, F>
	): ColumnDefinition<RowIn<S>, ColumnsIn<S>, F> => (typeof c === 'string' ? { field: c } : c);
	// a relation column (a FK or a many-relation) without an authored `cell` shows its targets' labels, read with the page
	// in the same statement (kind `model` only)
	const refs = $derived(
		kind === 'model'
			? columns.filter((c) => colOf(c).cell === undefined).map((c) => colOf(c).field)
			: []
	);
	const tb = $derived(toolbar === false ? {} : toolbar);
	// search where the model declares search fields (rule 16), else `like` over its label's text fields, or over a
	// local array's columns, or through `search.semantic` or a search index (the toolbar's `/<name>`)
	const exposed = $derived(kinds.catalog?.[model]);
	const indexed = $derived((exposed?.search?.length ?? 0) > 0);
	const byLabel = (q: string) =>
		indexed ? undefined : likeWhere(exposed, exposed?.label ?? [], q);
	const canSearch = $derived(
		!controlled &&
			(kind === 'local' ||
				(kind === 'model' &&
					(indexed ||
						byLabel('x') !== undefined ||
						exposed?.semantic === true ||
						exposed?.indexes !== undefined)))
	);
	const kindOf = (f: string) => {
		const column = columns.find((c) => colOf(c).field === f);
		return (
			(column === undefined ? undefined : colOf(column).kind) ?? kinds.catalog?.[model]?.fields[f]
		);
	};
	const columnKinds = $derived.by(() => {
		const declared: Record<string, Kind> = {};
		for (const field of fields) {
			const kind = kindOf(field);
			if (kind !== undefined) declared[field] = kind;
		}
		return declared;
	});
	/** A number column reads right-aligned in tabular figures . */
	const numeric = (f: string) => {
		const column = columns.find((c) => colOf(c).field === f),
			fieldKind = kindOf(f);
		return (
			(column !== undefined && colOf(column).align === 'end') ||
			(fieldKind !== undefined && KINDS[fieldKind.kind].numeric)
		);
	};
	const colLabel = (c: Column) => colOf(c).label ?? fieldLabel(colOf(c).field);
	const fieldLabel = (f: string) =>
		model === '' ? (kindOf(f)?.label ?? humanize(f)) : label(text, model, f, kindOf(f)?.label);
	// the cells' enum and state words read this model's catalog keys
	provideModel(() => model);
	const canFilter = $derived(!controlled && (kind === 'model' || kind === 'local'));
	// the view popover's catalog: the caller's exposure, or a local array's columns (kinds from its values)
	const LOCAL = '$local';
	const source = $derived(kind === 'local' ? LOCAL : model);
	const catalog = $derived(
		kind === 'local'
			? {
					[LOCAL]: localExposure(
						tableSource._tag === 'local' ? tableSource.rows : [],
						fields,
						(f) => fieldLabel(f)
					)
				}
			: kinds.catalog?.[model] !== undefined
				? kinds.catalog
				: { ...kinds.catalog, [model]: localExposure([], fields, (f) => fieldLabel(f)) }
	);
	const sorts = $derived(
		!controlled && (kind === 'model' || kind === 'local')
			? sortable(catalog[source], kind !== 'local', catalog)
			: []
	);
	const vs = viewState(client, {
		key: () => urlKey,
		model: () => source,
		catalog: () => catalog,
		initialFilter: () => initialFilter,
		enabled: () => !controlled
	});
	// Local projections can drive bulk actions only when each row names a distinct, stable record.
	const localIds = $derived(
		kind === 'local'
			? (tableSource._tag === 'local' ? tableSource.rows : []).map((row) => row['id'])
			: []
	);
	const identified = $derived(
		kind !== 'local' ||
			(localIds.every((id) => typeof id === 'string' && id.trim() !== '') &&
				new Set(localIds).size === localIds.length)
	);
	const selectable = $derived(identified && selectionEnabled(toolbar, exposed));
	const contexts = getAllContexts(); // a New's sheet mounts outside the page; the page's create scope rides along
	const canNew = $derived(
		tb.new !== false &&
			kind === 'model' &&
			(typeof tb.new === 'function' || kinds.catalog?.[model]?.create !== undefined)
	);

	// ── the viewer's columns : order, widths, hidden and pinned columns, and the page size, kept per table in
	// this browser ; pinned columns lead and stay put ──
	const LAYOUT = $derived(`ui.table.${urlKey}`);
	const initialLayout: Layout = untrack(() =>
		Result.getOrElse(
			Result.flatMap(
				Result.try(() => localStorage.getItem(LAYOUT) ?? '{}'),
				decodeLayout
			),
			(): Layout => ({})
		)
	);
	let pinned = $state<string[]>(initialLayout.pinned ?? []);
	let widths = $state<{ [f: string]: number }>(initialLayout.widths ?? {});
	let arranged = $state<string[]>(initialLayout.order ?? []);
	let hidden = $state<string[]>(initialLayout.hidden ?? []);
	// the viewer's page size (the footer's select), kept with the layout; the author's `pageSize` is the default
	const SIZES = [10, 25, 50, 100, 200] as const;
	let size = $state<number>(untrack(() => SIZES.find((n) => n === initialLayout.size) ?? pageSize));
	const keep = () => {
		Result.getOrElse(
			Result.try(() =>
				localStorage.setItem(
					LAYOUT,
					JSON.stringify({ pinned, widths, size, order: arranged, hidden } satisfies Layout)
				)
			),
			() => undefined
		);
	};
	// ── view state in the URL (rule 8) ──
	const params = () =>
		typeof location === 'undefined' ? new URLSearchParams() : new URL(location.href).searchParams;
	let st = $state<TableState>(
		untrack(() => (controlled ? { after: null, q: '' } : readTableState(params(), urlKey)))
	);
	let back = $state<(string | null)[]>([]);
	let qText = $state(untrack(() => st.q));
	// a search index the toolbar runs (`/<index>` and its input): its nearest rows, in its order, in place of the page
	let probe = $state<{ index: string; input: Json } | null>(null);
	let notice = $state<string | null>(null);
	$effect(() => {
		if (controlled) return;
		const next = writeTableState(params(), urlKey, st);
		if (typeof location !== 'undefined')
			history.replaceState(
				history.state,
				'',
				`${location.pathname}${next.size > 0 ? `?${next}` : ''}${location.hash}`
			);
	});
	const debouncedSearch = new Debounced(() => qText, 300);
	onDestroy(debouncedSearch.cancel);
	onChange_(
		() => debouncedSearch.current,
		(q) => {
			if (q !== st.q) ((st = { ...st, q, after: null }), (back = []));
		}
	);
	const restart = (patch: Partial<TableState>) => {
		st = { ...st, ...patch, after: null };
		back = [];
		selected.clear();
	};
	// a new filter or sort starts from the first page
	onChange_(
		() => [vs.where, vs.order],
		() => restart({}),
		{ lazy: true }
	);

	// ── the page (rule 7: cursor-only, live) ──
	const scope = $derived(and(where, vs.where));
	const order = $derived(vs.order.length > 0 ? orderOf(vs.order) : orderBy);
	/** The page's search: the declared index's `search`, else a `where` over the label fields. */
	const searched = $derived(
		indexed
			? { where: scope, search: st.q || undefined }
			: { where: and(scope, byLabel(st.q)), search: undefined }
	);
	const page = $derived.by((): Reading<TableData<ReadRow>> | null => {
		const after = st.after ?? undefined;
		if (kind === 'model' && probe !== null)
			return mapped(
				host().query<QueryAnswer<ReadRow>>(
					requestJson(
						listRequest(
							kinds.catalog,
							name,
							{ search: { [probe.index]: probe.input }, where: scope, limit: size },
							fields,
							refs
						)
					)
				),
				(answer) => pageOf(answer, name)
			);
		// hook:agent-ui — a later page stays live (its index is the pages behind it; a cursor restored from the URL has none)
		if (kind === 'model')
			return pageRead(
				name,
				(limit, at) =>
					host().query<QueryAnswer<ReadRow>>(
						requestJson(
							listRequest(
								kinds.catalog,
								name,
								{ ...searched, orderBy: order, limit, after: at },
								fields,
								refs
							)
						)
					),
				size,
				back.length > 0 ? back.length : null,
				after
			);
		if (tableSource._tag === 'read')
			return mapped(tableSource.read, (answer) => answer[model] ?? []);
		return null;
	});
	const pageState = $derived(queryState(page));
	$effect(() => {
		const s = pageState;
		if (s.kind === 'error' && s.code === 'badCursor')
			untrack(() => {
				notice = msg(
					text,
					'table.badCursor',
					'That page is no longer available; showing the first page.'
				);
				restart({});
			});
	});
	const local = $derived(
		kind === 'local'
			? controlled
				? tableSource._tag === 'local'
					? tableSource.rows
					: []
				: sortRows(
						searchRows(tableSource._tag === 'local' ? tableSource.rows : [], st.q, fields).filter(
							(r) => matches(r, { t: 'group', join: 'and', of: vs.rows })
						),
						vs.order
					)
			: []
	);
	const view: ReadState<readonly ReadRow[]> = $derived(
		kind === 'local'
			? { kind: 'ready', value: local }
			: pageState.kind === 'ready'
				? {
						kind: 'ready',
						value: tableRows(pageState.value)
					}
				: pageState
	);
	const next = $derived(
		pageState.kind === 'ready' && 'next' in pageState.value ? pageState.value.next : null
	);
	// a long page (pageSize 100/200, a local grid) renders a window of rows, one per layout, measured and keyed by id
	const shownRows = $derived(view.kind === 'ready' ? view.value : []);
	const presented = $derived(
		new Map(
			shownRows.map<[ReadRow, Values]>((row) => [
				row,
				typeof row['id'] === 'string'
					? (unref(kinds.catalog, model, refs, [row], client?.locale)[0] ?? row)
					: row
			])
		)
	);
	const rowKey = (index: number) => {
		const id = shownRows[index]?.['id'];
		return typeof id === 'string' ? id : String(index);
	};
	const wide = virtualList({ count: () => shownRows.length, key: rowKey, estimate: 37 });
	const narrow = virtualList({ count: () => shownRows.length, key: rowKey, estimate: 64 });

	// ── the count: the page read's `total` (every row the scope and search match); an index search has none ──
	let lastTotal: number | null = null;
	const count = $derived.by(() => {
		if (kind !== 'model' || probe !== null) return null;
		if (pageState.kind !== 'ready') return pageState.kind === 'loading' ? lastTotal : null;
		const value = pageState.value;
		const total = 'next' in value ? value.total : undefined;
		lastTotal = total ?? null;
		return lastTotal;
	});

	// ── selection and row actions (the toolbar runs its own) ──
	type SelectedId = Parameters<ToolbarItem<RowIn<S>>['run']>[0][number];
	const selected = new SvelteSet<SelectedId>();
	// select-all: the page's rows, then (once the page is all selected) every row the scope and search match
	const recordRow = <R extends RowIn<S>>(row: R): row is R & { readonly id: SelectedId } =>
		typeof row['id'] === 'string' && row['id'].trim() !== '';
	const onPage = (rows: readonly RowIn<S>[]) => rows.filter(recordRow).map((r) => r.id);
	const pageAll = (rows: readonly RowIn<S>[]) =>
		rows.length > 0 && rows.every((r) => recordRow(r) && selected.has(r.id));
	const togglePage = (rows: readonly RowIn<S>[], on: boolean) => {
		for (const id of onPage(rows)) on ? selected.add(id) : selected.delete(id);
	};
	const matching = $derived(
		kind === 'local' ? local.length : kind === 'model' && probe === null ? count : null
	);
	let selecting = $state(false);
	function selectMatching() {
		if (kind === 'local') return void local.filter(recordRow).forEach((r) => selected.add(r.id));
		selecting = true;
		fork(
			host()
				.query<QueryAnswer<RowIn<S>>>(
					requestJson({ [name]: { ...searched, fields: [], limit: READ_LIMIT } })
				)
				.pipe(
					Effect.tap((answer) =>
						Effect.sync(() => {
							for (const row of (answer[name]?.rows ?? []).filter(recordRow)) selected.add(row.id);
						})
					),
					Effect.catch((error) =>
						Effect.sync(() => {
							notice = error.message;
						})
					),
					Effect.ensuring(
						Effect.sync(() => {
							selecting = false;
						})
					)
				)
		);
	}
	function rowAct(a: RowAction<RowIn<S>>, row: RowIn<S>) {
		const asked =
			a.confirm === undefined
				? Effect.succeed(true)
				: confirmAction({ title: a.confirm, confirmLabel: a.label });
		fork(
			asked.pipe(
				Effect.flatMap((confirmed) =>
					confirmed
						? Effect.try({
								try: () => a.run(row),
								catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause)))
							}).pipe(
								Effect.flatMap((output) => (output === undefined ? Effect.void : output)),
								Effect.asVoid
							)
						: Effect.void
				)
			),
			(error) => toast.error(text.t(error.message))
		);
	}
	// the toolbar's CSV: every row of the current scope, search and sort, over the view's columns
	const exporter = $derived(
		kind === 'model'
			? {
					fields,
					labels: columns.map(colLabel),
					kinds: columnKinds,
					read: () =>
						host()
							.query(
								requestJson(
									listRequest(
										kinds.catalog,
										name,
										{ ...searched, orderBy: order, limit: READ_LIMIT },
										fields,
										refs,
										true
									)
								)
							)
							.pipe(Effect.map((answer) => pageOf(answer, name)?.rows ?? []))
				}
			: kind === 'local' && tb.export === true
				? {
						fields,
						labels: columns.map(colLabel),
						kinds: columnKinds,
						read: () => Effect.succeed(local)
					}
				: undefined
	);
	// the footer : the range, the page size, "page X of Y" and previous/next over the cursor
	const paged = $derived(kind === 'model');
	const range = $derived(
		view.kind !== 'ready'
			? null
			: rangeText(text, back.length * size, view.value.length, paged ? count : view.value.length)
	);
	const pages = $derived(count === null || !paged ? null : Math.max(1, Math.ceil(count / size)));
	const setSize = (n: number) => {
		size = n;
		keep();
		restart({});
	};
	const filtered = $derived(st.q !== '' || probe !== null || vs.rows.length > 0);

	const togglePin = (f: string) => {
		pinned = pinned.includes(f) ? pinned.filter((x) => x !== f) : [...pinned, f];
		keep();
	};
	const toggleHidden = (f: string) => {
		hidden = hidden.includes(f) ? hidden.filter((x) => x !== f) : [...hidden, f];
		keep();
	};
	// the viewer's order over the authored columns (a column the author added since keeps its place at the end)
	const rank = (f: string) => {
		const i = arranged.indexOf(f);
		return i < 0 ? arranged.length + fields.indexOf(f) : i;
	};
	const arrangedCols = $derived(
		[...columns].sort((a, b) => rank(colOf(a).field) - rank(colOf(b).field))
	);
	const ordered = $derived(
		[
			...arrangedCols.filter((c) => pinned.includes(colOf(c).field)),
			...arrangedCols.filter((c) => !pinned.includes(colOf(c).field))
		].filter((c) => !hidden.includes(colOf(c).field))
	);
	const hiddenCols = $derived(columns.filter((c) => hidden.includes(colOf(c).field)));
	const pinCount = $derived(ordered.filter((c) => pinned.includes(colOf(c).field)).length);
	const span = $derived(
		ordered.length +
			(selectable ? 1 : 0) +
			(actions.length > 0 || (kind === 'local' && onChange && remove) ? 1 : 0)
	);
	/** Moves column `f` to `to`'s place (a drag onto a header), or one step (`±1`, the column menu's keyboard way). */
	function moveColumn(f: string, to: string | -1 | 1) {
		const now: string[] = ordered.map((c) => colOf(c).field),
			from = now.indexOf(f);
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
		const ro = new ResizeObserver(() => {
			if (measured[f] !== el.offsetWidth) measured[f] = el.offsetWidth;
		});
		ro.observe(el);
		return () => ro.disconnect();
	};
	const leftOf = (i: number) =>
		(selectable ? 32 : 0) +
		ordered.slice(0, i).reduce((n, c) => n + (measured[colOf(c).field] ?? 0), 0);
	const widthOf = (c: Column) => widths[colOf(c).field] ?? colOf(c).width;
	const sized = (w: number | undefined) =>
		w === undefined ? undefined : `width:${w}px;min-width:${w}px;max-width:${w}px`;
	function resize(e: PointerEvent, f: string) {
		const th = (e.currentTarget as HTMLElement).parentElement!,
			x0 = e.clientX,
			w0 = th.offsetWidth;
		const move = (m: PointerEvent) => {
			widths = { ...widths, [f]: Math.max(64, Math.round(w0 + m.clientX - x0)) };
		};
		const up = () => {
			removeEventListener('pointermove', move);
			removeEventListener('pointerup', up);
			document.body.style.cursor = '';
			keep();
		};
		e.preventDefault();
		document.body.style.cursor = 'col-resize';
		addEventListener('pointermove', move);
		addEventListener('pointerup', up);
	}
	/** A native scroll bar mirroring the port on one axis. The port's own bars are hidden, so the vertical one starts
	 * under the sticky header in every engine (a scrollbar-track margin is Chrome's alone). */
	const rail = (axis: 'x' | 'y') => (bar: HTMLElement) => {
		const port = bar.parentElement?.querySelector<HTMLElement>('[data-table-wide]');
		const fill = bar.firstElementChild;
		if (!port || !(fill instanceof HTMLElement)) return;
		const at = axis === 'y' ? 'scrollTop' : 'scrollLeft';
		const fit = () => {
			if (axis === 'y') {
				const head = port.querySelector('thead')?.offsetHeight ?? 0;
				bar.style.top = `${head}px`;
				fill.style.height = `${port.scrollHeight - head}px`;
				bar.hidden = port.scrollHeight <= port.clientHeight;
			} else {
				fill.style.width = `${port.scrollWidth}px`;
				bar.hidden = port.scrollWidth <= port.clientWidth;
			}
			bar[at] = port[at];
		};
		const follow = () => {
			if (bar[at] !== port[at]) bar[at] = port[at];
		};
		const lead = () => {
			if (port[at] !== bar[at]) port[at] = bar[at];
		};
		const ro = new ResizeObserver(fit);
		ro.observe(port);
		if (port.firstElementChild) ro.observe(port.firstElementChild);
		port.addEventListener('scroll', follow, { passive: true });
		bar.addEventListener('scroll', lead, { passive: true });
		return () => {
			ro.disconnect();
			port.removeEventListener('scroll', follow);
			bar.removeEventListener('scroll', lead);
		};
	};
	const PIN_EDGE = 'shadow-[inset_-1px_0_0_0_var(--color-border)]';
	// the row actions stay at the right edge while wide rows scroll sideways (else a many-column table hides them past it)
	const ACTS_EDGE = 'sticky right-0 shadow-[inset_1px_0_0_0_var(--color-border)]';

	const opens = $derived(kind === 'model' || onOpen !== undefined);
	const open = (row: ReadRow) =>
		onOpen
			? onOpen(row)
			: kind === 'model' && typeof row['id'] === 'string' && openRecord(model, row['id']);
	/** A click on a row opens it, as the phone's card does; a link, a control, a sheet or selected text keeps its own. */
	// only a control inside the row counts: the sheet the table sits in is a dialog too, and keeps nothing
	const rowClick = (e: MouseEvent, row: ReadRow) => {
		const own = (e.target as Element).closest(
			'a, button, input, select, textarea, label, summary, [contenteditable], [role=dialog]'
		);
		if (
			!opens ||
			(own !== null && (e.currentTarget as Element).contains(own)) ||
			(getSelection()?.toString() ?? '') !== ''
		)
			return;
		open(row);
	};
	/** A cell's full text, its tooltip when the single line truncates. */
	const fullText = (row: ReadRow, f: string) =>
		refOf(presentRow(row), f)?.text ?? show(valueAt(presentRow(row), f), client?.locale);
	/** Plain cell text: its overflow can open a popover without swallowing a link or a control. */
	const plainText = (row: ReadRow, f: string) => {
		const displayed = presentRow(row),
			declared = kindOf(f);
		return (
			typeof valueAt(displayed, f) === 'string' &&
			refOf(displayed, f) === undefined &&
			(declared === undefined || (declared.kind === 'text' && declared.format === undefined))
		);
	};
	const presentRow = (row: ReadRow): Values => presented.get(row) ?? row;
	const columnValue = <F extends keyof ColumnsIn<S> & string>(row: ReadRow, field: F) => row[field];

	// ── local-array edits ──
	const edit = (row: ReadRow, field: string, text: string) => {
		if (tableSource._tag !== 'local') return;
		const rows = tableSource.rows;
		const index = rows.indexOf(row);
		if (index < 0) return;
		onChange?.(
			rows.map((value, i) => (i === index ? { ...value, [field]: like(row[field], text) } : value))
		);
	};
</script>

{#snippet columnInfo(c: Column)}
	{#if colOf(c).description}
		<Tooltip text={colOf(c).description} side="bottom" contentClass="max-w-80 whitespace-normal">
			{#snippet trigger({ props })}
				<button
					{...props}
					type="button"
					class="text-muted-foreground grid size-6 shrink-0 place-items-center"
					aria-label={colLabel(c)}
				>
					<Glyph name="info" class="size-3.5" />
				</button>
			{/snippet}
		</Tooltip>
	{/if}
{/snippet}

{#snippet cell(
	row: ReadRow,
	col: {
		field: keyof ColumnsIn<S> & string;
		cell?: Snippet<
			[
				{
					row: RowIn<S>;
					value: ColumnsIn<S>[keyof ColumnsIn<S> & string] | undefined;
					field: keyof ColumnsIn<S> & string;
				}
			]
		>;
	},
	title = false
)}
	{@const displayed = presentRow(row)}
	{#if col.cell}{@render col.cell({
			row,
			value: columnValue(row, col.field),
			field: col.field
		})}{:else if plainText(row, col.field)}<Overflow
			text={fullText(row, col.field)}
			expand={title ? 'never' : 'row'}
			><Value
				value={valueAt(displayed, col.field)}
				kind={kindOf(col.field)}
				row={displayed}
				ref={undefined}
				name={col.field}
				dense
				link={!title}
			/></Overflow
		>{:else}<Value
			value={valueAt(displayed, col.field)}
			kind={kindOf(col.field)}
			row={displayed}
			ref={refOf(displayed, col.field)}
			name={col.field}
			dense
			link={!title}
		/>{/if}
{/snippet}

<!-- the footer: the selection (when rows can be selected) or the range, then the pager. The selection lives here, not
     above the rows, so choosing a row never moves the header or the rows under the pointer -->
{#snippet footer(rows: readonly RowIn<S>[])}
	<footer
		class="text-muted-foreground flex shrink-0 min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t px-2 py-1 text-xs"
		data-table-footer
	>
		{#if customFooter}{@render customFooter()}{:else}
			{#if selectable && !(kind === 'local' && onChange)}{@render selection(rows)}{:else}<span
					class="px-1 tabular-nums"
					data-range>{range}</span
				>{/if}
			{#if paged}
				<div class="flex items-center gap-1" data-pager>
					<Combobox
						variant="ghost"
						class="w-24"
						size="sm"
						aria-label={msg(text, 'table.pageSize', 'Rows per page')}
						searchable={false}
						options={SIZES.map((n) => ({
							value: String(n),
							label: msg(text, 'table.perPage', '{n} / page', { n })
						}))}
						value={String(size)}
						onChange={(v) => v !== null && setSize(Number(v))}
					/>
					<Button
						size="icon-sm"
						variant="ghost"
						hint={msg(text, 'table.prev', 'Previous')}
						aria-label={msg(text, 'table.prev', 'Previous')}
						disabled={back.length === 0}
						onclick={() => {
							st = { ...st, after: back.at(-1) ?? null };
							back = back.slice(0, -1);
						}}><Glyph name="left" /></Button
					>
					<span class="min-w-16 text-center tabular-nums" data-page
						>{pages === null
							? msg(text, 'table.page', 'Page {page}', { page: back.length + 1 })
							: msg(text, 'table.pageOf', 'Page {page} of {pages}', {
									page: back.length + 1,
									pages
								})}</span
					>
					<Button
						size="icon-sm"
						variant="ghost"
						hint={msg(text, 'table.next', 'Next')}
						aria-label={msg(text, 'table.next', 'Next')}
						disabled={next === null}
						onclick={() => {
							const cursor = next;
							if (cursor === null) return;
							back = [...back, st.after];
							st = { ...st, after: cursor };
						}}><Glyph name="right" /></Button
					>
				</div>
			{/if}
		{/if}
	</footer>
{/snippet}

{#snippet colItem(text: string, glyph: GlyphName, onclick: () => void, off = false)}
	<button
		type="button"
		class="hover:bg-accent flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left disabled:opacity-40"
		disabled={off}
		{onclick}
	>
		<Glyph name={glyph} class="text-muted-foreground size-3.5 shrink-0" />{text}
	</button>
{/snippet}

<!-- the grid's sticky actions cell: two or more actions fold into one menu, so the cell stays narrow and never covers the
     columns it floats over; the phone's card keeps them inline -->
{#snippet rowMenu(row: ReadRow)}
	{#if actions.length + (kind === 'local' && onChange && remove ? 1 : 0) > 1}
		<Popover.Root>
			<Popover.Trigger
				class="text-muted-foreground hover:bg-accent hover:text-foreground grid size-8 max-sm:size-11 place-items-center rounded-sm"
				aria-label={msg(text, 'table.rowActions', 'Row actions')}
				data-row-menu><Glyph name="more" class="size-4" /></Popover.Trigger
			>
			<Popover.Content
				align="end"
				class="flex w-auto min-w-40 flex-col gap-0.5 p-1.5 [&>button]:justify-start"
				>{@render rowActions(row)}</Popover.Content
			>
		</Popover.Root>
	{:else}{@render rowActions(row)}{/if}
{/snippet}

{#snippet rowActions(row: ReadRow)}
	{#each actions as a (a)}
		<Button
			size="sm"
			variant="ghost"
			onclick={(e: MouseEvent) => {
				e.stopPropagation();
				rowAct(a, row);
			}}>{a.label}</Button
		>
	{/each}
	{#if kind === 'local' && onChange && remove}
		<Button
			size="sm"
			variant="ghost"
			onclick={() => {
				if (tableSource._tag !== 'local') return;
				const index = tableSource.rows.indexOf(row);
				if (index >= 0) onChange(tableSource.rows.filter((_, i) => i !== index));
			}}>{msg(text, 'table.remove', 'Remove')}</Button
		>
	{/if}
{/snippet}

<!-- the footer's selection (both layouts): the page's checkbox (the card list has no header), then the count and every
     matching row in place of the range while rows are selected -->
{#snippet selection(rows: readonly RowIn<S>[])}
	{@const all = pageAll(rows)}
	<div class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-1" data-selection>
		<label class="inline-flex items-center gap-2 md:hidden">
			<input
				type="checkbox"
				checked={all}
				aria-label={msg(text, 'table.selectPage', 'Select this page')}
				onchange={(e) => togglePage(rows, e.currentTarget.checked)}
				data-select-page
			/>
			{msg(text, 'table.selectPage', 'Select this page')}
		</label>
		{#if selected.size > 0}
			<span class="font-medium" data-selected-count
				>{msg(text, 'table.selected', '{n} selected', { n: selected.size })}</span
			>
			{#if all && matching !== null && matching > selected.size}
				<Button
					variant="link"
					size="sm"
					class="h-auto px-0 text-xs"
					disabled={selecting}
					onclick={selectMatching}
					data-select-matching
				>
					{msg(text, 'table.selectMatching', 'Select all {n} matching', { n: matching })}</Button
				>
			{/if}
			<Button
				variant="link"
				size="sm"
				class="h-auto px-0 text-xs"
				onclick={() => selected.clear()}
				data-select-clear>{msg(text, 'table.clearSelection', 'Clear selection')}</Button
			>
		{:else}<span class="tabular-nums" data-range>{range}</span>{/if}
	</div>
{/snippet}

<!-- the view fills a bounded parent (a flex column or a definite height) and scrolls inside its card; it never grows the
     parent past its own minimum. The card: the grid (wide) or the list (narrow), then the footer, pinned at the card's foot. -->
<section
	class={embedded
		? '@container min-w-0'
		: '@container flex h-full min-h-[min(18rem,100%)] min-w-0 flex-1 flex-col gap-2'}
	data-view="table"
	data-source={kind}
	data-embedded={embedded || undefined}
>
	{#if !embedded}<ViewToolbar
			config={toolbar}
			{model}
			view={canFilter ? vs : undefined}
			{catalog}
			{source}
			author={where}
			sortable={sorts}
			bind:q={qText}
			searchable={canSearch}
			selected={selectable ? [...selected] : undefined}
			onSettled={() => selected.clear()}
			{exporter}
			onAdd={kind === 'local' && onChange && add
				? () => onChange([...(tableSource._tag === 'local' ? tableSource.rows : []), add()])
				: undefined}
			onProbe={kind === 'model'
				? (p) => {
						probe = p;
						restart({});
					}
				: undefined}
		/>{/if}
	{#if notice}<p role="status" class="text-muted-foreground text-sm">{notice}</p>{/if}

	{#snippet content(rows: readonly ReadRow[])}
		{#if rows.length === 0}
			{#if empty}
				<div class={embedded ? 'min-w-0' : 'bg-card min-w-0 rounded-md border'} data-table-card>
					{@render empty()}
				</div>
			{:else}
				<!-- an empty view says what is missing and offers the way forward, inside the table's own card -->
				{@const what =
					model === '' ? msg(text, 'table.rows', 'rows') : lowerLead(label(text, model))}
				<div class={embedded ? 'min-w-0' : 'bg-card min-w-0 rounded-md border'} data-table-card>
					{#if filtered}
						<EmptyState
							variant="inset"
							icon="search"
							title={msg(text, 'table.noMatch', 'No {what} match this search or filter', {
								what
							})}
							hint={msg(text, 'table.noMatchHint', 'Try a different search, or clear the filters.')}
						>
							<Button
								size="sm"
								variant="outline"
								onclick={() => {
									vs.clear();
									qText = '';
								}}>{msg(text, 'view.clearAll', 'Clear all')}</Button
							>
						</EmptyState>
					{:else}
						<EmptyState
							variant="inset"
							title={msg(text, 'table.empty', 'No {what} yet', { what })}
							hint={canNew
								? msg(text, 'table.noneHint', 'Create the first one to get started.')
								: msg(text, 'table.emptyHint', 'Nothing has been added here yet.')}
						>
							{#if canNew}<Button
									size="sm"
									onclick={() =>
										typeof tb.new === 'function' ? tb.new() : openRecord(model, 'new', contexts)}
									><Glyph name="plus" />{msg(text, 'table.new', 'New')}</Button
								>{/if}
						</EmptyState>
					{/if}
				</div>
			{/if}
			{#if !embedded && customFooter}{@render footer(rows)}{/if}
		{:else}
			<div
				class={embedded
					? 'min-w-0'
					: 'bg-card flex min-h-0 min-w-0 flex-1 flex-col rounded-md border'}
				data-table-card
			>
				<!-- its own scroll port : the grey header sticks, pinned columns stay while the rest scrolls sideways.
					     Every column keeps its natural width (a long value stops at max-w-80): a table wider than the card scrolls, so
					     the nowrap row actions never squeeze a truncating column down to its first letters -->
				<div
					class={[
						embedded ? 'min-w-0' : 'relative flex min-h-0 flex-1 flex-col',
						!embedded && layout !== 'grid' && !(kind === 'local' && onChange) && 'max-md:hidden'
					]}
				>
					<div
						class={embedded
							? 'min-w-0 overflow-x-auto'
							: 'min-h-0 flex-1 overflow-auto rounded-t-md [scrollbar-width:none] [&::-webkit-scrollbar]:hidden'}
						data-table-wide
					>
						<table
							class="w-max min-w-full border-separate border-spacing-0 text-xs [&_td]:h-9 [&_td]:border-b [&_td]:px-3 [&_td]:py-0 [&_td]:whitespace-nowrap [&_td:not(:last-child)]:border-r [&_th]:h-9 [&_th]:border-b [&_th]:px-3 [&_th]:text-left [&_th]:text-[13px] [&_th]:font-medium [&_th:not(:last-child)]:border-r"
						>
							<thead class="bg-muted sticky top-0 z-20">
								<tr>
									{#if selectable}
										<th class="bg-muted sticky left-0 z-10 w-8 px-2!"
											><input
												type="checkbox"
												aria-label={msg(text, 'table.selectAll', 'Select all')}
												checked={pageAll(rows)}
												onchange={(e) => togglePage(rows, e.currentTarget.checked)}
											/></th
										>
									{/if}
									{#each ordered as c, ci (colOf(c).field)}
										{@const f = colOf(c).field}
										{@const isPinned = ci < pinCount}
										<!-- drag a header onto another to move it (the column menu moves it by keyboard); sorting is the toolbar's -->
										<th
											class={[
												'group bg-muted relative',
												isPinned && 'sticky z-10',
												isPinned && ci === pinCount - 1 && PIN_EDGE,
												numeric(f) && 'text-right'
											]}
											style={[sized(widthOf(c)), isPinned ? `left:${leftOf(ci)}px` : '']
												.filter(Boolean)
												.join(';') || undefined}
											draggable="true"
											data-column={f}
											ondragstart={(e) => {
												dragging = f;
												e.dataTransfer?.setData('text/x-bolt-column', f);
											}}
											ondragend={() => (dragging = null)}
											ondragover={(e) => {
												if (dragging !== null) e.preventDefault();
											}}
											ondrop={(e) => {
												e.preventDefault();
												if (dragging !== null) moveColumn(dragging, f);
												dragging = null;
											}}
											{@attach measure(f)}
										>
											<span
												class={['flex min-w-0 items-center gap-1', numeric(f) && 'justify-end']}
											>
												<span class="truncate whitespace-nowrap">{colLabel(c)}</span>
												{@render columnInfo(c)}
												{#if isPinned}<Glyph
														name="pin"
														class="text-muted-foreground size-3 shrink-0"
													/>{/if}
												<Popover.Root>
													<Popover.Trigger
														class={[
															'text-muted-foreground hover:bg-background hover:text-foreground ml-auto grid size-6 shrink-0 place-items-center rounded-sm transition-opacity focus-visible:opacity-100 data-[state=open]:opacity-100',
															'opacity-0 group-hover:opacity-100'
														]}
														aria-label={msg(
															text,
															'table.columnMenu',
															'Column options for {column}',
															{
																column: colLabel(c)
															}
														)}
														data-column-menu={f}
														><Glyph name="more" class="size-3.5" /></Popover.Trigger
													>
													<Popover.Content
														align="start"
														class="flex w-52 flex-col gap-0.5 p-1.5 text-xs font-normal"
													>
														{@render colItem(
															isPinned
																? msg(text, 'table.unpin', 'Unpin column')
																: msg(text, 'table.pin', 'Pin column'),
															'pin',
															() => togglePin(f)
														)}
														{@render colItem(
															msg(text, 'table.hideColumn', 'Hide column'),
															'eyeOff',
															() => toggleHidden(f),
															ordered.length === 1
														)}
														{@render colItem(
															msg(text, 'table.moveLeft', 'Move left'),
															'left',
															() => moveColumn(f, -1),
															ci === 0
														)}
														{@render colItem(
															msg(text, 'table.moveRight', 'Move right'),
															'right',
															() => moveColumn(f, 1),
															ci === ordered.length - 1
														)}
														{#if widths[f] !== undefined}{@render colItem(
																msg(text, 'table.resetWidth', 'Reset width'),
																'sync',
																() => {
																	const { [f]: _, ...rest } = widths;
																	widths = rest;
																	keep();
																}
															)}{/if}
														{#if hiddenCols.length > 0}
															<p
																class="text-muted-foreground mt-1 border-t px-2 pt-2 pb-1 font-medium"
															>
																{msg(text, 'table.hiddenColumns', 'Hidden columns')}
															</p>
															{#each hiddenCols as h (colOf(h).field)}{@render colItem(
																	colLabel(h),
																	'eye',
																	() => toggleHidden(colOf(h).field)
																)}{/each}
														{/if}
													</Popover.Content>
												</Popover.Root>
											</span>
											<!-- the resize handle: drag the column's right edge -->
											<span
												role="separator"
												aria-orientation="vertical"
												aria-label={msg(text, 'table.resize', 'Resize column')}
												data-column-resize
												class={[
													'group/resize absolute inset-y-0 z-10 flex w-2 cursor-col-resize touch-none justify-center select-none',
													ci === ordered.length - 1 ? 'right-0' : '-right-1'
												]}
												onpointerdown={(e) => resize(e, f)}
											>
												<span
													class="bg-muted-foreground/40 group-hover/resize:bg-brand my-auto h-5 w-px opacity-0 transition-opacity group-hover:opacity-100 group-hover/resize:w-0.5"
												></span>
											</span>
										</th>
									{/each}
									{#if actions.length > 0 || (kind === 'local' && onChange && remove)}<th
											class={['bg-muted z-10', ACTS_EDGE]}
										></th>{/if}
								</tr>
							</thead>
							<tbody>
								{#if wide.on}<tr aria-hidden="true" {@attach wide.anchor}
										><td colspan={span} style="height:{wide.before}px;padding:0;border:0"></td></tr
									>{/if}
								{#each wide.slice(rows) as row, j (row['id'] ?? wide.start + j)}
									{@const i = wide.start + j}
									<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
									{@const held = approvalOf(row)}
									<tr
										class={[
											'group/row hover:[&>td]:bg-[color-mix(in_oklab,var(--color-muted)_50%,var(--color-card))]',
											opens && 'focus-visible:[&>td]:bg-accent cursor-pointer outline-none',
											rowClass?.(row),
											held !== null &&
												(held.state === 'Pending'
													? '[&>td:last-child]:shadow-[inset_-3px_0_0_var(--color-warning)]'
													: '[&>td:last-child]:shadow-[inset_-3px_0_0_var(--color-primary)]')
										]}
										data-approval={held?.state}
										title={held === null ? undefined : approvalText(text, held)}
										{@attach wide.measure(rowKey(i))}
										tabindex={opens ? 0 : undefined}
										onclick={(e) => rowClick(e, row)}
										onkeydown={(e) => {
											if (opens && e.target === e.currentTarget && e.key === 'Enter') {
												e.preventDefault();
												open(row);
											}
										}}
									>
										{#if selectable}
											<!-- every row holds the checkbox column's cell, so its data cells stay under their headings -->
											<td class="bg-card sticky left-0 z-[1] px-2!">
												{#if recordRow(row)}<input
														type="checkbox"
														aria-label={msg(text, 'table.select', 'Select')}
														checked={selected.has(row.id)}
														onchange={(e) =>
															e.currentTarget.checked
																? selected.add(row.id)
																: selected.delete(row.id)}
													/>{/if}
											</td>
										{/if}
										{#each ordered as c, ci (colOf(c).field)}
											{@const col = colOf(c)}
											{@const w = widthOf(c)}
											{@const isPinned = ci < pinCount}
											<td
												class={[
													'bg-card',
													isPinned
														? 'sticky z-[1]'
														: (ci === 0 || (rowTrailing && ci === ordered.length - 1)) &&
															'relative',
													isPinned && ci === pinCount - 1 && PIN_EDGE,
													numeric(col.field) && 'text-right tabular-nums',
													embedded && 'align-middle',
													rowTrailing && ci === ordered.length - 1 && 'pr-9!'
												]}
												style={[sized(w), isPinned ? `left:${leftOf(ci)}px` : '']
													.filter(Boolean)
													.join(';') || undefined}
											>
												{#if kind === 'local' && onChange && col.edit && !col.cell}
													{@const value = valueAt(row, col.field)}
													<input
														class="border-input h-7 w-full rounded-sm border px-1"
														type={typeof value === 'number' ? 'number' : 'text'}
														value={String(value ?? '')}
														onchange={(e) => edit(row, col.field, e.currentTarget.value)}
													/>
												{:else}
													<!-- one line: every row keeps its height, a long value truncates, its full text is the tooltip -->
													<div
														class={[
															'truncate [&_[data-enum-list]]:flex-nowrap',
															!embedded && w === undefined && 'max-w-80'
														]}
														title={fullText(row, col.field) || undefined}
													>
														{@render cell(row, col, ci === 0 && opens)}
													</div>
												{/if}
												{#if rowTrailing && ci === ordered.length - 1}
													<div
														class="absolute top-1/2 right-1 -translate-y-1/2 opacity-0 pointer-events-none group-hover/row:opacity-100 group-hover/row:pointer-events-auto group-focus-within/row:opacity-100 group-focus-within/row:pointer-events-auto [@media(hover:none)]:opacity-100 [@media(hover:none)]:pointer-events-auto"
														data-row-trailing
													>
														{@render rowTrailing(row)}
													</div>
												{/if}
												{#if ci === 0 && opens}
													<!-- the row's one open control (its record opens in the side panel), over the cell's end while the row is hovered or holds focus -->
													<button
														type="button"
														class="bg-[color-mix(in_oklab,var(--color-muted)_50%,var(--color-card))] text-muted-foreground hover:text-foreground hover:bg-accent focus-visible:ring-ring absolute top-1/2 right-1 grid size-6 -translate-y-1/2 place-items-center rounded-sm opacity-0 outline-none group-hover/row:opacity-100 group-focus-within/row:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 [@media(hover:none)]:opacity-100"
														aria-label={msg(text, 'table.openRow', 'Open')}
														title={msg(text, 'table.openRow', 'Open')}
														onclick={() => open(row)}
														data-row-open><Glyph name="panel" class="size-3.5" /></button
													>
												{/if}
											</td>
										{/each}
										{#if actions.length > 0 || (kind === 'local' && onChange && remove)}
											<td class={['bg-card z-[1]', ACTS_EDGE]} data-row-actions
												>{@render rowMenu(row)}</td
											>
										{/if}
									</tr>
								{/each}
								{#if wide.after > 0}<tr aria-hidden="true"
										><td colspan={span} style="height:{wide.after}px;padding:0;border:0"></td></tr
									>{/if}
							</tbody>
						</table>
					</div>
					{#if !embedded}
						<div
							class="absolute right-0 bottom-0 z-30 w-3 overflow-x-hidden overflow-y-auto"
							aria-hidden="true"
							hidden
							{@attach rail('y')}
						>
							<div class="w-px"></div>
						</div>
						<div
							class="absolute inset-x-0 bottom-0 z-30 h-3 overflow-x-auto overflow-y-hidden"
							aria-hidden="true"
							hidden
							{@attach rail('x')}
						>
							<div class="h-px"></div>
						</div>
					{/if}
				</div>
				{#if !embedded && layout !== 'grid' && !(kind === 'local' && onChange)}
					<ul class="min-h-0 flex-1 divide-y overflow-auto rounded-t-md md:hidden" data-table-list>
						{#if narrow.on}<li
								aria-hidden="true"
								style="height:{narrow.before}px"
								{@attach narrow.anchor}
							></li>{/if}
						{#each narrow.slice(rows) as row, j (row['id'] ?? narrow.start + j)}
							{@const i = narrow.start + j}
							{@const [lead, ...rest] = ordered.map(colOf).filter((c) => c.hide !== 'narrow')}
							<li
								class={[
									'relative flex min-w-0 items-start gap-2 px-3 py-2.5 transition-colors',
									recordRow(row) && selected.has(row.id) ? 'bg-accent/40' : 'hover:bg-muted/40',
									rowClass?.(row)
								]}
								{@attach narrow.measure(rowKey(i))}
							>
								<ApprovalAccent {row} />
								{#if selectable && recordRow(row)}
									<input
										class="mt-1"
										type="checkbox"
										aria-label={msg(text, 'table.select', 'Select')}
										checked={selected.has(row.id)}
										onchange={(e) =>
											e.currentTarget.checked ? selected.add(row.id) : selected.delete(row.id)}
									/>
								{/if}
								<!-- a phone has no hover: the card itself opens the record; not a <button>, so a relation's link inside
									     receives its own tap (it opens the related record) -->
								<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_static_element_interactions -->
								<div
									role={opens ? 'button' : undefined}
									tabindex={opens ? 0 : undefined}
									class="flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5 text-left"
									data-row-card
									onclick={(e) => rowClick(e, row)}
									onkeydown={(e) => {
										if (
											opens &&
											e.target === e.currentTarget &&
											(e.key === 'Enter' || e.key === ' ')
										) {
											e.preventDefault();
											open(row);
										}
									}}
								>
									{#if lead}<span class="truncate text-sm font-medium"
											>{@render cell(row, lead, opens)}</span
										>{/if}
									{#if rest.length > 0}
										<div class="text-muted-foreground flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
											{#each rest.slice(0, 4) as c (c.field)}
												<span
													class="inline-flex max-w-full min-w-0 items-baseline gap-1 whitespace-nowrap"
													><span class="shrink-0">{colLabel(c)}</span>{@render columnInfo(c)}<span
														class="text-foreground/80 min-w-0 truncate [&_[data-enum-list]]:flex-nowrap"
														>{@render cell(row, c)}</span
													></span
												>
											{/each}
											{#if rest.length > 4}<details class="basis-full" data-row-extra-fields>
													<summary class="cursor-pointer py-1"
														>{msg(text, 'table.moreFields', '+{n} fields', {
															n: rest.length - 4
														})}</summary
													>
													<div class="flex flex-col gap-1 py-1">
														{#each rest.slice(4) as c (c.field)}
															<span class="inline-flex max-w-full min-w-0 items-baseline gap-1"
																><span class="shrink-0">{colLabel(c)}</span>{@render columnInfo(
																	c
																)}<span class="text-foreground/80 min-w-0 break-words"
																	>{@render cell(row, c)}</span
																></span
															>
														{/each}
													</div>
												</details>{/if}
										</div>
									{/if}
								</div>
								{#if actions.length > 0}<div class="flex shrink-0 flex-wrap justify-end">
										{@render rowActions(row)}
									</div>{/if}
							</li>
						{/each}
						{#if narrow.after > 0}<li aria-hidden="true" style="height:{narrow.after}px"></li>{/if}
					</ul>
				{/if}
				{#if !embedded}{@render footer(rows)}{/if}
			</div>
		{/if}
	{/snippet}
	{#if embedded}
		{@render content(shownRows)}
	{:else}
		<ReadGate
			state={view}
			what={model === '' ? msg(text, 'table.rows', 'these rows') : label(text, model)}
		>
			{#snippet children(rows)}{@render content(rows)}{/snippet}
		</ReadGate>
	{/if}
</section>
