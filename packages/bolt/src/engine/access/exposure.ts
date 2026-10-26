// The caller's authorized collection catalogue for generated forms and record views.
import { Schema } from 'effect';
import type { CollectionExposure, Fields } from '@norbital-ai/ui';
import type { Authority, WriteArm } from '../contracts.ts';
import type { EngineManifest } from '../manifest.ts';
import { relations as manifestRelations } from '../manifest.ts';
import { admits, syncOwned, writableColumns } from './authority.ts';
import { nullableOfExpr } from '../../decl/model.ts';
import { FieldsSchema, OutputKindSchema } from '../../protocol/public-page.ts';
import { SYSTEM } from '../../system/index.ts';

/** A relationship's static `where` is JSON by construction; decoded once for the browser's picker. */
const pickerWhere = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json));

type ChildInput = NonNullable<NonNullable<CollectionExposure['update']>['with']>[string];
type Selection = NonNullable<EngineManifest['collections'][string]['update']>['input'];
/** The fields a read-only remote sync writes for `collection` (everything but its local `update.columns`). */
function syncFields(m: EngineManifest, collection: string): readonly string[] {
	const owner = syncOwned(m, collection);
	if (owner === undefined) return [];
	const fields = [
		...Object.keys(m.models[collection]?.fields ?? {}),
		...Object.keys(m.relationships)
			.filter((key) => key.startsWith(`${collection}.`))
			.map((key) => key.slice(collection.length + 1))
	];
	return fields.filter((field) => !owner.local.includes(field));
}
/** Arms that admit `field` (an approval arm admits subject to its flow). */
const approves = (arms: readonly WriteArm[] | undefined, field: string) =>
	(arms ?? []).some(
		(arm) => arm.approval === true && (arm.fields === 'all' || arm.fields.includes(field))
	);
/** Whether every arm of `verb` the caller holds carries `approval` (a write there always asks first). */
const approvalOnly = (arms: readonly WriteArm[] | undefined) =>
	(arms ?? []).length > 0 && (arms ?? []).every((arm) => arm.approval === true);
function childInputs(
	m: EngineManifest,
	a: Authority,
	parent: string,
	input: Selection,
	parentVerb: 'create' | 'update'
): Readonly<Record<string, ChildInput>> {
	const out: Record<string, ChildInput> = {};
	for (const [inverse, actions] of Object.entries(input.with ?? {})) {
		const relation = manifestRelations(m).inverse.get(`${parent}.${inverse}`);
		if (relation === undefined) continue;
		const { spec: relationSpec, from: collection, fk } = relation;
		const authority = a.collections[collection];
		const remote = syncFields(m, collection);
		const parentArms = a.collections[parent]?.[parentVerb] ?? [];
		const parentDirect =
			a.admin || parentArms.some((arm) => arm.approval !== true && admits([arm], inverse));
		const parentProposal = approves(parentArms, inverse);
		const via = (verb: 'create' | 'update' | 'delete') =>
			(authority?.[verb].length ?? 0) === 0 && (parentDirect || parentProposal);
		const grants = (verb: 'create' | 'update' | 'delete') =>
			a.admin || via(verb) || (authority?.[verb].length ?? 0) > 0;
		const fields = (verb: 'create' | 'update', selection: Selection | {}): readonly string[] =>
			!('columns' in selection)
				? []
				: selection.columns.filter(
						(field) =>
							!remote.includes(field) &&
							!(verb === 'update' && relationSpec.owned && field === fk) &&
							(a.admin || via(verb) || admits(authority?.[verb] ?? [], field))
					);
		const create = actions['create'],
			update = actions['update'];
		out[inverse] = {
			collection,
			parent: fk,
			...(relationSpec.owned ? { owned: true as const } : {}),
			...(create !== undefined && grants('create')
				? {
						create: {
							columns: fields('create', create),
							...(!a.admin && (via('create') ? !parentDirect : approvalOnly(authority?.create))
								? { proposalOnly: true as const }
								: {}),
							...('filled' in create && create.filled !== undefined
								? { filled: create.filled }
								: {})
						}
					}
				: {}),
			...(update !== undefined && grants('update')
				? { update: { columns: fields('update', update) } }
				: {}),
			...(actions['delete'] !== undefined && grants('delete') ? { delete: true as const } : {}),
			...(!relationSpec.owned &&
			!remote.includes(fk) &&
			actions['link'] !== undefined &&
			grants('update')
				? { link: true as const }
				: {}),
			...(!relationSpec.owned &&
			!remote.includes(fk) &&
			relationSpec.optional &&
			actions['unlink'] !== undefined &&
			grants('update')
				? { unlink: true as const }
				: {})
		};
	}
	return out;
}

/** Model field kinds as the ui catalog (stored FieldKind is Kind structurally). */
const fieldsOf = (entries: readonly (readonly [string, unknown])[]): Fields =>
	Schema.decodeUnknownSync(FieldsSchema)(Object.fromEntries(entries));
const outputOf = Schema.decodeUnknownSync(OutputKindSchema);
/** The system collections the browser resolves as targets: the directory (pickers, `actor` operands) and stored files. */
const TARGETS = ['sys_user', 'sys_file', 'sys_invitation'] as const;
/**
 * The caller's syncs on `c` for the view toolbar: a file sync's upload accept list (its parsers' extensions; default
 * xlsx and csv), whether the caller may import (create or update the model) and export (read it); a remote sync with a
 * `read`, and whether the caller may start it ("Sync now").
 */
