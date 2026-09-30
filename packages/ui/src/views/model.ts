// The views' pure logic: values, read states, table URL state and filters, local-array edits, Rows ops, Matrix cells,
// Pivot grids, Chart series, the approval diff and run facts. No DOM and no relative value imports, so Node runs it.
import type { CollectionExposure } from '../kinds/context.js';
import type { Fields, Kind } from '../kinds/kind.js';
import type { FileRef, Json, Live, LiveError, Outcome, Q, Row, RunRow, ViewBolt } from './bolt.js';

// ── messages and labels ──
const fill = (s: string, vars: { readonly [n: string]: string | number }) => s.replace(/\{(\w+)\}/g, (m, n: string) => vars[n] === undefined ? m : String(vars[n]));
/** The ui's own keys (`ui.*`) fall back to English outside a catalog. */
export function msg(bolt: Pick<ViewBolt, 't'>, key: string, fallback: string, vars: { readonly [n: string]: string | number } = {}): string {
	const s = bolt.t(`ui.${key}`, vars);
	return s === `ui.${key}` ? fill(fallback, vars) : s;
}
export const humanize = (name: string) => name.replace(/[_.]+/g, ' ').trim().replace(/^\w/, (c) => c.toUpperCase());
/**
 * A collection's or field's label: the catalog key, else the field's `declared` label, else the humanized name (final-ui
 * rule 32); a FK names its target (`project_id` → `Project`).
 */
export function label(bolt: Pick<ViewBolt, 't'>, collection: string, field?: string, declared?: string): string {
	const key = field === undefined ? `models.${collection}.label` : `models.${collection}.fields.${field}`;
	const s = bolt.t(key);
	return s !== key ? s : declared ?? humanize((field ?? collection).replace(/_id$/, ''));
}
/** A label inside a sentence: its first letter lowered unless it leads an acronym (`Jobs` → `jobs`, `SOW documents` stays). */
export const lowerLead = (s: string) => /^\p{Lu}\p{Ll}/u.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s;
/** One record of a collection: the catalog's `models.<c>.singular`, else its label made singular (`Categories` → `Category`). */
export function singular(bolt: Pick<ViewBolt, 't'>, collection: string): string {
	const key = `models.${collection}.singular`, s = bolt.t(key);
	return s !== key ? s : label(bolt, collection).replace(/ies$/, 'y').replace(/(ss|x|ch|sh)es$/, '$1').replace(/([^su])s$/, '$1');
}

// ── read state: no grant is never "no rows" (final-ui B7; memory plausible-emptiness-is-suspicious) ──
export type ReadState<T> = { kind: 'loading' } | { kind: 'noAccess' } | { kind: 'error'; code: string; message: string } | { kind: 'ready'; value: T };
export function readState<T>(value: T | undefined, error: LiveError | undefined): ReadState<T> {
	if (error !== undefined) return error.code === 'forbidden' ? { kind: 'noAccess' } : { kind: 'error', code: error.code, message: error.message };
	return value === undefined ? { kind: 'loading' } : { kind: 'ready', value };
}
/** A one-shot read's rejection as a state (reads reject with `{ code }`, §3.5). */
export const failed = (e: unknown): ReadState<never> => {
	const code = typeof e === 'object' && e !== null && 'code' in e ? String(e.code) : 'error';
	return code === 'forbidden' ? { kind: 'noAccess' } : { kind: 'error', code, message: e instanceof Error ? e.message : String(e) };
};
/** The signed-in member's id, or null for any other actor. */
export const actorId = (actor: Json): string | null => isRow(actor) && typeof actor['id'] === 'string' ? actor['id'] : null;
export const isRow = (v: unknown): v is Row => typeof v === 'object' && v !== null && !Array.isArray(v);
/** The rows of a `Page`, an array, or nothing. */
export const rowsOf = (v: unknown): readonly Row[] =>
	(Array.isArray(v) ? v : isRow(v) && Array.isArray(v['rows']) ? v['rows'] as readonly Json[] : []).filter(isRow);
