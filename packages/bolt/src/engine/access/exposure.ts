// The caller's authorized model catalogue for generated forms and record views.
import { Schema } from 'effect';
import type { ModelExposure, Fields } from '@norbital-ai/ui';
import type { Authority } from '../contracts.ts';
import type { EngineManifest } from '../manifest.ts';
import { relations as manifestRelations } from '../manifest.ts';
import { nullableOfExpr, type LayerColumns } from '../../decl/model.ts';
import { FieldsSchema } from '../../protocol/public-page.ts';
import { SYSTEM } from '../../system/index.ts';

/** A relationship's static `where` is JSON by construction; decoded once for the browser's picker. */
const pickerWhere = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json));

type ChildInput = NonNullable<NonNullable<ModelExposure['update']>['with']>[string];
/** The fields a read-only remote sync writes for `model` (everything but its local `update.columns`). */
function syncFields(m: EngineManifest, model: string): readonly string[] {
	const spec = m.exposures[model];
	const owned = Object.values(spec?.syncs ?? {}).some(
		(s) => s.with !== 'file' && s.read === true && s.write !== true
	);
	if (!owned) return [];
	const local = spec?.update?.columns[model] ?? [];
	const fields = [
		...Object.keys(m.models[model]?.fields ?? {}),
		...Object.keys(m.relationships)
			.filter((key) => key.startsWith(`${model}.`))
			.map((key) => key.slice(model.length + 1))
	];
	return fields.filter((field) => !local.includes(field));
}
/**
 * The columns `path` admits for this caller: the model's declaration there, narrowed to the union of the caller's arms
 * of the verb (an administrator holds every declared column); `undefined` when no held arm names the path.
 */
function admitted(
	a: Authority,
	root: string,
	declared: LayerColumns,
	verb: 'create' | 'update',
	path: string
): readonly string[] | undefined {
	const columns = declared[path];
	if (columns === undefined) return undefined;
	if (a.admin) return columns;
	const arms = (a.models[root]?.[verb] ?? []).filter((arm) => Object.hasOwn(arm.columns, path));
	return arms.length === 0
		? undefined
		: columns.filter((field) => arms.some((arm) => arm.columns[path]?.includes(field)));
}
/** The child layers one level under `path` as the record forms write them, through the root's access point only. */
function childInputs(
	m: EngineManifest,
	a: Authority,
	root: string,
	declared: LayerColumns,
	path: string,
	model: string,
	verb: 'create' | 'update',
	filled?: LayerColumns
): Readonly<Record<string, ChildInput>> {
	const out: Record<string, ChildInput> = {};
	for (const at of Object.keys(declared)) {
		const inverse = at.startsWith(`${path}.`) ? at.slice(path.length + 1) : '';
		if (inverse === '' || inverse.includes('.')) continue;
		const relation = manifestRelations(m).inverse.get(`${model}.${inverse}`);
		const columns = admitted(a, root, declared, verb, at);
		if (relation === undefined || columns === undefined) continue;
		const { spec: relationSpec, from: child, fk } = relation;
		const remote = syncFields(m, child);
		const own = columns.filter((field) => !remote.includes(field) && field !== fk);
		const free = !relationSpec.owned && !remote.includes(fk);
		out[inverse] = {
			model: child,
			parent: fk,
			...(relationSpec.owned ? { owned: true as const } : {}),
			create: {
				columns: own,
				...(filled?.[at] === undefined
					? {}
					: { filled: filled[at].filter((field) => own.includes(field)) })
			},
			...(verb === 'update' ? { update: { columns: own }, delete: true as const } : {}),
			...(free ? { link: true as const } : {}),
			...(free && verb === 'update' && relationSpec.optional ? { unlink: true as const } : {})
		};
	}
	return out;
}

/** Model field kinds as the ui catalog (stored FieldKind is Kind structurally). */
const fieldsOf = (entries: readonly (readonly [string, unknown])[]): Fields =>
	Schema.decodeUnknownSync(FieldsSchema)(Object.fromEntries(entries));
/** The system models the browser resolves as targets: the directory (pickers, `actor` operands) and stored files. */
const TARGETS = ['sys_user', 'sys_file', 'sys_invitation'] as const;
/**
 * The caller's syncs on `c` for the view toolbar: a file sync's upload accept list (its parsers' extensions; default
 * xlsx and csv), whether the caller may import (create or update the model) and export (read it), and its required
 * context fields; a remote sync with a
 * `read`, and whether the caller may start it ("Sync now").
 */
