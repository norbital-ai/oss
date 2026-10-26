// The API reference (§3.3.10, §7.3) over any loader of its JSON documents (one per namespace, plus `index.json`, written
// by `src/cli/docs.ts`): `docs/index.ts` reads them from `build/docs/`; a cell's host serves them through `Docs`.

/** A property, prop or parameter field: its declared type as written, and its doc's first paragraph. */
export type DocMember = { name: string; type: string; optional?: true; summary?: string };
/** A parameter; `fields` are the properties of an options object (a declaration function's spec). */
export type DocParam = DocMember & { fields?: DocMember[] };
/** What an exported symbol is. */
export type DocKind =
	'function' | 'component' | 'const' | 'class' | 'interface' | 'type' | 'enum' | 'namespace';
/** One exported symbol. `source` is `packages/<pkg>/src/<file>:<line>` in the oss repository. */
export type DocSymbol = {
	name: string;
	kind: DocKind;
	signature: string;
	summary: string;
	docs?: string;
	params?: DocParam[];
	props?: DocMember[];
	members?: DocMember[];
	examples?: string[];
	source: string;
};
/** One entry point: `bolt/page` is `@norbital-ai/bolt/page`. */
export type DocNamespace = {
	namespace: string;
	module: string;
	summary: string;
	symbols: DocSymbol[];
};
/**
 * The combined index: every namespace (`reference` marks what a workspace author imports: bolt's root, `/client` and
 * `/test`, ui's authoring entries and std), and the reference symbols that still lack a summary (`namespace#name`).
 */
export type DocIndex = {
	namespaces: {
		namespace: string;
		module: string;
		summary: string;
		symbols: number;
		reference: boolean;
	}[];
	missing: string[];
};
/** A search hit: the namespace, name, kind and summary of one symbol. */
export type DocHit = { namespace: string; name: string; kind: DocKind; summary: string };

/** The file a namespace is written to: `bolt/page` → `bolt.page.json`. */
const docFile = (namespace: string) => `${namespace.replaceAll('/', '.')}.json`;

/**
 * The API reference corpus: `index()`, `namespace(ns)`, `symbol(ns, name)` and `search(text)`.
 * @example
 * docs.symbol('bolt', 'collection')?.signature
 */
export const corpus = (load: <T>(file: string) => T) => {
	const docs = {
		/** Every namespace with its module specifier, summary and symbol count. */
		index: (): DocIndex => load<DocIndex>('index.json'),
		/** One namespace's symbols, or `null` for an unknown one. */
		namespace(namespace: string): DocNamespace | null {
			return docs.index().namespaces.some((n) => n.namespace === namespace)
				? load<DocNamespace>(docFile(namespace))
				: null;
		},
		/** One symbol by namespace and exported name. */
		symbol(namespace: string, name: string): DocSymbol | null {
			return docs.namespace(namespace)?.symbols.find((s) => s.name === name) ?? null;
		},
		/**
		 * Symbols whose name, summary or signature contain any word of `text`, best first: an exact name, then a name that
		 * starts with the words, then by how many words match (a word in the name counts more) — so a sentence ("app page
		 * table") finds what its words name. `namespaces` narrows the search (a prefix ending in `/` names a family, `std/`
		 * every std entry).
		 * @example docs.search('date range', { namespaces: ['std/'] })
		 */
		search(text: string, o: { namespaces?: readonly string[]; limit?: number } = {}): DocHit[] {
			const words = text.toLowerCase().split(/\s+/).filter(Boolean);
			const within = (ns: string) =>
				o.namespaces === undefined ||
				o.namespaces.some((p) => (p.endsWith('/') ? ns.startsWith(p) : ns === p));
			const joined = words.join('');
			// a word matches where a word starts ("app" is not "approval"); a name's own words weigh most
			const starts = words.map(
				(w) => new RegExp(`(?:^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
			);
			const hits: (DocHit & { score: number })[] = [];
			for (const n of docs.index().namespaces) {
				if (!within(n.namespace)) continue;
				for (const s of load<DocNamespace>(docFile(n.namespace)).symbols) {
					const name = s.name.toLowerCase(),
						tokens = s.name
							.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
							.toLowerCase()
							.split(/[^a-z0-9]+/),
						hay = `${name} ${s.summary} ${s.signature}`.toLowerCase();
					const matched = starts.filter((w) => w.test(hay)).length;
					if (matched === 0) continue;
					const score =
						(name === joined ? 1000 : name.startsWith(joined) ? 500 : 0) +
						words.filter((w) => tokens.includes(w)).length * 40 +
						matched * 10 +
						(matched === words.length ? 50 : 0);
					hits.push({
						namespace: n.namespace,
						name: s.name,
						kind: s.kind,
						summary: s.summary,
						score
					});
				}
			}
			hits.sort(
				(a, b) =>
					b.score - a.score ||
					a.namespace.localeCompare(b.namespace) ||
					a.name.localeCompare(b.name)
			);
			return hits.slice(0, o.limit ?? 20).map(({ score: _, ...h }) => h);
		}
	};
	return docs;
};
export type DocsCorpus = ReturnType<typeof corpus>;