export const nextOf = (v: unknown): string | null => isRow(v) && typeof v['next'] === 'string' ? v['next'] : null;

// ── values ──
const TAGS = ['$dec', '$t', '$d'];
/** hook:codec — `$bolt` hands std's `Decimal` (no own fields, `toJSON` its exact text) where the wire had `$dec`. */
export const isDecimal = (v: unknown): v is { toJSON(): string } => typeof v === 'object' && v !== null && !Array.isArray(v)
	&& Object.keys(v).length === 0 && typeof (v as { toJSON?: unknown }).toJSON === 'function';
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
/** A wire value as plain data: tagged decimals become numbers, tagged dates and instants their ISO text. */
export function plain(v: Json | undefined): Json {
	if (isDecimal(v)) return Number(v.toJSON()); // hook:codec
	if (!isRow(v)) return v ?? null;
	const keys = Object.keys(v);
	if (keys.length === 1 && TAGS.includes(keys[0]!)) return keys[0] === '$dec' ? Number(v['$dec']) : v[keys[0]!]!;
	return v;
}
export const isMasked = (v: Json | undefined) => isRow(v) && v['$masked'] === true;
export const isFile = (v: unknown): v is FileRef => isRow(v) && typeof v['id'] === 'string' && typeof v['name'] === 'string' && typeof v['mime'] === 'string';
export const filesOf = (v: Json | undefined): readonly FileRef[] => (Array.isArray(v) ? v : [v]).filter(isFile);
/** An instant: a medium date and a short time, never seconds. */
const AT = { dateStyle: 'medium', timeStyle: 'short' } as const;
/** Display text for one value in the viewer's locale; a masked value is a locked dash (OD-UI-6). */
export function show(v: Json | undefined, locale = 'en'): string {
	if (v === null || v === undefined) return '';
	if (isMasked(v)) return '•••';
	if (typeof v === 'boolean') return v ? '✓' : '✗';
	if (typeof v === 'number') return new Intl.NumberFormat(locale).format(v);
	if (typeof v === 'string') return INSTANT.test(v) ? new Date(v).toLocaleString(locale, AT) : v; // hook:codec — a decoded instant
	if (isDecimal(v)) return new Intl.NumberFormat(locale, { maximumFractionDigits: 20 }).format(Number(v.toJSON())); // hook:codec
	if (Array.isArray(v)) return v.map((x) => show(x, locale)).join(', ');
	const o = v as Row;
	if ('$dec' in o) return new Intl.NumberFormat(locale, { maximumFractionDigits: 20 }).format(Number(o['$dec']));
	if ('$d' in o) return String(o['$d']);
	if ('$t' in o) return new Date(String(o['$t'])).toLocaleString(locale, AT);
	if ('from' in o || 'start' in o) return `${show(o['from'] ?? o['start'], locale)} – ${show(o['to'] ?? o['end'], locale) || '…'}`;
	if ('lat' in o && 'lng' in o) return `${o['lat']}, ${o['lng']}`;
	if (isFile(o)) return o.name;
	if ('collection' in o && 'id' in o) return String(o['id']);
	return JSON.stringify(o);
}
/** Typed text in the shape of a sample value of the same field: a number, a boolean, else the literal text. */
export function like(sample: Json | undefined, text: string): Json {
	if (text === '') return null;
	const s = sample ?? null;
	if (typeof s === 'number') return Number(text);
	if (typeof s === 'boolean') return text === 'true';
	return text;
}
export function outcomeText(bolt: Pick<ViewBolt, 't'>, o: Outcome): string {
	switch (o.kind) {
		case 'committed': return msg(bolt, 'outcome.saved', 'Saved');
		case 'pendingApproval': return msg(bolt, 'outcome.pending', 'Submitted for review');
		case 'refused': return o.message;
		case 'conflict': return msg(bolt, 'outcome.conflict', 'Someone else changed this; reload and try again');
		case 'unknown': return msg(bolt, 'outcome.unknown', "Couldn't confirm; check again");
	}
}
/** `and` of the author's scope and the viewer's clauses; the viewer never widens the author's `where` (final-ui rule 6). */
export function and(...parts: readonly (Json | undefined)[]): Json | undefined {
	const list = parts.filter((p): p is Json => p !== undefined && p !== null && !(isRow(p) && Object.keys(p).length === 0));
	return list.length === 0 ? undefined : list.length === 1 ? list[0] : { and: list };
}