function syncsOf(
	m: EngineManifest,
	a: Authority,
	c: string,
	reads: boolean
): Pick<ModelExposure, 'syncs'> {
	const ca = a.models[c];
	type Entry = NonNullable<ModelExposure['syncs']>[string];
	const held = Object.fromEntries(
		Object.entries(m.exposures[c]?.syncs ?? {}).flatMap(([name, s]): [string, Entry][] => {
			if (s.with === 'file') {
				const parsers = s.parser ?? ['xlsx', 'csv'];
				const formats =
					s.schema === undefined && s.write === true
						? (m.workspace.convert?.to ?? [])
						: parsers.flatMap((parser) =>
								['xlsx', 'csv', 'tsv', 'json'].filter((format) => format === parser)
							);
				const context = Object.entries(s.context ?? {})
					.filter(([, k]) => k.optional !== true && k.default === undefined)
					.map(([f]) => f);
				return [
					[
						name,
						{
							kind: 'file',
							parser: parsers,
							...(a.actor.kind === 'member' &&
							(a.admin || (ca?.create.length ?? 0) > 0 || (ca?.update.length ?? 0) > 0)
								? { import: true }
								: {}),
							...(a.actor.kind === 'member' && reads ? { export: formats } : {}),
							...(context.length > 0 ? { context } : {})
						}
					]
				];
			}
			const run = `${c}.sync.${name}`;
			return s.read === true && (a.admin || a.automations.includes(run))
				? [[name, { kind: 'remote', with: s.with }]]
				: [];
		})
	);
	return Object.keys(held).length === 0 ? {} : { syncs: held };
}
/**
 * A roll-up `sum` over a money field keeps its money: `money: { currency? }`, the child's literal code, or the child's currency
 * field when the parent has one of that name (the document's currency its lines copy); else the workspace default.
 */
function sumOf(
	m: EngineManifest,
	c: string,
	k: EngineManifest['models'][string]['fields'][string]
): unknown {
	if (k.kind !== 'sum') return k;
	const [rel, f] = k.of.split('.') as [string, string];
	const child = Object.entries(m.relationships)
		.find(([, r]) => r.inverse === rel && [r.to].flat().includes(c))?.[0]
		.split('.')[0];
	const of = child === undefined ? undefined : m.models[child]?.fields[f];
	if (of?.kind !== 'money') return k;
	const cur = of.currency;
	return {
		...k,
		money:
			cur !== undefined && (/^[A-Z]{3}$/.test(cur) || m.models[c]?.fields[cur]?.kind === 'currency')
				? { currency: cur }
				: {}
	};
}
/**
 * The caller's models for ui: the model's label and search fields, the fields and one-relations the model and
 * the caller's read arms expose (rule 14), the create/update columns the caller holds, and which of the
 * exposed fields are masked on some rows for this caller.
 */
