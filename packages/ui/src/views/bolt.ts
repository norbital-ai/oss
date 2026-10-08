// The views' side of `$bolt` (§3.5): the members a view calls, structurally, so ui needs no bolt dependency. The shell
// hands the page's `bolt` to every view once with `provideBolt` (hook:ui-shell); a view never takes a client prop.
import { getContext, setContext, type Component } from 'svelte';
import type { Offer, OrderBy } from './filter.js';
import { enumText } from '../kinds/kind.js';
import { label } from './model.js';

export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
export type Row = { readonly [field: string]: Json };
export type Page<T = Row> = { rows: readonly T[]; next: string | null };
export type WireRead = { m: string; a: readonly Json[] };
export type Q<T> = PromiseLike<T> & { readonly read: WireRead };
export type LiveError = { code: string; message: string };
export type Live<T> = { readonly current: T | undefined; readonly error: LiveError | undefined; subscribe(run: (value: T | undefined) => void): () => void };
export type Outcome =
	| { kind: 'committed'; output: Json; records: readonly { collection: string; id: string; revision: number }[] }
	| { kind: 'pendingApproval'; requestId: string; records: readonly { collection: string; id: string; revision: number }[] }
	| { kind: 'refused'; code: string; message: string; field?: string; row?: number }
	| { kind: 'conflict'; records: readonly { collection: string; id: string; fields: readonly string[] }[] }
	| { kind: 'unknown'; invocation: string };
/** `start`'s answer: the run's id and automation at once, its start's outcome when awaited. */
export type RunHandle = PromiseLike<Outcome> & { readonly id: string; readonly automation: string };
export type FileRef = { id: string; name: string; mime: string };
/** Rule 56's run row as its viewer may read it. */
export type RunRow = { id: string; automation: string; status: string; progress?: Json; error?: { code: string; message?: string } | null;
	attempt_count?: number; result?: Json; due_at?: string; started?: string | null };

/** One approval request as its participants (and readers of the held record) see it, the host deciding every flag. */
export type ApprovalView = {
	id: string; collection: string; record: string; action: string; at: string;
	status: string; step: number; steps: readonly (readonly string[])[]; superceded_by: readonly string[];
	requestor: { ref: string; name: string | null };
	decisions: readonly { step: number; status: string; by: { ref: string; name: string | null }; reason: string | null; at: string }[];
	appliedAt: string | null; restoredAt: string | null;
	mine: boolean; canDecide: boolean; canSupersede: boolean; participant: boolean;
};

/** The client a view reads and acts through (the page's `$bolt`), as `provideBolt` hands it to the views. */
export type ViewBolt = {
	read<T = Page>(collection: string, options: Json): Q<T>;
	/** `{ revision }`: the record as of that revision (L-BOLT-181), for the record shell's scrubber. */
	get<T = Row | null>(collection: string, id: string, select?: Json, options?: { revision?: number }): Q<T>;
	aggregate<T = readonly Row[]>(collection: string, options: Json): Q<T>;
	history<T = Json>(collection: string, id: string, options?: { at?: Json }): Q<T>;
	query<T = Json>(name: string, input: Json): Q<T>;
	/** A named similarity search (§3.3.4): `similar(c, '<name>', input, { where?, select?, limit })`, nearest first. */
	similar?<T = readonly Row[]>(collection: string, search: string, input: Json, options: Json): Q<T>;
	live<T>(q: Q<T>, options?: { every?: string; on?: readonly string[] }): Live<T>;
	act(callable: string, input: Json, options?: { key?: string }): Promise<Outcome>;
	start(automation: string, input: Json): RunHandle;
	/** §3.5 `runs(automation, { where?, limit })`; absent until the client serves it (views then say so). */
	runs?(automation: string, options: { where?: Json; limit: number }): Live<Page<RunRow>>;
	fileUrl(ref: FileRef): string;
	/** §3.5 rule 11a in the browser: each top-level condition and sort key kept or dropped alone. Absent → the view's own check. */
	decode?(collection: string, q: { where?: Json; orderBy?: Json }): { where: Json; orderBy?: Json; dropped: readonly { path: string; message: string }[] };
	/** Rule 16a `filter.describe`: present only when the host binds `decisions` or `ai` (P19); rejects when no filter could be built. */
	describe?(collection: string, text: string, fields?: readonly { name: string; label: string; kind: 'text' | 'number' | 'bool'; optional?: boolean }[]): PromiseLike<{ where: Json; orderBy?: Json }>;
	/** Rule 16b `filter.options`: the same condition catalogue a description is offered, so the builder renders exactly what it may author. */
	options?(collection: string, fields?: readonly { name: string; label: string; kind: 'text' | 'number' | 'bool'; optional?: boolean }[]): PromiseLike<{ fields: readonly Offer[] }>;
	approvals: {
		process(requestId: string, decision: { status: 'APPROVED' | 'REJECTED' | 'REQUEST_FOR_CHANGE' | 'SUPERSEDED'; reason?: string }): Promise<Outcome>;
		withdraw(requestId: string): Promise<Outcome>;
		/** The approval view (§3.8): the request, its flow and decisions, and what the viewer may do; `null` when not visible. */
		get?(requestId: string): Promise<ApprovalView | null>;
		/** The approval views the caller may see, open ones unless `all`, by `collection`, `records` or request `ids`. */
		list?(filter?: { collection?: string; records?: readonly string[]; ids?: readonly string[]; all?: boolean }): Promise<ApprovalView[]>;
	};
	actor: Json;
	locale: string;
	t(key: string, vars?: { readonly [name: string]: string | number }): string;
};