// ── Table: columns, URL state (the view popover's filter and sort are `filter.ts`), local arrays ──
/** A field path's value (`'account.name'` reads a selected one-relation). */
export const valueAt = (row: Row, path: string): Json | undefined =>
	path.split('.').reduce<Json | undefined>((v, k) => isRow(v) ? v[k] : undefined, row);

export type TableState = { after: string | null; q: string };
/** Cursor and search from the URL (`?<key>.after=…`, final-ui rule 8). */
export const readTableState = (params: URLSearchParams, key: string): TableState => ({ after: params.get(`${key}.after`), q: params.get(`${key}.q`) ?? '' });
export function writeTableState(params: URLSearchParams, key: string, s: TableState): URLSearchParams {
	const out = new URLSearchParams(params);
	const put = (k: string, v: string | null) => v === null || v === '' ? out.delete(`${key}.${k}`) : out.set(`${key}.${k}`, v);
	put('after', s.after);
	put('q', s.q);
	return out;
}
/** Drops `undefined` members, so an options literal is `Json`. */
export const compact = (o: { readonly [k: string]: Json | undefined }): Json =>
	Object.fromEntries(Object.entries(o).filter((e): e is [string, Json] => e[1] !== undefined));
/** L-BOLT-495: `/semantic <text>` reads the search box by meaning (rule 16), fused with the lexical match. */
export const SEMANTIC_SEARCH = /^\/semantic(\s+|$)/;
/**
 * The toolbar's `/<name>` search indexes: `semantic` over `search.semantic` (text, sent as `/semantic <text>`), then each
 * named similarity the viewer reads and each named query it holds, taking its typed `input`. `why` says why the box cannot
 * run one: an input a person never types (a raw vector, a derived kind), or a view that cannot show ranked rows (`typed` false).
 */
export type SearchIndex = { name: string; hint: string; via?: 'similar' | 'query'; input?: Fields; why: string | null };
export function searchIndexes(x: CollectionExposure | undefined, typed: boolean, text: { meaning: string; raw: string; view: string }): SearchIndex[] {
	const untypable = (k: Kind): boolean => ['seq', 'sum', 'count', 'vector', 'state'].includes(k.kind) || (k.kind === 'list' && k.of.kind === 'number');
	const named = (via: 'similar' | 'query', of: { readonly [n: string]: { input: Fields; description: string } } = {}): SearchIndex[] =>
		Object.entries(of).map(([name, s]) => {
			const raw = Object.entries(s.input).find(([, k]) => untypable(k))?.[0];
			return { name, hint: s.description, via, input: s.input, why: raw !== undefined ? fill(text.raw, { field: s.input[raw]?.label ?? humanize(raw) }) : typed ? null : text.view };
		});
	return [...(x?.semantic === true ? [{ name: 'semantic', hint: text.meaning, why: null }] : []), ...named('similar', x?.similarity), ...named('query', x?.queries)];
}
/** A `/` the box holds with no index chosen yet: the picker's text, never a search term. */
export const SLASH = /^\/\S*$/;
/**
 * The rows a `/<query>` index answers, in its order: a query whose output is a list of objects naming `collection` by an
 * `id` field returns those ids (the view reads the rows); any other output is taken as the rows themselves.
 */
