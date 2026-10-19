let carried: { record: string; contexts: ReadonlyMap<unknown, unknown> } | null = null;
/**
 * Opens the shell's record sheet: `?record=<collection>/<id|new>`, the form the shell's `bolt.href` writes and reads,
 * stacked on any sheet already open.
 * The sheet mounts outside the page, so `contexts` (the opener's `getAllContexts()`, taken at its init) carry the page's
 * scope into it: a create opened from a scoped page keeps its presets and narrowed pickers. They live in memory only.
 */
export function openRecord(
	collection: string,
	id: string | 'new',
	contexts?: ReadonlyMap<unknown, unknown>
): void {
	carried = contexts === undefined ? null : { record: `${collection}/${id}`, contexts };
	const url = new URL(location.href),
		key = `${collection}/${id}`;
	// the record-sheet stack (rule 10): a record opened from an open sheet stacks on it; one already open becomes the top
	// a record just created replaces its own create sheet, never stacks on it
	const all = url.searchParams.getAll('record');
	const stack = id !== 'new' && all.at(-1) === `${collection}/new` ? all.slice(0, -1) : all,
		at = stack.indexOf(key);
	url.searchParams.delete('record');
	for (const r of at < 0 ? [...stack, key] : stack.slice(0, at + 1))
		url.searchParams.append('record', r);
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
export function offerContexts(
	collection: string,
	contexts: ReadonlyMap<unknown, unknown>
): () => void {
	onPage.set(collection, contexts);
	for (const l of listeners) l();
	return () => {
		if (onPage.get(collection) === contexts) onPage.delete(collection);
	};
}
/** The page's contexts for `collection`: a view's own collection first; else the page's (`'*'`, offered by `AppShell`). */
export const pageContexts = (collection: string) => onPage.get(collection) ?? onPage.get('*');
/** Subscribes to a view offering its contexts after a reader asked; the returned function unsubscribes. */
export function onPageContexts(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}
/** The contexts the last `openRecord` of this record carried, taken once: the shell's sheet sets them above its
 * `RecordShell`; an opening that carried none (a reload, a link) takes the page's own (`pageContexts`). */
export function carriedContexts(
	collection: string,
	id: string
): ReadonlyMap<unknown, unknown> | undefined {
	const c = carried?.record === `${collection}/${id}` ? carried.contexts : undefined;
	carried = null;
	return c;
}
