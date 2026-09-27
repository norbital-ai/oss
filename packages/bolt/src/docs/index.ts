/// <reference types="node" />
// `@norbital-ai/bolt/docs` (§3.3.10, §7.3): the API reference as data. `src/cli/docs.ts` writes it at build time from
// every public entry's declarations (one JSON document per namespace, plus `index.json`); the website renders it and
// the agent's `docs` tool searches it. Read lazily from `build/docs/`, next to this module in the published package.
import { readFileSync } from 'node:fs';

/** A property, prop or parameter field: its declared type as written, and its doc's first paragraph. */
export type DocMember = { name: string; type: string; optional?: true; summary?: string };
/** A parameter; `fields` are the properties of an options object (a declaration function's spec). */
export type DocParam = DocMember & { fields?: DocMember[] };
/** What an exported symbol is. */
export type DocKind = 'function' | 'component' | 'const' | 'class' | 'interface' | 'type' | 'enum' | 'namespace';
/** One exported symbol. `source` is `packages/<pkg>/src/<file>:<line>` in the oss repository. */
export type DocSymbol = {
	name: string; kind: DocKind; signature: string; summary: string; docs?: string;
	params?: DocParam[]; props?: DocMember[]; members?: DocMember[]; examples?: string[]; source: string;
};
/** One entry point: `bolt/client` is `@norbital-ai/bolt/client`. */
export type DocNamespace = { namespace: string; module: string; summary: string; symbols: DocSymbol[] };
/**
 * The combined index: every namespace (`reference` marks what a workspace author imports: bolt's root, `/client` and
 * `/test`, ui's authoring entries and std), and the reference symbols that still lack a summary (`namespace#name`).
 */
export type DocIndex = { namespaces: { namespace: string; module: string; summary: string; symbols: number; reference: boolean }[]; missing: string[] };
/** A search hit: the namespace, name, kind and summary of one symbol. */
export type DocHit = { namespace: string; name: string; kind: DocKind; summary: string };

// `src/docs` and `build/docs` are both two levels under the package root, so this resolves from either
const dir = new URL('../../build/docs/', import.meta.url);
const cache = new Map<string, unknown>();
function load<T>(file: string): T {
	if (!cache.has(file)) cache.set(file, JSON.parse(readFileSync(new URL(file, dir), 'utf8')));
	return cache.get(file) as T;
}

/** The file a namespace is written to: `bolt/client` → `bolt.client.json`. */
const docFile = (namespace: string) => `${namespace.replaceAll('/', '.')}.json`;

/**
 * The API reference corpus: `index()`, `namespace(ns)`, `symbol(ns, name)` and `search(text)`.
 * @example
 * docs.symbol('bolt', 'collection')?.signature
 */
export const docs = {
	/** Every namespace with its module specifier, summary and symbol count. */
	index: (): DocIndex => load<DocIndex>('index.json'),
	/** One namespace's symbols, or `null` for an unknown one. */
	namespace(namespace: string): DocNamespace | null {
		return docs.index().namespaces.some((n) => n.namespace === namespace) ? load<DocNamespace>(docFile(namespace)) : null;
	},
	/** One symbol by namespace and exported name. */
	symbol(namespace: string, name: string): DocSymbol | null {
		return docs.namespace(namespace)?.symbols.find((s) => s.name === name) ?? null;
	},
	/**
	 * Symbols whose name, summary or signature contain every word of `text`, best first: an exact name, then a name
	 * that starts with or contains the words, then the rest. `namespaces` narrows the search (a prefix ending in `/`
	 * names a family, `std/` every std entry).
	 * @example docs.search('date range', { namespaces: ['std/'] })
	 */
	search(text: string, o: { namespaces?: readonly string[]; limit?: number } = {}): DocHit[] {
		const words = text.toLowerCase().split(/\s+/).filter(Boolean);
		const within = (ns: string) => o.namespaces === undefined || o.namespaces.some((p) => p.endsWith('/') ? ns.startsWith(p) : ns === p);
		const hits: (DocHit & { score: number })[] = [];
		for (const n of docs.index().namespaces) {
			if (!within(n.namespace)) continue;
			for (const s of load<DocNamespace>(docFile(n.namespace)).symbols) {
				const name = s.name.toLowerCase(), hay = `${name} ${s.summary} ${s.signature}`.toLowerCase();
				if (!words.every((w) => hay.includes(w))) continue;
				const joined = words.join('');
				const score = name === joined ? 100 : name.startsWith(joined) ? 50 : words.some((w) => name.includes(w)) ? 20 : 1;
				hits.push({ namespace: n.namespace, name: s.name, kind: s.kind, summary: s.summary, score });
			}
		}
		hits.sort((a, b) => b.score - a.score || a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name));
		return hits.slice(0, o.limit ?? 20).map(({ score: _, ...h }) => h);
	}
};