export function queryIds(out: unknown, output: Kind | undefined, collection: string): { ids: string[] } | { rows: readonly Row[] } {
	const item = output?.kind === 'list' && output.of.kind === 'object' ? output.of.fields : undefined;
	const key = Object.entries(item ?? {}).find(([, k]) => k.kind === 'id' && k.of === collection)?.[0];
	if (key === undefined) return { rows: rowsOf(out) };
	return { ids: [...new Set(rowsOf(out).map((r) => r[key]).filter((v): v is string => typeof v === 'string'))] };
}
/** A local array's search over its columns (PH GAP-15: client-side). */
export const searchRows = (rows: readonly Row[], q: string, fields: readonly string[]): readonly Row[] => {
	const t = q.trim().toLowerCase();
	return t === '' ? rows : rows.filter((r) => fields.some((f) => show(valueAt(r, f)).toLowerCase().includes(t)));
};
/** Excel reads a CSV as UTF-8 (Chinese included) only behind this byte-order mark. */
export const CSV_BOM = '\uFEFF';
/** One CSV cell: a relation by its label, an enum or state by its `words`, a date or an instant as its ISO text (what a
 * spreadsheet parses), the rest as shown. */
export function csvCell(row: Row, f: string, kind: Kind | undefined, words: (value: string) => string, locale = 'en'): string {
	const ref = refOf(row, f);
	if (ref !== undefined) return ref.text;
	const v = plain(valueAt(row, f));
	if (kind?.kind === 'enum' || kind?.kind === 'state') return (Array.isArray(v) ? v : [v]).filter((x) => x !== null).map((x) => words(String(x))).join(', ');
	if (typeof v === 'string' && (kind?.kind === 'date' || kind?.kind === 'instant' || INSTANT.test(v))) return v;
	return show(valueAt(row, f), locale);
}
/** "rows 26–50 of 312" (final-ui rule 7); the count may still be loading. */
export function rangeText(bolt: Pick<ViewBolt, 't'>, offset: number, shown: number, count: number | null): string {
	const from = shown === 0 ? 0 : offset + 1, to = offset + shown;
	if (shown === 0 && offset === 0) return msg(bolt, 'table.none', 'No rows');
	// the count is re-read at most every 30 s (rule 7): a live page ahead of it shows the rows it has, not a stale total
	return count === null || count < to ? msg(bolt, 'table.range', 'rows {from}–{to}', { from, to }) : msg(bolt, 'table.rangeOf', 'rows {from}–{to} of {count}', { from, to, count });
}
/** The count answer of `aggregate(c, { count: true, where })`. */
export const countOf = (v: unknown): number | null => {
	const r = Array.isArray(v) ? v[0] : v;
	return isRow(r) && typeof r['count'] === 'number' ? r['count'] : isRow(r) && typeof r['count'] === 'string' ? Number(r['count']) : null;
};
/** The rows a later page reads to stay live (every page up to it); past this a later page is read once. */
export const LIVE_PAGE_ROWS = 1_000;
/**
 * A view's page read (rule 64). A cursor page is not liveable, so page `index` (0-based) stays live as one live read of
 * every row up to it (no cursor), sliced to its own rows; its `next` cursor is the one after its last row. Past
 * `LIVE_PAGE_ROWS`, or with a cursor restored without its index (`index` null), the cursor page is read once. A filter
 * on `now`, `today` or a calendar start refreshes every minute unless the author set `every`.
 * ponytail: a live later page re-reads the pages before it; a keyset `where` would read only its own rows.
 */
