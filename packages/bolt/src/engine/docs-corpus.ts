// The docs corpus over any reader of its JSON documents (one per namespace, one per authoring skill, plus
// `index.json`, written by `scripts/docs.ts`): `docs/index.ts` reads them from `build/docs/`; a cell's host serves them
// through `Docs`. Every document is read and decoded once, up front; the corpus then only answers.

import { Effect, Schema, Struct } from 'effect';
import { FacilityFailure } from '../decl/errors.ts';

/** A property, prop or parameter field with its authoring guidance. */
const DocMemberSchema = Schema.Struct({
	name: Schema.String,
	type: Schema.String,
	optional: Schema.optionalKey(Schema.Literal(true)),
	summary: Schema.optionalKey(Schema.String),
	docs: Schema.optionalKey(Schema.String),
	examples: Schema.optionalKey(Schema.Array(Schema.String).pipe(Schema.mutable))
}).mapFields(Struct.map(Schema.mutableKey));
export type DocMember = typeof DocMemberSchema.Type;
/** An options parameter includes its field descriptions. */
const DocParamSchema = Schema.Struct({
	...DocMemberSchema.fields,
	fields: Schema.optionalKey(Schema.Array(DocMemberSchema).pipe(Schema.mutable))
}).mapFields(Struct.map(Schema.mutableKey));
export type DocParam = typeof DocParamSchema.Type;
/** The kind of an exported symbol. */
const DocKindSchema = Schema.Literals([
	'function',
	'component',
	'const',
	'class',
	'interface',
	'type',
	'enum',
	'namespace'
]);
export type DocKind = typeof DocKindSchema.Type;
/** The exported symbol and its repository source location. */
const DocSymbolSchema = Schema.Struct({
	name: Schema.String,
	kind: DocKindSchema,
	signature: Schema.String,
	summary: Schema.String,
	docs: Schema.optionalKey(Schema.String),
	params: Schema.optionalKey(Schema.Array(DocParamSchema).pipe(Schema.mutable)),
	props: Schema.optionalKey(Schema.Array(DocMemberSchema).pipe(Schema.mutable)),
	members: Schema.optionalKey(Schema.Array(DocMemberSchema).pipe(Schema.mutable)),
	examples: Schema.optionalKey(Schema.Array(Schema.String).pipe(Schema.mutable)),
	source: Schema.String
}).mapFields(Struct.map(Schema.mutableKey));
export type DocSymbol = typeof DocSymbolSchema.Type;
/** One package entry point and its complete exported symbol list. */
const DocNamespaceSchema = Schema.Struct({
	namespace: Schema.String,
	module: Schema.String,
	summary: Schema.String,
	symbols: Schema.Array(DocSymbolSchema).pipe(Schema.mutable)
}).mapFields(Struct.map(Schema.mutableKey));
export type DocNamespace = typeof DocNamespaceSchema.Type;
/** A maintained mechanism guide shipped by the package. */
const DocGuideSchema = Schema.Struct({
	slug: Schema.String,
	title: Schema.String,
	source: Schema.String,
	text: Schema.String
}).mapFields(Struct.map(Schema.mutableKey));
export type DocGuide = typeof DocGuideSchema.Type;
/** An authoring skill and its source files. */
const DocSkillSchema = Schema.Struct({
	name: Schema.String,
	description: Schema.String,
	files: Schema.Array(
		Schema.Struct({ path: Schema.String, text: Schema.String }).mapFields(
			Struct.map(Schema.mutableKey)
		)
	).pipe(Schema.mutable)
}).mapFields(Struct.map(Schema.mutableKey));
export type DocSkill = typeof DocSkillSchema.Type;
/** The release's namespace, guide and authoring skill inventory. */
const DocIndexSchema = Schema.Struct({
	namespaces: Schema.Array(
		Schema.Struct({
			namespace: Schema.String,
			module: Schema.String,
			summary: Schema.String,
			symbols: Schema.Number,
			reference: Schema.Boolean
		}).mapFields(Struct.map(Schema.mutableKey))
	).pipe(Schema.mutable),
	missing: Schema.Array(Schema.String).pipe(Schema.mutable),
	guides: Schema.Array(DocGuideSchema).pipe(Schema.mutable),
	skills: Schema.Array(
		Schema.Struct({
			name: Schema.String,
			description: Schema.String,
			files: Schema.Array(Schema.String).pipe(Schema.mutable)
		}).mapFields(Struct.map(Schema.mutableKey))
	).pipe(Schema.mutable)
}).mapFields(Struct.map(Schema.mutableKey));
export type DocIndex = typeof DocIndexSchema.Type;
/** A search hit: the namespace, name, kind and summary of one symbol. */
export type DocHit = { namespace: string; name: string; kind: DocKind; summary: string };