/**
 * The workspace's names as its views see them. Empty here, so ui stays workspace-agnostic: `@norbital-ai/bolt` fills
 * `names` from the workspace's generated index, and `of`, `columns`, `values`, `record` and ids are then checked per
 * collection. Unfilled (a host, ui's own tests), any name and any row goes.
 */
// biome-ignore lint/suspicious/noEmptyInterface: augmentation target
export interface Workspace {}
type Loose = {
	collections: { [c: string]: { row: Row; record: Row; insert: Row; where: { readonly [key: string]: Json };
		orderBy: OrderBy } };
	queries: { [q: string]: { input: Json; output: unknown } };
	actions: { [a: string]: Row };
	automations: { [a: string]: Row };
};
type Shape = {
	collections: { [c: string]: { row: object; record: object; insert: object; where: unknown; orderBy: unknown } };
	queries: { [q: string]: { input: unknown; output: unknown } };
	actions: { [a: string]: unknown };
	automations: { [a: string]: unknown };
};
type Names = Workspace extends { names: infer N extends Shape } ? [N] extends [never] ? Loose : N : Loose;
type Collections = Names['collections'];
export type CollectionKey = keyof Collections & string;
/**
 * A collection's row as a view's read returns it (json, custom and file fields only when selected), its whole row as a
 * record view reads it, its create input, its filter and its sort.
 */
export type RowOf<C> = C extends keyof Collections ? Collections[C]['row'] : Row;
/** A collection's whole row as a record view reads it. */
export type RecordOf<C> = C extends keyof Collections ? Collections[C]['record'] : Row;
/** A collection's many-relations a view may name as a column (read with their labels, one statement). */
export type ManyOf<C> = C extends keyof Collections ? Collections[C] extends { many: infer M extends string } ? M : never : never;
/** A collection's create input. */
export type InsertOf<C> = C extends keyof Collections ? Collections[C]['insert'] : Row;
export type WhereOf<C> = C extends keyof Collections ? Collections[C]['where'] : Loose['collections'][string]['where'];
export type OrderByOf<C> = C extends keyof Collections ? Collections[C]['orderBy'] : Loose['collections'][string]['orderBy'];
export type FieldOf<C> = C extends unknown ? keyof RowOf<C> & string : never;
export type RecordFieldOf<C> = C extends unknown ? keyof RecordOf<C> & string : never;
export type IdOf<C> = C extends unknown ? RowOf<C> extends { readonly id: infer I extends string } ? I : string : never;
/** `'<c>.<q>'` queries and `'<c>.<verb|action>'` callables, with their inputs. */
export type QueryKey = keyof Names['queries'] & string;
export type QueryInputOf<N> = N extends keyof Names['queries'] ? Names['queries'][N]['input'] : Json;
export type QueryOutputOf<N> = N extends keyof Names['queries'] ? Names['queries'][N]['output'] : unknown;
export type ActionKey = keyof Names['actions'] & string;
export type ActionInputOf<N> = N extends keyof Names['actions'] ? Names['actions'][N] : Row;

/** X-20: what a `+representation.svelte` receives, `{ view: RecordView<'<collection>'> }`. */
export type RecordView<C extends string = string> =
	| { collection: C; mode: 'update'; record: RecordOf<C> } | { collection: C; mode: 'create'; values: Partial<InsertOf<C>> };

const RECORD_VIEW = Symbol('ui.views.recordView');
/** Set by `RecordShell` for its body: the record it shows, the scrubbed revision while one is picked. */
export const provideRecordView = (v: { readonly current: RecordView | null }) => setContext(RECORD_VIEW, v);
/** The record the nearest `RecordShell` shows (`current` is the scrubbed revision while one is picked); absent outside one. */
export const useRecordView = () => getContext<{ readonly current: RecordView | null } | undefined>(RECORD_VIEW);
const BOLT = Symbol('ui.views.bolt');
const REPRESENTATIONS = Symbol('ui.views.representations');
/** Hands the page's client to every view beneath; the shell calls it once per page. */
export const provideBolt = (bolt: ViewBolt) => setContext(BOLT, bolt);
export function useBolt(): ViewBolt {
	const bolt = getContext<ViewBolt | undefined>(BOLT);
	if (bolt === undefined) throw new Error('A view needs the shell: call provideBolt(bolt) above it.');
	return bolt;
}
const COLLECTION = Symbol('ui.views.collection');
/** The collection the values beneath belong to (a Table's, a record's, a Form's): their enum words read its catalog keys. */
export const provideCollection = (of: () => string) => setContext(COLLECTION, of);
/** The collection named by the nearest `provideCollection`, or `undefined` outside one. */
export const useCollectionKey = (): string | undefined => getContext<(() => string) | undefined>(COLLECTION)?.();
/**
 * An enum or state value's words beneath a view: `models.<c>.fields.<field>.<value>` through the page's `t` when a
 * shell and a collection are above, else the value in words (`enumText`). Call it at a component's init.
 */