export function pageRead<T>(bolt: Pick<ViewBolt, 'live'>, read: (limit: number, after?: string) => Q<T>, pageSize: number, index: number | null,
	after: string | null | undefined, every?: string): Live<T> {
	const live = (q: Q<T>) => {
		const tick = every ?? (/"(now|today|startOf)":/.test(JSON.stringify(q.read)) ? '1min' : undefined);
		return bolt.live(q, tick === undefined ? {} : { every: tick });
	};
	if (after === null || after === undefined) return live(read(pageSize));
	if (index !== null && index > 0 && (index + 1) * pageSize <= LIVE_PAGE_ROWS) {
		const all = live(read((index + 1) * pageSize));
		const own = (v: T | undefined): T | undefined => isRow(v) && Array.isArray(v['rows']) ? { ...v, rows: v['rows'].slice(index * pageSize) } as T : v;
		return { get current() { return own(all.current); }, get error() { return all.error; }, subscribe: (run) => all.subscribe((v) => run(own(v))) };
	}
	return once(read(pageSize, after));
}
/** A read that is not liveable (a cursor page, a similarity search), as a `Live` that answers once. */
export function once<T>(q: PromiseLike<T>): Live<T> {
	let current: T | undefined, error: LiveError | undefined;
	const runs = new Set<(v: T | undefined) => void>();
	q.then((v) => { current = v; for (const r of runs) r(v); }, (e: unknown) => { error = { code: typeof e === 'object' && e !== null && 'code' in e ? String(e.code) : 'error', message: e instanceof Error ? e.message : String(e) }; for (const r of runs) r(undefined); });
	return { get current() { return current; }, get error() { return error; },
		subscribe(run) { runs.add(run); if (current !== undefined || error !== undefined) run(current); return () => void runs.delete(run); } };
}
/** Rule 7: a count is re-issued at most once every 30 s while the live page reports changes. */
export const COUNT_EVERY_MS = 30_000;

// local-array edits: each returns a fresh array (memory svelte-state-ignores-same-reference)
export const setCell = (rows: readonly Row[], i: number, field: string, value: Json): Row[] => rows.map((r, j) => j === i ? { ...r, [field]: value } : r);
export const removeRow = (rows: readonly Row[], i: number): Row[] => rows.filter((_, j) => j !== i);

// ── Rows: a child relation's edits as explicit relation ops, never deletes by omission (memory collection-write-contract) ──
export type RowsOps = { create?: Row[]; update?: { target: string; set: Row }[]; delete?: string[] };
export function rowsOps(loaded: readonly Row[], current: readonly Row[], removed: readonly string[]): RowsOps {
	const byId = new Map(loaded.map((r) => [String(r['id']), r]));
	const create: Row[] = [], update: { target: string; set: Row }[] = [];
	for (const r of current) {
		const was = typeof r['id'] === 'string' ? byId.get(r['id']) : undefined;
		if (was === undefined) { const { id: _, ...values } = r; create.push(values); continue; }
		const set = Object.fromEntries(Object.entries(r).filter(([k, v]) => k !== 'id' && JSON.stringify(v) !== JSON.stringify(was[k] ?? null)));
		if (Object.keys(set).length > 0) update.push({ target: String(r['id']), set });
	}
	const del = removed.filter((id) => byId.has(id));
	return { ...(create.length ? { create } : {}), ...(update.length ? { update } : {}), ...(del.length ? { delete: del } : {}) };
}

// ── Matrix: rows × columns, items bucketed per cell ──
export const cellKey = (row: Json, col: Json) => `${String(plain(row))}|${JSON.stringify(plain(col))}`;
/** Items keyed by `<row id>|<column value>`; a relation value is read by its id. */
export function matrixCells(items: readonly Row[], rowField: string, colField: string): Map<string, Row[]> {
	const id = (v: Json | undefined): Json => isRow(v) && 'id' in v ? v['id']! : v ?? null;
	const out = new Map<string, Row[]>();
	for (const it of items) {
		const k = cellKey(id(it[rowField]), id(valueAt(it, colField)));
		out.set(k, [...(out.get(k) ?? []), it]);
	}
	return out;
}
/** `select` as a read's select object (final-ui 29b: the cell fields and the axes, never the whole row). */
export const selectOf = (fields: readonly string[]): Json => Object.fromEntries([...new Set(fields)].map((f) => [f, true]));
export const MATRIX_PAGE = 50;
const HEAVY = new Set(['json', 'custom', 'file']);
/** A list read leaves out json, custom and file fields (X-33): naming one reads the exposed fields, the relations and every named field. */
export function heavySelect(exposure: CollectionExposure | undefined, named: readonly string[]): Json | undefined {
	const fields = exposure?.fields ?? {};
	const heavy = (f: string) => HEAVY.has(fields[f]?.kind ?? '');
	return named.some(heavy) ? selectOf([...Object.keys(fields).filter((f) => !f.includes('.') && !heavy(f)), ...Object.keys(exposure?.relations ?? {}), ...named])
		: undefined;
}
type Catalog = { readonly [collection: string]: CollectionExposure } | undefined;
/** A many-relation's child: the collection whose one-relation names `rel` as its inverse onto `of`. */
export function manyTarget(cat: Catalog, of: string, rel: string): string | undefined {
	if (!(cat?.[of]?.many ?? []).includes(rel)) return undefined;
	return Object.keys(cat!).find((c) => Object.values(cat![c]!.relations ?? {}).some((r) => r.inverse === rel && r.targets.includes(of)));
}
/** The fields a relation's target is shown by (RecordShell's rule: the relation's `label`, else the target's declared
 * `label`), those the caller reads; none for an arc or a target outside the catalog. A many-relation shows its child's. */
