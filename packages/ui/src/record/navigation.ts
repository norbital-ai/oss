let carried: { record: string; contexts: ReadonlyMap<unknown, unknown> } | null = null;
/**
 * Opens the shell's record sheet: `?record=<model>/<id|new>`, the form the shell's `bolt.href` writes and reads,
 * stacked on any sheet already open.
 * The sheet mounts outside the page, so `contexts` (the opener's `getAllContexts()`, taken at its init) carry the page's
 * scope into it: a create opened from a scoped page keeps its presets and narrowed pickers. They live in memory only.
 */
export function openRecord(
	model: string,
	id: string | 'new',
	contexts?: ReadonlyMap<unknown, unknown>
): void {
	carried = contexts === undefined ? null : { record: `${model}/${id}`, contexts };
	const url = new URL(location.href),
		key = `${model}/${id}`;
	// the record-sheet stack (rule 10): a record opened from an open sheet stacks on it; one already open becomes the top
	// a record just created replaces its own create sheet, never stacks on it
	const all = url.searchParams.getAll('record');
	const stack = id !== 'new' && all.at(-1) === `${model}/new` ? all.slice(0, -1) : all,
		at = stack.indexOf(key);
	url.searchParams.delete('record');
	for (const r of at < 0 ? [...stack, key] : stack.slice(0, at + 1))
		url.searchParams.append('record', r);
	history.pushState(history.state, '', url);
	dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
}
/**
 * The contexts of the views on the page, by model: a sheet opened with nothing carried (a reload or a link with
 * `?record=` in it) takes the scope of the page it opens over, as its own New button would have given it.
 */
const onPage = new Map<string, ReadonlyMap<unknown, unknown>>();
const listeners = new Set<() => void>();
/** A view offers its page's contexts for its model while mounted; the returned function withdraws them. */
export function offerContexts(
	model: string,
	contexts: ReadonlyMap<unknown, unknown>
): () => void {
	onPage.set(model, contexts);
	for (const l of listeners) l();
	return () => {
		if (onPage.get(model) === contexts) onPage.delete(model);
	};
}
/** The page's contexts for `model`: a view's own model first; else the page's (`'*'`, offered by `AppShell`). */
export const pageContexts = (model: string) => onPage.get(model) ?? onPage.get('*');
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
	model: string,
	id: string
): ReadonlyMap<unknown, unknown> | undefined {
	const c = carried?.record === `${model}/${id}` ? carried.contexts : undefined;
	carried = null;
	return c;
}