export function useEnumText(): (value: string, field?: string) => string {
	const bolt = getContext<ViewBolt | undefined>(BOLT), of = getContext<(() => string) | undefined>(COLLECTION);
	return (value, field) => enumText(value, { ...(bolt === undefined ? {} : { t: (k: string) => bolt.t(k) }), ...(of === undefined ? {} : { collection: of() }), ...(field === undefined ? {} : { field }) });
}
/** A field's label beneath a view: the catalog's `models.<c>.fields.<field>`, else `declared`, else the name in words. */
export function useFieldLabel(): (field: string, declared?: string) => string {
	const bolt = getContext<ViewBolt | undefined>(BOLT), of = getContext<(() => string) | undefined>(COLLECTION);
	return (field, declared) => label(bolt ?? { t: (k) => k }, of?.() ?? '', field, declared);
}
/** A collection's `+representation.svelte`, loaded on first use (its module may import `$bolt`). */
export type RepresentationLoader = () => Promise<{ default: Component<{ view: RecordView }> }>;
/** The workspace's representations per collection (the generated registry), set by the shell above every page. */
export const provideRepresentations = (map: { readonly [collection: string]: RepresentationLoader }) => setContext(REPRESENTATIONS, map);
export const representations = () => getContext<{ readonly [c: string]: RepresentationLoader } | undefined>(REPRESENTATIONS);

let carried: { record: string; contexts: ReadonlyMap<unknown, unknown> } | null = null;
/**
 * Opens the shell's record sheet: `?record=<collection>/<id|new>`, the form the shell's `bolt.href` writes and reads,
 * stacked on any sheet already open.
 * The sheet mounts outside the page, so `contexts` (the opener's `getAllContexts()`, taken at its init) carry the page's
 * scope into it: a create opened from a scoped page keeps its presets and narrowed pickers. They live in memory only.
 */
export function openRecord(collection: string, id: string | 'new', contexts?: ReadonlyMap<unknown, unknown>): void {
	carried = contexts === undefined ? null : { record: `${collection}/${id}`, contexts };
	const url = new URL(location.href), key = `${collection}/${id}`;
	// the record-sheet stack (rule 10): a record opened from an open sheet stacks on it; one already open becomes the top
	// a record just created replaces its own create sheet, never stacks on it
	const all = url.searchParams.getAll('record');
	const stack = id !== 'new' && all.at(-1) === `${collection}/new` ? all.slice(0, -1) : all, at = stack.indexOf(key);
	url.searchParams.delete('record');
	for (const r of at < 0 ? [...stack, key] : stack.slice(0, at + 1)) url.searchParams.append('record', r);
	history.pushState(history.state, '', url);
	dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
}
/**
 * The contexts of the views on the page, by collection: a sheet opened with nothing carried (a reload or a link with
 * `?record=` in it) takes the scope of the page it opens over, as its own New button would have given it.
 */
const onPage = new Map<string, ReadonlyMap<unknown, unknown>>();
const listeners = new Set<() => void>();
/** A view offers its page's contexts for its collection while mounted; the returned function withdraws them. */
export function offerContexts(collection: string, contexts: ReadonlyMap<unknown, unknown>): () => void {
	onPage.set(collection, contexts);
	for (const l of listeners) l();
	return () => { if (onPage.get(collection) === contexts) onPage.delete(collection); };
}
/** The page's contexts for `collection`: a view's own collection first; else the page's (`'*'`, offered by `AppShell`). */
export const pageContexts = (collection: string) => onPage.get(collection) ?? onPage.get('*');
/** Subscribes to a view offering its contexts after a reader asked; the returned function unsubscribes. */
export function onPageContexts(listener: () => void): () => void {
	listeners.add(listener);
	return () => { listeners.delete(listener); };
}
/** The contexts the last `openRecord` of this record carried, taken once: the shell's sheet sets them above its
 * `RecordShell`; an opening that carried none (a reload, a link) takes the page's own (`pageContexts`). */
export function carriedContexts(collection: string, id: string): ReadonlyMap<unknown, unknown> | undefined {
	const c = carried?.record === `${collection}/${id}` ? carried.contexts : undefined;
	carried = null;
	return c;
}