export function refLabel(cat: Catalog, of: string, rel: string): readonly string[] {
	const one = cat?.[of]?.relations?.[rel];
	const target = one === undefined ? manyTarget(cat, of, rel) : one.targets.length === 1 ? one.targets[0] : undefined;
	const t = target === undefined ? undefined : cat?.[target];
	return t === undefined ? [] : [one?.label ?? t.label].flat().filter((l) => t.fields[l] !== undefined);
}
/** A many-relation cell's labels read with the row: the first `MANY_SHOWN`, one more to know there are more. */
export const MANY_SHOWN = 20;
/**
 * A list read's select: `heavySelect`, and each relation in `refs` has its target's label read in the same statement
 * (no read per row, rule 12): a one-relation as a nested row, a named many-relation as its first `MANY_SHOWN + 1` rows.
 */
export function listSelect(cat: Catalog, of: string, named: readonly string[], refs = named): Json | undefined {
	const many = (f: string) => manyTarget(cat, of, f) !== undefined;
	const arms = Object.fromEntries([
		...refs.flatMap((fk) => { const l = refLabel(cat, of, fk); return l.length > 0 && !many(fk) ? [[fk, { select: selectOf(l) }]] : []; }),
		...named.filter(many).map((m) => [m, { select: selectOf(refLabel(cat, of, m)), limit: MANY_SHOWN + 1 }]),
	]);
	const own = named.filter((f) => !many(f));
	if (Object.keys(arms).length === 0) return heavySelect(cat?.[of], own);
	const x = cat![of]!;
	return { ...selectOf([...Object.keys(x.fields).filter((f) => !f.includes('.') && !HEAVY.has(x.fields[f]?.kind ?? '')), ...Object.keys(x.relations ?? {}), ...own]) as Row, ...arms };
}
/** A relation cell's link: the target collection and its label text; a many-relation also lists each record (`more`: past `MANY_SHOWN`). */
export type Ref = { of: string; text: string; items?: readonly { id: string; text: string }[]; more?: true };
export type Refs = { readonly [rel: string]: Ref };
/** Rows read by `listSelect` back to their FK ids (a many-relation to its ids), each target's label beside them in `$refs` (the default cell's link). */
export function unref(cat: Catalog, of: string, refs: readonly string[], rows: readonly Row[], locale = 'en'): readonly Row[] {
	const rels = refs.filter((r) => refLabel(cat, of, r).length > 0 || manyTarget(cat, of, r) !== undefined);
	if (rels.length === 0) return rows;
	const text = (rel: string, t: Row) => refLabel(cat, of, rel).map((l) => show(t[l] ?? null, locale)).filter(Boolean).join(' · ') || '—';
	return rows.map((r) => {
		const refs: { [rel: string]: Ref } = {};
		const out: { [f: string]: Json } = { ...r };
		for (const rel of rels) {
			const t = r[rel], child = manyTarget(cat, of, rel);
			if (child !== undefined) {
				const list = (Array.isArray(t) ? t : []).filter((x): x is Row => isRow(x) && typeof x['id'] === 'string');
				const items = list.slice(0, MANY_SHOWN).map((x) => ({ id: String(x['id']), text: text(rel, x) }));
				out[rel] = items.map((i) => i.id);
				refs[rel] = { of: child, text: items.map((i) => i.text).join(', '), items, ...(list.length > MANY_SHOWN ? { more: true as const } : {}) };
				continue;
			}
			if (!isRow(t) || typeof t['id'] !== 'string') { out[rel] = null; continue; } // ponytail: an unreadable target reads as null, so its FK id is lost
			out[rel] = t['id'];
			refs[rel] = { of: cat![of]!.relations![rel]!.targets[0]!, text: text(rel, t) };
		}
		return { ...out, $refs: refs as Json };
	});
}
export const refOf = (row: Row, rel: string): Ref | undefined => isRow(row['$refs']) ? (row['$refs'] as unknown as Refs)[rel] : undefined;