export function exposure(
	m: EngineManifest,
	a: Authority
): { readonly [model: string]: ModelExposure } {
	const instanceModel = SYSTEM.models['sys_integration'],
		instanceExposure = SYSTEM.exposures['sys_integration'];
	if (instanceModel === undefined || instanceExposure === undefined)
		throw new Error('The native integration instance catalogue is missing.');
	const owner = SYSTEM.relationships['sys_integration.owner'];
	m = {
		...m,
		models: { ...m.models, sys_integration: instanceModel },
		exposures: { ...m.exposures, sys_integration: instanceExposure },
		relationships: {
			...m.relationships,
			...(owner === undefined ? {} : { 'sys_integration.owner': owner })
		}
	};
	const out: { [c: string]: ModelExposure } = {};
	for (const [c, spec] of Object.entries(m.exposures)) {
		const ca = a.models[c],
			model = m.models[c];
		const arms = ca?.read[c] ?? [];
		const reads = a.admin || arms.length > 0;
		const writes = (['create', 'update'] as const).filter(
			(v) => spec[v] !== undefined && (a.admin || (ca?.[v].length ?? 0) > 0)
		);
		if (model === undefined || (!reads && writes.length === 0)) continue;
		// the root layer's declared fields, narrowed by the caller's root read arms (rule 14)
		const declared = spec.read[c]?.fields ?? [];
		const armed = (field: string) =>
			a.admin || arms.some((arm) => arm.fields === 'all' || arm.fields.includes(field));
		const readable = (f: string) =>
			reads && (declared === 'all' || declared.includes(f)) && armed(f);
		// the columns this caller's own create/update arms admit (rule 14): a column no held arm names is filled by the host
		const remote = syncFields(m, c);
		const owned = (manifestRelations(m).from.get(c) ?? [])
			.filter((relation) => relation.spec.owned)
			.map((relation) => relation.fk);
		const columns = (verb: 'create' | 'update') =>
			(admitted(a, c, spec[verb]?.columns ?? {}, verb, c) ?? []).filter(
				(field) => !remote.includes(field) && (verb !== 'update' || !owned.includes(field))
			);
		// a create-only caller (a visitor's application form) still sees the fields it writes
		const written = new Set(writes.flatMap(columns));
		// a computed field reads like a stored one (a model `label` may name one), its kind the expression's
		const fields = [
			...Object.entries(model.fields).map(([f, k]) => [f, sumOf(m, c, k)] as const),
			...Object.entries(model.computed ?? {}).map(
				([f, x]) =>
					[
						f,
						{
							kind: x.kind,
							...(x.kind === 'decimal' ? { scale: x.scale ?? 0 } : {}),
							...(nullableOfExpr(x.expr, model) ? { optional: true as const } : {})
						}
					] as const
			)
		].filter(([f]) => readable(f) || written.has(f));
		const relations = Object.entries(m.relationships).flatMap(([key, r]) => {
			const [from, fk] = key.split('.') as [string, string];
			return from === c && (readable(fk) || written.has(fk))
				? [
						[
							fk,
							{
								targets: [r.to].flat(),
								...(r.optional === true ? { optional: true as const } : {}),
								...(r.inverse === undefined ? {} : { inverse: r.inverse }),
								// what a picker for this reference offers, as a write would accept it
								...(r.where === undefined ? {} : { where: pickerWhere(r.where) })
							}
						] as const
					]
				: []; // hook:query (inverse)
		});
		// the root's read layers one level down (a ref or a many-relation); the many-relations among them
		const layers = !reads
			? []
			: Object.keys(spec.read).flatMap((path) => {
					const rel = path.startsWith(`${c}.`) ? path.slice(c.length + 1) : '';
					return rel === '' || rel.includes('.') ? [] : [rel];
				});
		const many = layers.filter((rel) => manifestRelations(m).inverse.has(`${c}.${rel}`)); // hook:query
		const children = Object.fromEntries(
			Object.entries(m.relationships).flatMap(([key, relation]) =>
				relation.inverse !== undefined &&
				many.includes(relation.inverse) &&
				[relation.to].flat().includes(c)
					? [
							[
								relation.inverse,
								{
									model: key.slice(0, key.lastIndexOf('.')),
									parent: key.slice(key.lastIndexOf('.') + 1),
									...(relation.owned ? { owned: true as const } : {})
								}
							]
						]
					: []
			)
		);
		const readonlyFields = Object.fromEntries([
			...remote.filter(readable).map((field) => [field, 'syncOwned'] as const),
			...owned
				.filter((field) => readable(field) || relations.some(([fk]) => fk === field))
				.map((field) => [field, 'ownedParent'] as const)
		]);
		const masked = a.admin
			? []
			: Object.keys(ca?.masks[c] ?? {}).filter((f) => fields.some(([x]) => x === f));
		out[c] = {
			label: [model.label].flat(),
			...(model.search === undefined ? {} : { search: model.search.text }),
			...(model.search?.semantic === undefined ? {} : { semantic: true as const }),
			fields: fieldsOf(fields),
			...(reads && Object.keys(model.search?.indexes ?? {}).length > 0
				? {
						indexes: Object.fromEntries(
							Object.entries(model.search!.indexes!).map(([n, x]) => [
								n,
								{ input: fieldsOf(Object.entries(x.input)), description: x.description }
							])
						)
					}
				: {}),
			...(relations.length === 0 ? {} : { relations: Object.fromEntries(relations) }),
			...(layers.length === 0 ? {} : { layers }),
			...(many.length === 0 ? {} : { many, children }), // hook:query (many)
			...Object.fromEntries(
				writes.map((v) => {
					const filled = v === 'create' ? spec.create?.filled : undefined;
					const children = childInputs(m, a, c, spec[v]?.columns ?? {}, c, c, v, filled);
					return [
						v,
						{
							columns: columns(v),
							...(Object.keys(children).length === 0 ? {} : { with: children }),
							...(filled?.[c] === undefined
								? {}
								: { filled: filled[c].filter((f) => columns(v).includes(f)) })
						}
					];
				})
			),
			...(masked.length === 0 ? {} : { masked }),
			...(Object.keys(readonlyFields).length === 0 ? {} : { readonlyFields }),
			...(model.locked === undefined ? {} : { locked: model.locked }),
			description: model.description,
			...(spec.delete !== undefined && (a.admin || (ca?.delete.length ?? 0) > 0)
				? { delete: true }
				: {}),
			...syncsOf(m, a, c, reads)
		};
	}
	// the system targets a relation, an `id` input or a file field points at: their declared fields as the caller's grants or
	// the kernel directory let it read them
	for (const c of TARGETS) {
		const arms = a.models[c]?.read[c] ?? [],
			model = SYSTEM.models[c]!,
			read = SYSTEM.exposures[c]!.read[c]?.fields ?? [];
		if (!a.admin && arms.length === 0) continue;
		const readable = Object.entries(model.fields).filter(
			([f]) =>
				(read === 'all' || read.includes(f)) &&
				(a.admin || arms.some((x) => x.fields === 'all' || x.fields.includes(f)))
		);
		const relations = Object.entries(SYSTEM.relationships).flatMap(([key, relation]) => {
			const [from, field] = key.split('.');
			return from === c &&
				(a.admin || arms.some((arm) => arm.fields === 'all' || arm.fields.includes(field!)))
				? ([
						[
							field!,
							{
								targets: [relation.to].flat(),
								...(relation.optional === true ? { optional: true as const } : {})
							}
						]
					] as const)
				: [];
		});
		out[c] = {
			label: [model.label].flat(),
			fields: fieldsOf(readable),
			...(relations.length > 0 ? { relations: Object.fromEntries(relations) } : {})
		};
	}
	return out;
}
