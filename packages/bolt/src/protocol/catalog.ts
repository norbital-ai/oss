// Bolt's catalog: a workspace's models, relationships and collections with the built-in layer's (`src/system`) beside
// them, as the store's tables (`tableOf`); and the browser's (the shell boot's `catalog`), which `bolt.decode` checks
// against.
import {
	catalogOf as storeCatalogOf,
	type Catalog,
	type CatalogCollection,
	type CatalogTable,
	type FieldSpec,
	type KindSpec,
	type TableSpec
} from '@norbital-ai/store';
import type { ModelSpec } from '../decl/model.ts';
import type { RelationshipSpec } from '../decl/names.ts';
import type { EngineManifest } from '../engine/manifest.ts';
import { SYSTEM } from '../system/index.ts';

/**
 * A model as the store's table: a workspace model is audited (its `id`, `revision` and created/updated columns) with
 * its `key` as the natural key; a system model (`table`) is keyed as its `table.primary` says, and audits nothing.
 */
export function tableOf(model: ModelSpec): TableSpec {
	const {
		description: _d,
		icon: _i,
		label: _l,
		table,
		key,
		locked: _lock,
		...storage
	} = model;
	// application-only metadata is not schema: enum transitions and the record lock never generate DDL
	const fields = Object.fromEntries(
		Object.entries(storage.fields).map(([name, kind]) => {
			if (kind.kind !== 'enum' || kind.transitions === undefined) return [name, kind];
			const { transitions: _transitions, ...plain } = kind;
			return [name, plain];
		})
	);
	const natural = key === undefined ? {} : { natural: key };
	if (table === undefined)
		return { ...storage, fields, ...natural, audit: true, nativeRules: 2 };
	const p = table.primary;
	return {
		...storage,
		fields,
		...natural,
		nativeRules: 2,
		key: typeof p === 'object' ? [p.field] : p,
		...(table.identity === undefined ? {} : { identity: table.identity }),
		...(table.indexes === undefined ? {} : { indexes: table.indexes })
	};
}
/**
 * Models as the store's tables, each `+relationship.ts` entry `<model>.<fk>` a ref field of its model, with the
 * built-in layer's beside them.
 */
export function tablesOf(
	models: { readonly [model: string]: ModelSpec },
	relationships: { readonly [key: string]: RelationshipSpec }
): { readonly [table: string]: TableSpec } {
	const tables = Object.fromEntries(
		Object.entries({ ...SYSTEM.models, ...models }).map(([name, m]) => [name, tableOf(m)])
	);
	const refs = new Map<string, { [field: string]: FieldSpec }>();
	for (const [key, r] of Object.entries({ ...SYSTEM.relationships, ...relationships })) {
		const [model = '', field = ''] = key.split('.');
		const own = refs.get(model) ?? {};
		own[field] = { kind: 'ref', ...r };
		refs.set(model, own);
	}
	return Object.fromEntries(
		Object.entries(tables).map(([name, t]) => [
			name,
			{ ...t, fields: { ...t.fields, ...refs.get(name) } }
		])
	);
}

/** The query model of a workspace and the built-in layer, whose models and collections are declared alike. */
export function catalog(m: EngineManifest): Catalog {
	return storeCatalogOf(
		{ tables: tablesOf(m.models, m.relationships) },
		{ ...SYSTEM.collections, ...m.collections }
	);
}

/** What the browser knows of the caller's collections (the shell boot's `catalog`): readable fields as declared, the
 * one-relations it may use (with their inverse names) and the many-relations it exposes. `bolt.decode` checks against it. */
export type BrowserCatalog = {
	readonly [c: string]: {
		fields: { readonly [f: string]: KindSpec };
		relations?: { readonly [fk: string]: { targets: readonly string[]; inverse?: string } };
		many?: readonly string[];
		/** `search.text`'s fields and whether `search.semantic` is declared: where `$search` and `$similar` decode. */
		search?: readonly string[];
		semantic?: true;
	};
};
export function browserCatalog(b: BrowserCatalog): Catalog {
	const exposed = Object.entries(b);
	const system = tablesOf({}, {});
	// the built-in layer's relationships hold whatever the browser knows a system collection as
	const systemRefs = (c: string) =>
		Object.fromEntries(Object.entries(system[c]?.fields ?? {}).filter(([, k]) => k.kind === 'ref'));
	return storeCatalogOf(
		{
			tables: {
				...system,
				...Object.fromEntries(
					exposed.map(([c, x]): [string, CatalogTable] => [
						c,
						{
							fields: {
								...systemRefs(c),
								...x.fields,
								...Object.fromEntries(
									Object.entries(x.relations ?? {}).map(([fk, r]) => [
										fk,
										{
											kind: 'ref',
											to: r.targets,
											...(r.inverse === undefined ? {} : { inverse: r.inverse })
										}
									])
								)
							},
							audit: true,
							search:
								x.search === undefined
									? undefined
									: {
											text: x.search,
											semantic: x.semantic === true ? { fields: [], model: '', dim: 0 } : undefined
										}
						}
					])
				)
			}
		},
		{
			...SYSTEM.collections,
			...Object.fromEntries(
				exposed.map(([c, x]): [string, CatalogCollection] => [
					c,
					{
						read: {
							fields: 'all',
							relations: [...Object.keys(x.relations ?? {}), ...(x.many ?? [])]
						}
					}
				])
			)
		}
	);
}