// ── Pivot and Chart ──
/** An aggregate row flattened: `{ key: { region }, count, sum: { amount } }` → `{ region, count, 'sum.amount' }`, numbers plain. */
export function flat(row: Row): { [k: string]: Json } {
	const out: { [k: string]: Json } = {};
	for (const [k, v] of Object.entries(row)) {
		if (k === 'key' && isRow(v)) Object.assign(out, Object.fromEntries(Object.entries(v).map(([f, x]) => [f, plain(x)])));
		else if (isRow(v) && !TAGS.some((t) => t in v) && ['sum', 'avg', 'min', 'max'].includes(k)) for (const [f, x] of Object.entries(v)) out[`${k}.${f}`] = plain(x);
		else out[k] = plain(v);
	}
	return out;
}
export type PivotValue<F extends string = string> = { sum: F } | { count: true };
const valueKey = (v: PivotValue) => 'sum' in v ? `sum.${v.sum}` : 'count';
/** An aggregate over `by: [rows, cols?]` as a grid with row and column totals. */
export function pivotGrid(agg: readonly Row[], rows: string, cols: string | undefined, value: PivotValue) {
	const k = valueKey(value), cells = new Map<string, number>();
	const rowKeys: string[] = [], colKeys: string[] = [];
	for (const r of agg.map(flat)) {
		const rk = show(r[rows] ?? null), ck = cols === undefined ? '' : show(r[cols] ?? null);
		if (!rowKeys.includes(rk)) rowKeys.push(rk);
		if (!colKeys.includes(ck)) colKeys.push(ck);
		cells.set(`${rk}|${ck}`, (cells.get(`${rk}|${ck}`) ?? 0) + Number(r[k] ?? 0));
	}
	const at = (r: string, c: string) => cells.get(`${r}|${c}`) ?? 0;
	const rowTotal = (r: string) => colKeys.reduce((s, c) => s + at(r, c), 0);
	const colTotal = (c: string) => rowKeys.reduce((s, r) => s + at(r, c), 0);
	return { rowKeys, colKeys, at, rowTotal, colTotal, total: rowKeys.reduce((s, r) => s + rowTotal(r), 0) };
}
/** Chart data: rows (read, query or aggregate) as flat records, `x` as text, each `y` a number. */
export function series(v: unknown, x: string, y: readonly string[]): { [k: string]: string | number | null }[] {
	return rowsOf(v).map(flat).map((r) => ({
		[x]: show(r[x] ?? null),
		...Object.fromEntries(y.map((k) => [k, r[k] === null || r[k] === undefined ? null : Number(r[k])])),
	}));
}

// ── approvals: the held changes against the restore point (§3.8) ──
/** A history revision as `bolt.history` answers it; a `hold` revision's `changed` is the full pre-image (null for a row the request created). */
export type Revision = { revision: number; approval_id: string | null; cause?: string; changed: Row | null };
const BOOKKEEPING = new Set(['id', 'revision', 'approval_id', 'created_at', 'created_by', 'updated_at', 'updated_by']);
/**
 * Per field: the value at the restore point (the request's first `hold` snapshot, rule 47) and the value the held
 * revisions leave, requestor's and participants' edits alike; fields they did not change, and bookkeeping, are left out.
 */