function syncsOf(
	m: EngineManifest,
	a: Authority,
	c: string,
	reads: boolean
): Pick<CollectionExposure, 'syncs'> {
	const ca = a.collections[c];
	type Entry = NonNullable<CollectionExposure['syncs']>[string];
	const held = Object.fromEntries(
		Object.entries(m.collections[c]?.syncs ?? {}).flatMap(([name, s]): [string, Entry][] => {
			if (s.with === 'file') {
				const parsers = s.parser ?? ['xlsx', 'csv'];
				const formats =
					s.schema === undefined && s.write === true
						? (m.workspace.convert?.to ?? [])
						: parsers.flatMap((parser) =>
								['xlsx', 'csv', 'tsv', 'json'].filter((format) => format === parser)
							);
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
							...(a.actor.kind === 'member' && reads ? { export: formats } : {})
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
 * The caller's collections for ui: the model's label and search fields, the fields and one-relations the collection and
 * the caller's read arms expose (rule 14), the create/update columns the caller holds, and which of the
 * exposed fields are masked on some rows for this caller.
 */
export function exposure(
	m: EngineManifest,
	a: Authority
): { readonly [collection: string]: CollectionExposure } {
	const instanceModel = SYSTEM.models['sys_integration'],
		instanceCollection = SYSTEM.collections['sys_integration'];
	if (instanceModel === undefined || instanceCollection === undefined)
		throw new Error('The native integration instance catalogue is missing.');
	const owner = SYSTEM.relationships['sys_integration.owner'];
	m = {
		...m,
		models: { ...m.models, sys_integration: instanceModel },
		collections: { ...m.collections, sys_integration: instanceCollection },
		relationships: {
			...m.relationships,
			...(owner === undefined ? {} : { 'sys_integration.owner': owner })
		}
	};
	const out: { [c: string]: CollectionExposure } = {};
	for (const [c, spec] of Object.entries(m.collections)) {
		const ca = a.collections[c],
			model = m.models[c];
		const reads = a.admin || (ca?.read.length ?? 0) > 0;
		const writes = (['create', 'update'] as const).filter(
			(v) => spec[v] !== undefined && (a.admin || (ca?.[v].length ?? 0) > 0)
		);
		const queries = Object.entries(spec.queries ?? {}).filter(
			([n]) => a.admin || (ca?.queries.includes(n) ?? false)
		);
		if (model === undefined || (!reads && writes.length === 0)) continue;
		const arms = ca?.read ?? [];
		const armed = (field: string) => a.admin || admits(arms, field);
		const readable = (f: string) =>
			reads && (spec.read.fields === 'all' || spec.read.fields.includes(f)) && armed(f);
		const relExposed = (fk: string) => {
			const r = spec.read.relations ?? (spec.read.fields === 'all' ? 'all' : []);
			return r === 'all' || r.includes(fk);
		};
		// the columns this caller's own create/update arms admit (rule 14): a column no held arm names is filled by the host
		const remote = syncFields(m, c);
		const owned = (manifestRelations(m).from.get(c) ?? [])
			.filter((relation) => relation.spec.owned)
			.map((relation) => relation.fk);
		const columns = (verb: 'create' | 'update') => {
			const admitted = writableColumns(a, c, verb);
			return (spec[verb]?.input.columns ?? []).filter(
				(field) =>
					!remote.includes(field) &&
					(verb !== 'update' || !owned.includes(field)) &&
					(admitted === 'all' || admitted.has(field))
			);
		};
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
			return from === c && ((reads && relExposed(fk) && armed(fk)) || written.has(fk))
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
		const many = !reads
			? []
			: Object.values(m.relationships).flatMap((r) =>
					r.inverse !== undefined && [r.to].flat().includes(c) && relExposed(r.inverse)
						? [r.inverse]
						: []
				); // hook:query
		const children = Object.fromEntries(
			Object.entries(m.relationships).flatMap(([key, relation]) =>
				relation.inverse !== undefined &&
				many.includes(relation.inverse) &&
				[relation.to].flat().includes(c)
					? [
							[
								relation.inverse,
								{
									collection: key.slice(0, key.lastIndexOf('.')),
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
			: Object.keys(ca?.masks ?? {}).filter((f) => fields.some(([x]) => x === f));
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
			...(many.length === 0 ? {} : { many, children }), // hook:query (many)
			...Object.fromEntries(
				writes.map((v) => {
					const input = spec[v]?.input;
					const children = input === undefined ? {} : childInputs(m, a, c, input, v);
					return [
						v,
						{
							columns: columns(v),
							...(Object.keys(children).length === 0 ? {} : { with: children }),
							...(v === 'create' && !a.admin && approvalOnly(ca?.create)
								? { proposalOnly: true as const }
								: {}),
							...(v === 'create' && spec.create?.input.filled !== undefined
								? { filled: spec.create.input.filled.filter((f) => columns(v).includes(f)) }
								: {})
						}
					];
				})
			),
			...(queries.length === 0
				? {}
				: {
						queries: Object.fromEntries(
							queries.map(([n, x]) => [
								n,
								{
									input: fieldsOf(Object.entries(x.input)),
									output: outputOf(x.output),
									description: x.description
								}
							])
						)
					}),
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
		const arms = a.collections[c]?.read ?? [],
			model = SYSTEM.models[c]!,
			read = SYSTEM.collections[c]!.read.fields;
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