/** The file a namespace is written to: `bolt/page` → `bolt.page.json`. */
const docFile = (namespace: string) => `${namespace.replaceAll('/', '.')}.json`;
/** The file a skill is written to: `authoring-test-suites` → `skill.authoring-test-suites.json`. */
export const skill_file = (name: string) => `skill.${name}.json`;

const refused = (message: string) => new FacilityFailure({ kind: 'invalid', message });
const decoded =
	<A, I>(schema: Schema.Codec<A, I>, file: string) =>
	(value: unknown) =>
		Schema.decodeUnknownEffect(schema)(value).pipe(
			Effect.mapError((error) => refused(`docs ${file}: ${error.message}`))
		);

/**
 * The API reference corpus: `index()`, `namespace(ns)`, `symbol(ns, name)`, `search(text)` and `guide(slug)`, over the
 * index and every namespace and skill it lists, each read through `read` and decoded once.
 * @example
 * docs.symbol('bolt', 'ModelDeclaration')?.signature
 */
export const corpus = <E>(read: (file: string) => Effect.Effect<unknown, E>) =>
	Effect.gen(function* () {
		const index = yield* Effect.flatMap(read('index.json'), decoded(DocIndexSchema, 'index.json'));
		const namespaces = new Map<string, DocNamespace>();
		for (const { namespace } of index.namespaces) {
			const file = docFile(namespace);
			const document = yield* Effect.flatMap(read(file), decoded(DocNamespaceSchema, file));
			if (document.namespace !== namespace)
				return yield* Effect.fail(refused(`docs namespace ${namespace} answered ${document.namespace}`));
			namespaces.set(namespace, document);
		}
		const skills = new Map<string, DocSkill>();
		for (const { name } of index.skills) {
			const file = skill_file(name);
			const document = yield* Effect.flatMap(read(file), decoded(DocSkillSchema, file));
			if (document.name !== name)
				return yield* Effect.fail(refused(`docs skill ${name} answered ${document.name}`));
			skills.set(name, document);
		}
		const docs = {
			/** Every namespace with its module specifier, summary and symbol count. */
			index: (): DocIndex => index,
			/** One mechanism guide, or null for an unknown slug. */
			guide(slug: string): DocGuide | null {
				return docs.index().guides.find((guide) => guide.slug === slug) ?? null;
			},
			/** One namespace's symbols, or `null` for an unknown one. */
			namespace(namespace: string): DocNamespace | null {
				return namespaces.get(namespace) ?? null;
			},
			/** One symbol by namespace and exported name. */
			symbol(namespace: string, name: string): DocSymbol | null {
				return docs.namespace(namespace)?.symbols.find((s) => s.name === name) ?? null;
			},
			/** One authoring skill with its files' text, or `null` for an unknown one. */
			skill(name: string): DocSkill | null {
				return skills.get(name) ?? null;
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
					for (const s of namespaces.get(n.namespace)?.symbols ?? []) {
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
	});
export type DocsCorpus = Effect.Success<ReturnType<typeof corpus<never>>>;