export function heldChanges(history: unknown, requestId: string): { field: string; before: Json; held: Json }[] {
	const revs = (Array.isArray(history) ? history : rowsOf(history)).filter(isRow) as unknown as Revision[];
	const writes = revs.filter((r) => r.approval_id === requestId && r.cause !== 'hold');
	if (writes.length === 0) return [];
	const hold = revs.find((r) => r.approval_id === requestId && r.cause === 'hold');
	const before: { [f: string]: Json } = {}, held: { [f: string]: Json } = {};
	if (hold !== undefined) Object.assign(before, hold.changed ?? {});
	else for (const r of revs) if (r.revision < writes[0]!.revision) Object.assign(before, r.changed);
	for (const r of writes) Object.assign(held, r.changed);
	return Object.keys(held).filter((f) => !BOOKKEEPING.has(f) && JSON.stringify(before[f] ?? null) !== JSON.stringify(held[f] ?? null))
		.map((field) => ({ field, before: before[field] ?? null, held: held[field]! }));
}

// ── runs (rule 56) ──
/** Progress as a 0–1 fraction when the run reports `{ done, total }` or a number. */
export function progressOf(run: Pick<RunRow, 'progress'>): number | null {
	const p = run.progress;
	if (typeof p === 'number') return p > 1 ? p / 100 : p;
	if (isRow(p) && typeof p['done'] === 'number' && typeof p['total'] === 'number' && p['total'] > 0) return p['done'] / p['total'];
	return null;
}
/** The files a run returned (final-ui rule 27): its output's `FileRef`s, at the top or one level in. */
export const runFiles = (run: Pick<RunRow, 'result'>): readonly FileRef[] =>
	[run.result ?? null, ...(isRow(run.result) ? Object.values(run.result) : [])].flatMap((v) => filesOf(v));

// ── the record scrubber: a record's revisions as timeline checkpoints (rule 17) ──
/** One revision on the record header's timeline: when, by whom (`kind:id` split) and which visible fields it changed. */
export type Checkpoint = { revision: number; at: string | null; actor: { kind: string; id: string } | null; fields: readonly string[] };
/** `bolt.history`'s answer as checkpoints, oldest first; bookkeeping fields are not changes. Revision 1 is the create. */
export function checkpoints(history: unknown): Checkpoint[] {
	return rowsOf(history).filter((r) => typeof r['revision'] === 'number').map((r) => {
		const a = r['actor'];
		return { revision: r['revision'] as number, at: typeof r['at'] === 'string' ? r['at'] : null,
			actor: isRow(a) && typeof a['kind'] === 'string' && typeof a['id'] === 'string' ? { kind: a['kind'], id: a['id'] } : null,
			fields: Object.keys(isRow(r['changed']) ? r['changed'] : {}).filter((f) => !BOOKKEEPING.has(f)) };
	}).sort((a, b) => a.revision - b.revision);
}
/** A revision's place on a `1..latest` ruler, in percent; one revision sits at the end. */
export const tickAt = (revision: number, latest: number) => latest <= 1 ? 100 : ((revision - 1) / (latest - 1)) * 100;
/** The revision nearest a fraction (0–1) of the ruler. */
export const tickOf = (fraction: number, latest: number) => Math.min(latest, Math.max(1, Math.round(fraction * (latest - 1)) + 1));
/** The revisions drawn as ticks: all of them up to `max`, else every n-th, the first, the last and `keep` (the playhead). */
export function drawnTicks(latest: number, max: number, keep: number | null = null): number[] {
	const step = Math.max(1, Math.ceil(latest / max));
	const out = new Set<number>();
	for (let r = 1; r <= latest; r += step) out.add(r);
	out.add(latest);
	if (keep !== null && keep >= 1 && keep <= latest) out.add(keep);
	return [...out].sort((a, b) => a - b);
}
