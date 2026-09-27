// The shell finder (L-BOLT-497, 512): apps and pages the viewer may open, matched by title, and records of every
// collection the viewer may search (the model's `search.text`), each labelled by its declared `label` fields. A record
// search is one `read` with `search` per collection; an answer to an older query is dropped when a newer one was asked.
import type { Json } from '../decl/values.ts';
import type { Exposure, NavNode } from './nav.ts';

export type FinderHit =
	| { kind: 'page'; key: string; label: string; context: string | null; href: string }
	| { kind: 'record'; key: string; label: string; context: string; collection: string; id: string };
type Row = { readonly [field: string]: Json };
export type FinderRead = (collection: string, options: Json) => PromiseLike<{ rows: readonly Row[] }>;

const RECORDS_PER_COLLECTION = 5;
const has = (text: string, query: string) => text.toLowerCase().includes(query.trim().toLowerCase());

/** The app pages whose title (or app title) holds `query`; every page when it is empty. */
export function pageHits(nav: readonly NavNode[], query: string, t: (key: string) => string): FinderHit[] {
	const out: FinderHit[] = [];
	const walk = (n: NavNode, trail: string | null) => {
		if (n.kind === 'group') { for (const c of n.children) walk(c, t(n.title)); return; }
		const app = t(n.title);
		for (const p of n.pages) {
			const label = n.pages.length === 1 ? app : t(p.title);
			const context = n.pages.length === 1 ? trail : app;
			if (has(label, query) || has(app, query)) out.push({ kind: 'page', key: p.href, label, context, href: p.href });
		}
	};
	for (const n of nav) walk(n, null);
	return out;
}

/** A row's label: its declared `label` fields joined, else its id. */
export const labelOf = (row: Row, label: readonly string[]) =>
	label.map((f) => row[f]).filter((v) => v !== null && v !== undefined && v !== '').map(String).join(' · ') || String(row['id'] ?? '');

/**
 * Record search over every searchable collection in `catalog`. `search(query)` resolves with the hits, or `null` when a
 * newer query was asked meanwhile (its answer is stale and must not paint). A collection whose read fails is left out.
 */
export function recordFinder(catalog: { readonly [collection: string]: Exposure }, read: FinderRead, t: (key: string) => string) {
	let asked = 0;
	const searchable = Object.entries(catalog).filter(([, e]) => (e.search?.length ?? 0) > 0);
	const title = (c: string) => { const key = `models.${c}.label`, s = t(key); return s !== key ? s : c.replace(/_/g, ' '); };
	return {
		/** Collections the viewer may search: nothing to search means no record step. */
		get collections() { return searchable.map(([c]) => c); },
		async search(query: string): Promise<FinderHit[] | null> {
			const mine = ++asked;
			if (query.trim() === '') return [];
			// L-BOLT-495: `/<collection> <text>` searches that collection alone; `/semantic <text>` those that read by meaning
			const slash = /^\/(\S+)\s+(\S.*)$/.exec(query.trim());
			const scope = slash === null ? searchable : searchable.filter(([c, e]) => slash[1] === 'semantic' ? e.semantic === true : c === slash[1]);
			const text = slash === null || slash[1] === 'semantic' ? query.trim() : slash[2]!;
			const pages = await Promise.all(scope.map(async ([c, e]) => {
				try {
					const page = await read(c, { search: text, limit: RECORDS_PER_COLLECTION });
					return page.rows.map((r): FinderHit => ({ kind: 'record', key: `${c}/${String(r['id'])}`, label: labelOf(r, e.label), context: title(c), collection: c, id: String(r['id']) }));
				} catch {
					return [];
				}
			}));
			return mine === asked ? pages.flat() : null;
		},
	};
}
