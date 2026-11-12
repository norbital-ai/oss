// Bolt's catalog: a workspace's models, relationships and models with the built-in layer's (`src/system`) beside
// them, as the store's tables (`table_of`); and the browser's (the shell boot's `catalog`), which `bolt.decode` checks
// against.
import {
	catalog_of as storeCatalogOf,
	type Catalog,
	type CatalogExposure,
	type CatalogTable,
	type FieldSpec,
	KindSpec,
	type TableSpec
} from '@norbital-ai/store';
import { Schema } from 'effect';
import type { ModelSpec } from '../decl/model.ts';
import type { RelationshipSpec } from '../decl/names.ts';
import type { EngineManifest } from '../engine/manifest.ts';
import { SYSTEM } from '../system/index.ts';

/**
 * A model as the store's table: a workspace model is audited (its `id`, `revision` and created/updated columns) with
 * import matching marked on its unique constraint; a system model (`table`) is keyed as its `table.primary` says.
 */
export function table_of(model: ModelSpec): TableSpec {
	const {
		description: _d,
		icon: _i,
		record_label: _rl,
		table,
		key: _key,
		...storage
	} = model;
	// Enum transitions remain application metadata. State transitions, stamps and lock predicates generate native rules.
	const fields = Object.fromEntries(
		Object.entries(storage.fields).map(([name, kind]) => {
			if (kind.kind !== 'enum' || kind.transitions === undefined) return [name, kind];
			const { transitions: _transitions, ...plain } = kind;
			return [name, plain];
		})
	);
	const label = model.record_label;
	const record_label = label === undefined ? {} : { record_label: label };
	if (table === undefined)
		return { ...storage, fields, ...record_label, audit: true };
	const p = table.primary;
	return {
		...storage,
		fields,
		...record_label,
		key: typeof p === 'object' ? [p.field] : p,
		...(table.identity === undefined ? {} : { identity: table.identity })
	};
}
/**
 * Models as the store's tables, each `+relationship.ts` entry `<model>.<fk>` a ref field of its model, with the
 * built-in layer's beside them.
 */
export function tables_of(
	models: { readonly [model: string]: ModelSpec },
	relationships: { readonly [key: string]: RelationshipSpec }
): { readonly [table: string]: TableSpec } {
	const tables = Object.fromEntries(
		Object.entries({ ...SYSTEM.models, ...models }).map(([name, m]) => [name, table_of(m)])
	);
	const refs = new Map<string, { [field: string]: FieldSpec }>();
	for (const [key, r] of Object.entries({ ...SYSTEM.relationships, ...relationships })) {
		const [model = '', field = ''] = key.split('.');
		const own = refs.get(model) ?? {};
		const { where, ...relationship } = r;
		own[field] = {
			kind: 'ref',
			...relationship,
			...(where === undefined
				? {}
				: { where })
		};
		refs.set(model, own);
	}
	return Object.fromEntries(
		Object.entries(tables).map(([name, t]) => [
			name,
			{ ...t, fields: { ...t.fields, ...refs.get(name) } }
		])
	);
}

/** The query model of a workspace and the built-in layer, whose models and models are declared alike. */
export function catalog(m: EngineManifest): Catalog {
	const tables = tables_of(m.models, m.relationships);
	// Approval references already carry model + record id. Resolve/search the target label live, without a snapshot field.
	const requests = tables.approval_request;
	// an own-field label is a generated column; a one-hop relation label is read with its target under its grants
	const labelled = Object.keys(m.models).filter((name) => tables[name]?.record_label !== undefined);
	return storeCatalogOf(
		{
			tables: {
				...tables,
				...(requests === undefined
					? {}
					: {
							approval_request: {
								...requests,
								label_link: { model: 'collection_name', record: 'record_id', targets: labelled }
							}
						})
			}
		},
		{ ...SYSTEM.exposures, ...m.exposures }
	);
}

/** What the browser knows of the caller's models (the shell boot's `catalog`): readable fields as declared, the
 * one-relations it may use (with their inverse names) and the many-relations it exposes. `bolt.decode` checks against it. */
export const BrowserCatalog = Schema.Record(Schema.String, Schema.Struct({
	fields: Schema.Record(Schema.String, KindSpec),
	relations: Schema.optionalKey(Schema.Record(Schema.String, Schema.Struct({
		targets: Schema.Array(Schema.String), inverse: Schema.optionalKey(Schema.String)
	}))),
	many: Schema.optionalKey(Schema.Array(Schema.String)),
	search: Schema.optionalKey(Schema.Array(Schema.String)),
	record_label: Schema.optionalKey(Schema.String), semantic: Schema.optionalKey(Schema.Literal(true))
}));
export type BrowserCatalog = typeof BrowserCatalog.Type;
export function browser_catalog(b: BrowserCatalog): Catalog {
	const exposed = Object.entries(b);
	const system = tables_of({}, {});
	// the built-in layer's relationships hold whatever the browser knows a system model as
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
							...(x.record_label === undefined ? {} : { record_label: x.record_label }),
							audit: true,
							search:
								x.search === undefined
									? undefined
									: {
											text: x.search.filter((field) => field !== '$label'),
											semantic: x.semantic === true ? { fields: [], model: '', dim: 0 } : undefined
										}
						}
					])
				)
			}
		},
		{
			...SYSTEM.exposures,
			...Object.fromEntries(
				exposed.map(([c, x]): [string, CatalogExposure] => [
					c,
					{ outputs: { default: { [c]: { fields: 'all' } } } }
				])
			)
		}
	);
}
