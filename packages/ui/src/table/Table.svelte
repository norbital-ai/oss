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
		ActionInputOf,
		ActionKey,
		CollectionKey,
		ManyOf,
		Page,
		OrderByOf,
		QueryInputOf,
		QueryKey,
		QueryOutputOf,
		RecordOf,
		Row,
		RowOf,
		Values,
		WhereOf
	} from '../collection/types.js';
	import type { Json, Q } from '../client/contract.js';
	import type { OrderBy, Where } from '../filter/filter.js';
	import type { Toolbar, ToolbarItem } from '../collection/ViewToolbar.svelte';
	import type { Kind } from '../kinds/kind.js';

	type TableData<R extends Values> = Page<R> | readonly R[];
	/** A table's source: a collection name, a named collection query, a native read/query Effect, or a local row array. */
	export type TableSource<R extends Values = Values> =
		| CollectionKey
		| {
				[N in QueryKey]: { query: N; input?: QueryInputOf<N>; on?: readonly CollectionKey[] };
		  }[QueryKey]
		| Q<TableData<R>>
		| readonly R[];
	type PageRow<T> = T extends { readonly rows: readonly (infer R extends Values)[] }
		? R
		: T extends readonly (infer R extends Values)[]
			? R
			: Values;
	/** The row a source yields: the collection's caller row, the query's or read's rows, or the array's element. */
	export type RowIn<S> = S extends string
		? RowOf<S> & Values
		: S extends { query: infer N }
			? PageRow<QueryOutputOf<N>>
			: S extends Q<infer T>
				? PageRow<T>
				: S extends readonly (infer R extends Values)[]
					? R
					: Values;
	/** The fields a column may name: a collection's whole record (a heavy field is then read) and its many-relations (the
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
	/** A row action literal: `{ action: '<c>.<a>', input?, confirm? }`; the default input targets the row. */
	export type RowAction<R = Row> = {
		[A in ActionKey]: {
			action: A;
			input?: (row: R) => ActionInputOf<A>;
			confirm?: string;
			label?: string;
		};
	}[ActionKey];
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
	const localSource = <R extends Values>(value: TableSource<R>): value is readonly R[] =>
		Array.isArray(value);
	const querySource = <R extends Values>(value: TableSource<R>): value is Q<TableData<R>> =>
		Effect.isEffect(value);
	const tableInput = <R extends Values>(value: TableSource<R>) => {
		if (typeof value === 'string') return { _tag: 'collection' as const, name: value };
		if (localSource(value)) return { _tag: 'local' as const, rows: value };
		if (querySource(value)) return { _tag: 'read' as const, read: value };
		return { _tag: 'query' as const, name: value.query, input: value.input ?? {} };
	};
	const tableRows = <R extends Values>(value: TableData<R>): readonly R[] => {
		const array = (value: TableData<R>): value is readonly R[] => Array.isArray(value);
		return array(value) ? value : value.rows;
	};
</script>

<script lang="ts" generics="S extends TableSource">
	import { formatValue as show } from '../kinds/kind.js';
	import { Schedule, Stream } from 'effect';
	import { fork } from '../effect/index.js';
	import { getAllContexts, onDestroy, untrack } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { Debounced, watch as onChange_ } from 'runed';
	import { Button } from '../primitives/button/index.js';
	import * as Popover from '../primitives/popover/index.js';
	import { Tooltip } from '../primitives/tooltip/index.js';
	import { Combobox } from '../primitives/combobox/index.js';
	import { virtualList } from '../primitives/virtual/virtual.svelte.js';
	import { useKinds } from '../kinds/context.js';
	import { likeWhere } from '../kinds/kind.js';
	import { KINDS } from '../kinds/registry.js';
	import { openRecord } from '../record/navigation.js';
	import { provideCollection } from '../collection/context.js';
	import { useBolt } from '../client/context.js';
	import { type Outcome } from '../client/contract.js';
	import EmptyState from '../primitives/empty-state/EmptyState.svelte';
	import Glyph, { type GlyphName } from '../primitives/icon/Glyph.svelte';
	import { watch } from '../read/live.svelte.js';
	import { notify } from '../actions/notify.js';
	import { localExposure, matches, orderOf, sortable, sortRows } from '../filter/filter.js';
	import { actOutcome } from '../actions/outcome.js';
	import { and, compact } from '../filter/scope.js';
	import { COUNT_EVERY_MS, once, pageRead } from '../read/paging.js';
	import { countOf, isRow, nextOf, rowsOf } from '../read/results.js';
	import { filesOf, like, valueAt } from '../cell/value.js';
	import { humanize, label, lowerLead, msg } from '../text/messages.js';
	import { listSelect, refOf, unref } from '../relations/select.js';
	import {
		queryIds,
		rangeText,
		readTableState,
		searchRows,
		writeTableState,
		type TableState
	} from './model.js';
	import { type ReadState } from '../read/state.js';
	import { viewState } from '../filter/view-state.svelte.js';
	import ViewToolbar, { selectionEnabled } from '../collection/ViewToolbar.svelte';
	import ReadGate from '../read/ReadGate.svelte';
	import Value from '../cell/Value.svelte';
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
		actions = [],
		key,
		every,
		empty,
		onOpen,
		onChange,
		add,
		remove
	}: TableProps<S, RowIn<S>, ColumnsIn<S>> = $props();
	const bolt = useBolt();
	const kinds = useKinds();

	type ReadRow = RowIn<S> & Partial<ColumnsIn<S>>;
	const tableSource = $derived(tableInput<ReadRow>(of));
	const kind = $derived(tableSource._tag === 'read' ? 'q' : tableSource._tag);
	const name = $derived(
		tableSource._tag === 'collection' || tableSource._tag === 'query' ? tableSource.name : ''
	);
	const collection = $derived(
		tableSource._tag === 'collection'
			? tableSource.name
			: tableSource._tag === 'query'
				? tableSource.name.slice(0, tableSource.name.lastIndexOf('.'))
				: tableSource._tag === 'read' && typeof tableSource.read.read.a[0] === 'string'
					? tableSource.read.read.a[0]
					: ''
	);

	const urlKey = $derived(key ?? (name || collection || 'rows'));
	const fields = $derived(columns.map((c) => (typeof c === 'string' ? c : c.field)));
	type Column = Col<RowIn<S>, ColumnsIn<S>>;
	const colOf = <F extends keyof ColumnsIn<S> & string>(
		c: F | ColumnDefinition<RowIn<S>, ColumnsIn<S>, F>
	): ColumnDefinition<RowIn<S>, ColumnsIn<S>, F> => (typeof c === 'string' ? { field: c } : c);
	// a relation column (a FK or a many-relation) without an authored `cell` shows its targets' labels, read with the page
	// in the same statement (kind `collection` only)
	const refs = $derived(
		kind === 'collection'
			? columns.filter((c) => colOf(c).cell === undefined).map((c) => colOf(c).field)
			: []
	);
	const tb = $derived(toolbar === false ? {} : toolbar);
	// search where the collection declares search fields (rule 16), else `like` over its label's text fields, or over a
	// local array's columns, or through a named similarity or query (the toolbar's `/<name>`)
	const exposed = $derived(kinds.catalog?.[collection]);
	const indexed = $derived((exposed?.search?.length ?? 0) > 0);
	const byLabel = (q: string) =>
		indexed ? undefined : likeWhere(exposed, exposed?.label ?? [], q);
	const canSearch = $derived(
		kind === 'local' ||
			(kind === 'collection' &&
				(indexed ||
					byLabel('x') !== undefined ||
					exposed?.similarity !== undefined ||
					exposed?.queries !== undefined))
	);
	const kindOf = (f: string) => {
		const column = columns.find((c) => colOf(c).field === f);
		return (
			(column === undefined ? undefined : colOf(column).kind) ??
			kinds.catalog?.[collection]?.fields[f]
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
		collection === ''
			? (kindOf(f)?.label ?? humanize(f))
			: label(bolt, collection, f, kindOf(f)?.label);
	// the cells' enum and state words read this collection's catalog keys
	provideCollection(() => collection);
	const canFilter = $derived(kind === 'collection' || kind === 'local');
	// the view popover's catalog: the caller's exposure, or a local array's columns (kinds from its values)
	const LOCAL = '$local';
	const source = $derived(kind === 'local' ? LOCAL : collection);
	const catalog = $derived(
		kind === 'local'
			? {
					[LOCAL]: localExposure(
						tableSource._tag === 'local' ? tableSource.rows : [],
						fields,
						(f) => fieldLabel(f)
					)
				}
			: kinds.catalog?.[collection] !== undefined
				? kinds.catalog
				: { ...kinds.catalog, [collection]: localExposure([], fields, (f) => fieldLabel(f)) }
	);
	const sorts = $derived(
		kind === 'collection' || kind === 'local'
			? sortable(catalog[source], kind !== 'local', catalog)
			: []
	);
	const vs = viewState(bolt, {
		key: () => urlKey,
		collection: () => source,
		catalog: () => catalog,
		initialFilter: () => initialFilter
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
			kind === 'collection' &&
			(typeof tb.new === 'function' || kinds.catalog?.[collection]?.create !== undefined)
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
	let st = $state<TableState>(untrack(() => readTableState(params(), urlKey)));
	let back = $state<(string | null)[]>([]);
	let qText = $state(untrack(() => st.q));
	// a typed index the toolbar runs, a named similarity (§3.3.4) or query: its rows, in its order, in place of the page;
	// read once, not live
	let probe = $state<{ name: string; via: 'similar' | 'query'; input: Json } | null>(null);
	function probed(p: {
		name: string;
		via: 'similar' | 'query';
		input: Json;
	}): Effect.Effect<Page<ReadRow>, import('../client/contract.js').ReadError> {
		return Effect.gen(function* () {
			const select = listSelect(kinds.catalog, name, fields, refs),
				where = scope;
			if (p.via === 'similar') {
				if (bolt.similar === undefined)
					return yield* Effect.fail(
						Object.assign(new Error('this host answers no similar read'), {
							_tag: 'ReadFailed' as const,
							code: 'unsupported'
						})
					);
				return {
					rows: tableRows(
						yield* bolt.similar<readonly ReadRow[]>(
							name,
							p.name,
							p.input,
							compact({ where, select, limit: size })
						)
					),
					next: null
				};
			}
			const answer = yield* bolt.query<TableData<ReadRow>>(`${name}.${p.name}`, p.input);
			const out = queryIds(answer, exposed?.queries?.[p.name]?.output, name);
			if ('rows' in out) return { rows: tableRows(answer), next: null };
			if (out.ids.length === 0) return { rows: [], next: null };
			const byId = new Map(
				tableRows(
					yield* bolt.read<Page<ReadRow>>(
						name,
						compact({ where: and(where, { id: { in: out.ids } }), select, limit: out.ids.length })
					)
				).map((r) => [r['id'], r])
			);
			return {
				rows: out.ids.map((id) => byId.get(id)).filter((row): row is ReadRow => row !== undefined),
				next: null
			};
		});
	}
	let notice = $state<string | null>(null);
	$effect(() => {
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
	const page = watch(() => {
		const after = st.after ?? undefined;
		// hook:agent-ui — a later page stays live (its index is the pages behind it; a cursor restored from the URL has none)
		if (kind === 'collection' && probe !== null) return once(probed(probe));
		if (kind === 'collection')
			return pageRead(
				bolt,
				(limit, at) =>
					bolt.read<Page<ReadRow>>(
						name,
						compact({
							...searched,
							orderBy: order,
							select: listSelect(kinds.catalog, name, fields, refs),
							limit,
							after: at
						})
					),
				size,
				back.length > 0 ? back.length : null,
				after,
				every
			);
		if (tableSource._tag === 'query') {
			const input = tableSource.input;
			const declared = exposed?.queries?.[name.slice(name.lastIndexOf('.') + 1)]?.input;
			return bolt.live(
				bolt.query<TableData<ReadRow>>(
					name,
					isRow(input)
						? compact({
								...input,
								...(declared === undefined || declared.limit !== undefined ? { limit: size } : {}),
								...(declared === undefined || declared.after !== undefined ? { after } : {})
							})
						: input
				),
				{ on: [collection] }
			);
		}
		if (tableSource._tag === 'read')
			return bolt.live(tableSource.read, every === undefined ? {} : { every });
		return null;
	});
	$effect(() => {
		const s = page.state;
		if (s.kind === 'error' && s.code === 'badCursor')
			untrack(() => {
				notice = msg(
					bolt,
					'table.badCursor',
					'That page is no longer available; showing the first page.'
				);
				restart({});
			});
	});
	const local = $derived(
		kind === 'local'
			? sortRows(
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
			: page.state.kind === 'ready'
				? {
						kind: 'ready',
						value: tableRows(page.state.value)
					}
				: page.state
	);
	const next = $derived(page.state.kind === 'ready' ? nextOf(page.state.value) : null);
	// a long page (pageSize 100/200, a local grid) renders a window of rows, one per layout, measured and keyed by id
	const shownRows = $derived(view.kind === 'ready' ? view.value : []);
	const presented = $derived(
		new Map(
			shownRows.map<[ReadRow, Values]>((row) => [
				row,
				typeof row['id'] === 'string'
					? (unref(kinds.catalog, collection, refs, rowsOf([row]), bolt.locale)[0] ?? row)
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

	// ── one-shot count (rule 7): on scope change, then at most every 30 s while the page changes ──
	let countInvalid = $state(false);
	let countRevision = 0;
	const countRead = watch(() => {
		if (kind !== 'collection' || st.q !== '' || probe !== null) return null;
		const collection = name,
			where = scope;
		let cached: unknown,
			first = true;
		const read = Effect.suspend(() => {
			if (!first && !countInvalid) return Effect.succeed(cached);
			const revision = countRevision;
			return bolt.aggregate(collection, compact({ count: true, where })).pipe(
				Effect.tap((answer) =>
					Effect.sync(() => {
						cached = answer;
						first = false;
						countInvalid = revision !== countRevision;
					})
				)
			);
		});
		return Stream.fromEffectSchedule(read, Schedule.spaced(COUNT_EVERY_MS));
	});
	const count = $derived(
		countInvalid || countRead.error !== undefined ? null : countOf(countRead.value)
	);
	onChange_(
		() => page.value,
		(current, previous) => {
			if (previous !== undefined && current !== undefined && current !== previous) {
				countRevision++;
				countInvalid = true;
			}
		}
	);

	// ── selection and row actions (the toolbar runs its own) ──
	type SelectedId = Parameters<ToolbarItem<RowIn<S>>['run']>[0][number];
	const selected = new SvelteSet<SelectedId>();
	const say = (o: Outcome) => {
		notify(bolt, o);
		if (o.kind === 'committed')
			for (const f of filesOf(o.output)) window.open(bolt.fileUrl(f), '_blank', 'noopener');
		if (o.kind === 'committed' || o.kind === 'pendingApproval') selected.clear();
	};
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
		kind === 'local' ? local.length : kind === 'collection' && probe === null ? count : null
	);
	let selecting = $state(false);
	function selectMatching() {
		if (kind === 'local') return void local.filter(recordRow).forEach((r) => selected.add(r.id));
		selecting = true;
		fork(
			bolt
				.read<Page<RowIn<S>>>(name, compact({ ...searched, select: { id: true }, all: true }))
				.pipe(
					Effect.tap((answer) =>
						Effect.sync(() => {
							for (const row of tableRows(answer).filter(recordRow)) selected.add(row.id);
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
		if (a.confirm !== undefined && !confirm(a.confirm)) return;
		const input = a.input !== undefined ? a.input(row) : recordRow(row) ? { target: row.id } : null;
		if (input === null) return;
		fork(
			actOutcome(bolt.act(a.action, input)).pipe(
				Effect.tap((outcome) => Effect.sync(() => say(outcome)))
			)
		);
	}
	// the toolbar's CSV: every row of the current scope, search and sort, over the view's columns
	const exporter = $derived(
		kind === 'collection'
			? {
					fields,
					labels: columns.map(colLabel),
					kinds: columnKinds,
					read: () =>
						bolt.read(
							name,
							compact({
								...searched,
								orderBy: order,
								select: listSelect(kinds.catalog, name, fields, refs, true),
								all: true
							})
						)
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
	const paged = $derived(kind === 'collection' || kind === 'query');
	const range = $derived(
		view.kind !== 'ready'
			? null
			: rangeText(bolt, back.length * size, view.value.length, paged ? count : view.value.length)
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
	const PIN_EDGE = 'shadow-[inset_-1px_0_0_0_var(--color-border)]';
	// the row actions stay at the right edge while wide rows scroll sideways (else a many-column table hides them past it)
	const ACTS_EDGE = 'sticky right-0 shadow-[inset_1px_0_0_0_var(--color-border)]';

	const opens = $derived(kind === 'collection' || onOpen !== undefined);
	const open = (row: ReadRow) =>
		onOpen
			? onOpen(row)
			: kind === 'collection' && typeof row['id'] === 'string' && openRecord(collection, row['id']);
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
		refOf(presentRow(row), f)?.text ?? show(valueAt(presentRow(row), f), bolt.locale);
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
	}
)}
	{@const displayed = presentRow(row)}
	{#if col.cell}{@render col.cell({
			row,
			value: columnValue(row, col.field),
			field: col.field
		})}{:else}<Value
			value={valueAt(displayed, col.field)}
			kind={kindOf(col.field)}
			row={displayed}
			ref={refOf(displayed, col.field)}
			name={col.field}
			dense
		/>{/if}
{/snippet}

{#snippet footer()}
	<footer
		class="text-muted-foreground flex shrink-0 min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t px-2 py-1 text-xs"
		data-table-footer
	>
		<span class="px-1 tabular-nums" data-range>{range}</span>
		{#if paged}
			<div class="flex items-center gap-1" data-pager>
				<Combobox
					variant="ghost"
					class="w-24"
					size="sm"
					aria-label={msg(bolt, 'table.pageSize', 'Rows per page')}
					searchable={false}
					options={SIZES.map((n) => ({
						value: String(n),
						label: msg(bolt, 'table.perPage', '{n} / page', { n })
					}))}
					value={String(size)}
					onChange={(v) => v !== null && setSize(Number(v))}
				/>
				<Button
					size="icon-sm"
					variant="ghost"
					hint={msg(bolt, 'table.prev', 'Previous')}
					aria-label={msg(bolt, 'table.prev', 'Previous')}
					disabled={back.length === 0}
					onclick={() => {
						st = { ...st, after: back.at(-1) ?? null };
						back = back.slice(0, -1);
					}}><Glyph name="left" /></Button
				>
				<span class="min-w-16 text-center tabular-nums" data-page
					>{pages === null
						? msg(bolt, 'table.page', 'Page {page}', { page: back.length + 1 })
						: msg(bolt, 'table.pageOf', 'Page {page} of {pages}', {
								page: back.length + 1,
								pages
							})}</span
				>
				<Button
					size="icon-sm"
					variant="ghost"
					hint={msg(bolt, 'table.next', 'Next')}
					aria-label={msg(bolt, 'table.next', 'Next')}
					disabled={next === null}
					onclick={() => {
						back = [...back, st.after];
						st = { ...st, after: next };
					}}><Glyph name="right" /></Button
				>
			</div>
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
				aria-label={msg(bolt, 'table.rowActions', 'Row actions')}
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
	{#each actions as a (a.action)}
		<Button
			size="sm"
			variant="ghost"
			onclick={(e: MouseEvent) => {
				e.stopPropagation();
				rowAct(a, row);
			}}>{a.label ?? humanize(a.action.slice(a.action.lastIndexOf('.') + 1))}</Button
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
			}}>{msg(bolt, 'table.remove', 'Remove')}</Button
		>
	{/if}
{/snippet}

<!-- the selection bar (both layouts): the page's checkbox (the card list has no header), the count, every matching row -->
{#snippet selection(rows: readonly RowIn<S>[])}
	{@const all = pageAll(rows)}
	<div
		class={[
			'bg-muted/40 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-t-md border-b px-3 py-1.5 text-xs',
			selected.size === 0 && '@3xl:hidden'
		]}
		data-selection
	>
		<label class="inline-flex items-center gap-2 @3xl:hidden">
			<input
				type="checkbox"
				checked={all}
				aria-label={msg(bolt, 'table.selectPage', 'Select this page')}
				onchange={(e) => togglePage(rows, e.currentTarget.checked)}
				data-select-page
			/>
			{msg(bolt, 'table.selectPage', 'Select this page')}
		</label>
		{#if selected.size > 0}
			<span class="font-medium" data-selected-count
				>{msg(bolt, 'table.selected', '{n} selected', { n: selected.size })}</span
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
					{msg(bolt, 'table.selectMatching', 'Select all {n} matching', { n: matching })}</Button
				>
			{/if}
			<Button
				variant="link"
				size="sm"
				class="h-auto px-0 text-xs"
				onclick={() => selected.clear()}
				data-select-clear>{msg(bolt, 'table.clearSelection', 'Clear selection')}</Button
			>
		{/if}
	</div>
{/snippet}

<!-- the view fills a bounded parent (a flex column or a definite height) and scrolls inside its card; it never grows the
     parent past its own minimum. The card: the grid (wide) or the list (narrow), then the footer, pinned at the card's foot. -->
<section
	class="@container flex h-full min-h-[min(18rem,100%)] min-w-0 flex-1 flex-col gap-2"
	data-view="table"
	data-source={kind}
>
	<ViewToolbar
		config={toolbar}
		{collection}
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
		onProbe={kind === 'collection'
			? (p) => {
					probe = p;
					restart({});
				}
			: undefined}
	/>
	{#if notice}<p role="status" class="text-muted-foreground text-sm">{notice}</p>{/if}

	<ReadGate
		state={view}
		what={collection === '' ? msg(bolt, 'table.rows', 'these rows') : label(bolt, collection)}
	>
		{#snippet children(rows)}
			{#if rows.length === 0}
				{#if empty}{@render empty()}
				{:else}
					<!-- an empty view says what is missing and offers the way forward, inside the table's own card -->
					{@const what =
						collection === ''
							? msg(bolt, 'table.rows', 'rows')
							: lowerLead(label(bolt, collection))}
					<div class="bg-card min-w-0 rounded-md border" data-table-card>
						{#if filtered}
							<EmptyState
								variant="inset"
								icon="search"
								title={msg(bolt, 'table.noMatch', 'No {what} match this search or filter', {
									what
								})}
								hint={msg(
									bolt,
									'table.noMatchHint',
									'Try a different search, or clear the filters.'
								)}
							>
								<Button
									size="sm"
									variant="outline"
									onclick={() => {
										vs.clear();
										qText = '';
									}}>{msg(bolt, 'view.clearAll', 'Clear all')}</Button
								>
							</EmptyState>
						{:else}
							<EmptyState
								variant="inset"
								title={msg(bolt, 'table.empty', 'No {what} yet', { what })}
								hint={canNew
									? msg(bolt, 'table.noneHint', 'Create the first one to get started.')
									: msg(bolt, 'table.emptyHint', 'Nothing has been added here yet.')}
							>
								{#if canNew}<Button
										size="sm"
										onclick={() =>
											typeof tb.new === 'function'
												? tb.new()
												: openRecord(collection, 'new', contexts)}
										><Glyph name="plus" />{msg(bolt, 'table.new', 'New')}</Button
									>{/if}
							</EmptyState>
						{/if}
					</div>
				{/if}
			{:else}
				<div class="bg-card flex min-h-0 min-w-0 flex-1 flex-col rounded-md border" data-table-card>
					{#if selectable && !(kind === 'local' && onChange)}{@render selection(rows)}{/if}
					<!-- its own scroll port : the grey header sticks, pinned columns stay while the rest scrolls sideways.
					     Every column keeps its natural width (a long value stops at max-w-80): a table wider than the card scrolls, so
					     the nowrap row actions never squeeze a truncating column down to its first letters -->
					<div
						class={[
							'min-h-0 flex-1 overflow-auto rounded-t-md',
							layout !== 'grid' && !(kind === 'local' && onChange) && 'hidden @3xl:block'
						]}
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
												aria-label={msg(bolt, 'table.selectAll', 'Select all')}
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
															bolt,
															'table.columnMenu',
															'Column options for {column}',
															{ column: colLabel(c) }
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
																? msg(bolt, 'table.unpin', 'Unpin column')
																: msg(bolt, 'table.pin', 'Pin column'),
															'pin',
															() => togglePin(f)
														)}
														{@render colItem(
															msg(bolt, 'table.hideColumn', 'Hide column'),
															'eyeOff',
															() => toggleHidden(f),
															ordered.length === 1
														)}
														{@render colItem(
															msg(bolt, 'table.moveLeft', 'Move left'),
															'left',
															() => moveColumn(f, -1),
															ci === 0
														)}
														{@render colItem(
															msg(bolt, 'table.moveRight', 'Move right'),
															'right',
															() => moveColumn(f, 1),
															ci === ordered.length - 1
														)}
														{#if widths[f] !== undefined}{@render colItem(
																msg(bolt, 'table.resetWidth', 'Reset width'),
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
																{msg(bolt, 'table.hiddenColumns', 'Hidden columns')}
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
												aria-label={msg(bolt, 'table.resize', 'Resize column')}
												data-column-resize
												class="group/resize absolute inset-y-0 -right-1 z-10 flex w-2 cursor-col-resize touch-none justify-center select-none"
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
											held !== null &&
												(held.state === 'Pending'
													? '[&>td:last-child]:shadow-[inset_-3px_0_0_var(--color-warning)]'
													: '[&>td:last-child]:shadow-[inset_-3px_0_0_var(--color-primary)]')
										]}
										data-approval={held?.state}
										title={held === null ? undefined : approvalText(bolt, held)}
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
										{#if selectable && recordRow(row)}
											<td class="bg-card sticky left-0 z-[1] px-2!">
												<input
													type="checkbox"
													aria-label={msg(bolt, 'table.select', 'Select')}
													checked={selected.has(row.id)}
													onchange={(e) =>
														e.currentTarget.checked
															? selected.add(row.id)
															: selected.delete(row.id)}
												/>
											</td>
										{/if}
										{#each ordered as c, ci (colOf(c).field)}
											{@const col = colOf(c)}
											{@const w = widthOf(c)}
											{@const isPinned = ci < pinCount}
											<td
												class={[
													'bg-card',
													isPinned ? 'sticky z-[1]' : ci === 0 && 'relative',
													isPinned && ci === pinCount - 1 && PIN_EDGE,
													numeric(col.field) && 'text-right tabular-nums'
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
													<!-- one line: a long value truncates, its full text is the tooltip -->
													<div
														class={[
															'truncate [&_[data-enum-list]]:flex-nowrap',
															w === undefined && 'max-w-80',
															ci === 0 && opens && 'pr-7'
														]}
														title={fullText(row, col.field) || undefined}
													>
														{@render cell(row, col)}
													</div>
												{/if}
												{#if ci === 0 && opens}
													<!-- the open button : shown on hover or focus, beside the row's own click -->
													<button
														type="button"
														class="bg-card text-muted-foreground hover:text-foreground hover:bg-accent focus-visible:ring-ring absolute top-1/2 right-1 grid size-6 -translate-y-1/2 place-items-center rounded-sm border opacity-0 shadow-xs outline-none group-hover/row:opacity-100 group-focus-within/row:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 [@media(hover:none)]:opacity-100"
														aria-label={msg(bolt, 'table.openRow', 'Open')}
														title={msg(bolt, 'table.openRow', 'Open')}
														onclick={() => open(row)}
														data-row-open><Glyph name="expand" class="size-3.5" /></button
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
					{#if layout !== 'grid' && !(kind === 'local' && onChange)}
						<ul
							class="min-h-0 flex-1 divide-y overflow-auto rounded-t-md @3xl:hidden"
							data-table-list
						>
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
										recordRow(row) && selected.has(row.id) ? 'bg-accent/40' : 'hover:bg-muted/40'
									]}
									{@attach narrow.measure(rowKey(i))}
								>
									<ApprovalAccent {row} />
									{#if selectable && recordRow(row)}
										<input
											class="mt-1"
											type="checkbox"
											aria-label={msg(bolt, 'table.select', 'Select')}
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
												>{@render cell(row, lead)}</span
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
															>{msg(bolt, 'table.moreFields', '+{n} fields', {
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
							{#if narrow.after > 0}<li
									aria-hidden="true"
									style="height:{narrow.after}px"
								></li>{/if}
						</ul>
					{/if}
					{@render footer()}
				</div>
			{/if}
		{/snippet}
	</ReadGate>
</section>
