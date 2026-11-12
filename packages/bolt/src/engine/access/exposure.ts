// The caller's authorized model catalogue for generated forms and record views.
import { Effect, Schema } from 'effect';
import type { ModelExposure, Fields } from '@norbital-ai/ui';
import type { Authority } from '../contracts.ts';
import type { EngineManifest } from '../manifest.ts';
import { relations as manifestRelations } from '../manifest.ts';
import { nullable_of_expr, type LayerColumns } from '../../decl/model.ts';
import { FieldsSchema } from '../../protocol/public-page.ts';
import { SYSTEM } from '../../system/index.ts';
import { grantedArms, historyArms, viewOutput } from './authority.ts';
import { label_paths } from '@norbital-ai/std/label';
import { catalog_of } from './pred.ts';
import { default_fields, type ExposureInfo, type OutputInfo } from '@norbital-ai/store';
import type { Fields as KindFields, Kind } from '@norbital-ai/std/kind';
import { customShape } from '../callables/kinds.ts';
import type { ReadCatalog } from '../../protocol/read-answer.ts';
import { BoltError } from '../../protocol/errors.ts';

/** A catalogue fault: the validated manifest does not hold what its own catalogue names. */
const fault = (message: string) => Effect.fail(BoltError.make('internal', 'derive', message));
/** Validation metadata is separate from the generic views' chosen output, and never includes an ungranted output. */
export const read_catalog = Effect.fn('bolt.read_catalog')(function* (m: EngineManifest, a: Authority) {
	const cat = catalog_of(m), models = { ...SYSTEM.models, ...m.models }, relationships = { ...SYSTEM.relationships, ...m.relationships };
	const expand = (kind: Kind, seen: ReadonlySet<string>): Effect.Effect<Kind, BoltError> => {
		const fields = (members: KindFields): Effect.Effect<KindFields, BoltError> =>
			Effect.map(
				Effect.forEach(Object.entries(members), ([name, child]) => Effect.map(expand(child, seen), (expanded) => [name, expanded] as const)),
				(entries) => Object.fromEntries(entries)
			);
		switch (kind.kind) {
			case 'custom': {
				const shape = customShape(m.custom_fields, kind.of);
				if (shape === undefined || seen.has(kind.of)) return fault(`Invalid custom read field '${kind.of}'.`);
				const { kind: _kind, of: _of, ...common } = kind;
				return Effect.map(expand(shape, new Set([...seen, kind.of])), (resolved): Kind => ({ kind: 'json', shape: resolved, ...common }));
			}
			case 'object': {
				const object = kind;
				return Effect.map(
					Effect.all([fields(object.fields), object.rest === undefined ? Effect.succeed(undefined) : expand(object.rest, seen)]),
					([members, rest]): Kind => ({ ...object, fields: members, ...(rest === undefined ? {} : { rest }) })
				);
			}
			case 'record': {
				const record = kind;
				return Effect.map(expand(record.of, seen), (of): Kind => ({ ...record, of }));
			}
			case 'json': {
				const json = kind;
				return json.shape === undefined ? Effect.succeed(json) : Effect.map(expand(json.shape, seen), (shape): Kind => ({ ...json, shape }));
			}
			case 'union': {
				const union = kind;
				// Untagged arms are scalars: nothing to expand.
				return 'of' in union
					? Effect.succeed(union)
					: Effect.map(
						Effect.forEach(Object.entries(union.arms), ([tag, members]) => Effect.map(fields(members), (expanded) => [tag, expanded] as const)),
						(arms): Kind => ({ ...union, arms: Object.fromEntries(arms) })
					);
			}
			default: return Effect.succeed(kind);
		}
	};
	const fields_of = Effect.fnUntraced(function* (level: ExposureInfo) {
		const model = models[level.name];
		if (model === undefined) return yield* fault(`Missing read model '${level.name}'.`);
		const relations: (readonly [string, unknown])[] = [];
		for (const [path, relation] of Object.entries(relationships)) {
			if (!path.startsWith(`${level.name}.`) || path.slice(level.name.length + 1).includes('.')) continue;
			const targets = typeof relation.to === 'string' ? [relation.to] : relation.to;
			const first = targets[0];
			if (first === undefined) return yield* fault(`Read relation '${path}' has no target.`);
			relations.push([path.slice(level.name.length + 1), { kind: 'ref', ...relation, to: targets.length === 1 ? first : targets }]);
		}
		const fields = yield* fieldsOf([
			...Object.entries(model.fields),
			...Object.entries(model.computed ?? {}).map(([name, computed]) => [name, {
				kind: computed.kind,
				...(computed.kind === 'decimal' ? { scale: computed.scale ?? 0 } : {}),
				...(nullable_of_expr(computed.expr, model) ? { optional: true } : {})
			}] as const),
			...relations,
			...(!level.model.fields.has('id') ? [] : [['id', { kind: 'ref', to: level.name }] as const]),
			...(level.model.audit !== true ? [] : [
				['revision', { kind: 'int' }],
				['created_at', { kind: 'instant' }], ['updated_at', { kind: 'instant' }],
				['created_by', { kind: 'ref', to: 'sys_user', optional: true }], ['updated_by', { kind: 'ref', to: 'sys_user', optional: true }]
			] as const)
		]);
		const read: Record<string, Kind> = {};
		for (const name of default_fields(level, true)) {
			const kind = fields[name];
			if (kind === undefined) return yield* fault(`Missing read field '${level.name}.${name}'.`);
			read[name] = yield* expand(kind, new Set());
		}
		return read;
	});
	const entries = new Map<string, ReadCatalog[string]>();
	for (const [model, root] of cat.exposures) {
		if (model === 'sys_run') continue;
		const outputs = new Map<string, OutputInfo>([['default', { root, layers: new Map([...cat.layers].filter(([path]) => path.startsWith(`${model}.`))) }], ...(cat.outputs.get(model) ?? [])]);
		const held = new Map<string, ReadCatalog[string][string]>();
		for (const [name, output] of outputs) {
			if (!a.admin && grantedArms(a, model, name) === undefined) continue;
			const levels = new Map<string, ReadCatalog[string][string][string]>();
			for (const [path, level] of [[model, output.root] as const, ...output.layers]) {
				const at = path.lastIndexOf('.'), parent = at < 0 ? undefined : (path.slice(0, at) === model ? output.root : output.layers.get(path.slice(0, at)));
				levels.set(path, { model: level.name, many: parent?.model.many.has(path.slice(at + 1)) === true, list_fields: default_fields(level), fields: yield* fields_of(level) });
			}
			held.set(name, Object.fromEntries(levels));
		}
		if (held.size > 0) entries.set(model, Object.fromEntries(held));
	}
	const catalog: ReadCatalog = Object.fromEntries(entries);
	return catalog;
});

const labelMetadata = (
	model: {
		record_label?: string;
		table?: unknown;
		search?: { text: readonly string[] };
	},
	readable: (field: string) => boolean
) => {
	const expression = model.record_label;
	const paths = label_paths(expression);
	const fields = [...new Set(paths.map((path) => path.split('.')[0] ?? path))];
	const visible = expression !== undefined && paths.every(readable);
	const search = [...(visible ? ['$label'] : []), ...(model.search?.text.filter(readable) ?? [])];
	return {
		label: visible ? fields : [],
		...(visible ? { record_label: expression, label_paths: paths } : {}),
		...(search.length === 0 ? {} : { search })
	};
};

/** A relationship's static `where` is JSON by construction; decoded once for the browser's picker. */
const pickerWhere = (where: unknown) =>
	Schema.decodeUnknownEffect(Schema.UndefinedOr(Schema.Record(Schema.String, Schema.Json)))(where).pipe(
		Effect.mapError((error) => BoltError.make('internal', 'derive', error.message, error))
	);

type ChildInput = NonNullable<NonNullable<ModelExposure['update']>['with']>[string];
type Relation = NonNullable<ModelExposure['relations']>[string];
/** Required stamps of the initial state are supplied by the engine on create. */
const initialStamps = (m: EngineManifest, model: string): readonly string[] =>
	Object.values(m.models[model]?.fields ?? {}).flatMap((kind) => {
		const stamp = kind.kind === 'state' ? kind.states[kind.initial]?.stamp : undefined;
		return stamp === undefined ? [] : [stamp];
	});
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
		const supplied = [...new Set([...(filled?.[at] ?? []), ...initialStamps(m, child)])]
			.filter((field) => own.includes(field));
		out[inverse] = {
			model: child,
			parent: fk,
			...(relationSpec.owned ? { owned: true as const } : {}),
			create: {
				columns: own,
				...(supplied.length === 0 ? {} : { filled: supplied })
			},
			...(verb === 'update' ? { update: { columns: own }, delete: true as const } : {}),
			...(free ? { link: true as const } : {}),
			...(free && verb === 'update' && relationSpec.optional ? { unlink: true as const } : {})
		};
	}
	return out;
}

/** Model field kinds as the ui catalog (stored FieldKind is Kind structurally). */
const fieldsOf = (entries: readonly (readonly [string, unknown])[]): Effect.Effect<Fields, BoltError> =>
	Schema.decodeUnknownEffect(FieldsSchema)(Object.fromEntries(entries)).pipe(
		Effect.mapError((error) => BoltError.make('internal', 'derive', error.message, error))
	);
/** The system models the browser resolves as targets: the directory (pickers, `actor` operands) and stored files. */
const TARGETS = ['sys_user', 'sys_file', 'sys_invitation', 'approval_request'] as const;
/**
 * The caller's syncs on `c` for the view toolbar: a file sync's upload accept list (its parsers' extensions; default
 * xlsx and csv), whether the caller may import (create or update the model) and export (read it), and its required
 * context fields; a remote sync with a
 * `read`, and whether the caller may start it ("Sync now").
 */
function syncs_of(
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
								['xlsx', 'csv', 'tsv', 'json', 'txt'].filter((format) => format === parser)
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
			return s.read === true && reads && (a.admin || a.capabilities.syncs.includes(`${c}.${name}`))
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
	const [rel, f] = k.of.split('.');
	if (rel === undefined || f === undefined) return k;
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
 * The caller's models for ui: the model's label and search fields, the fields, one-relations and layers of the output
 * the caller's views read (`default` when granted, else the first named output it holds; `output` names a named one),
 * and the create/update columns the caller holds.
 */
export const exposure = Effect.fn('bolt.exposure')(function* (
	m: EngineManifest,
	a: Authority
): Effect.fn.Return<{ readonly [model: string]: ModelExposure }, BoltError> {
	const catalogued = catalog_of(m);
	const instanceModel = SYSTEM.models['sys_integration'],
		instanceExposure = SYSTEM.exposures['sys_integration'];
	if (instanceModel === undefined || instanceExposure === undefined)
		return yield* fault('The native integration instance catalogue is missing.');
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
		const output = viewOutput(m, a, c);
		const reads = output !== undefined;
		const read = spec.outputs[output ?? 'default'] ?? {};
		const writes = (['create', 'update'] as const).filter(
			(v) => spec[v] !== undefined && (a.admin || (ca?.[v].length ?? 0) > 0)
		);
		if (model === undefined || (!reads && writes.length === 0)) continue;
		// the root layer's fields in the output the caller's views read
		const declared = read[c]?.fields ?? [];
		const readable = (f: string) => reads && (declared === 'all' || declared.includes(f));
		const label_readable = (path: string) => {
			const [field = path, leaf] = path.split('.');
			if (leaf === undefined || m.relationships[`${c}.${field}`] === undefined)
				return readable(field);
			const layer = read[`${c}.${field}`];
			return layer !== undefined && (layer.fields === 'all' || layer.fields.includes(leaf));
		};
		// the columns this caller's own create/update arms admit: a column no held arm names is filled by the host
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
							...(nullable_of_expr(x.expr, model) ? { optional: true as const } : {})
						}
					] as const
			)
		].filter(([f]) => readable(f) || written.has(f));
		const relations = (yield* Effect.forEach(
			Object.entries(m.relationships),
			([key, r]): Effect.Effect<readonly (readonly [string, Relation])[], BoltError> => {
				const [from, fk] = key.split('.');
				if (from !== c || fk === undefined || !(readable(fk) || written.has(fk)))
					return Effect.succeed([]); // hook:query (inverse)
				return Effect.map(pickerWhere(r.where), (where) => [
						[
							fk,
							{
								targets: [r.to].flat(),
								...(r.optional === true ? { optional: true as const } : {}),
								...(r.inverse === undefined ? {} : { inverse: r.inverse }),
								// what a picker for this reference offers, as a write would accept it
								...(where === undefined ? {} : { where })
							}
						] as const
				]);
			}
		)).flat();
		// the root's read layers one level down (a ref or a many-relation); the many-relations among them
		const layers = !reads
			? []
			: Object.keys(read).flatMap((path) => {
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
		const readonly_fields = Object.fromEntries([
			...remote.filter(readable).map((field) => [field, 'sync_owned'] as const),
			...owned
				.filter((field) => readable(field) || relations.some(([fk]) => fk === field))
				.map((field) => [field, 'owned_parent'] as const)
		]);
		const locks = Object.values(model.locks ?? {});
		const indexes = reads
			? yield* Effect.forEach(Object.entries(model.search?.indexes ?? {}), ([n, x]) =>
					Effect.map(
						fieldsOf(Object.entries(x.input)),
						(input) => [n, { input, description: x.description }] as const
					)
				)
			: [];
		out[c] = {
			...labelMetadata(model, label_readable),
			...(output === undefined || output === 'default' ? {} : { output }),
			...(model.search?.semantic === undefined ? {} : { semantic: true as const }),
			...(catalogued.models.get(c)?.audit === true &&
			(a.admin || (output !== undefined && historyArms(a, c, output).length > 0))
				? {}
				: { audit: false as const }),
			fields: yield* fieldsOf(fields),
			...(indexes.length > 0 ? { indexes: Object.fromEntries(indexes) } : {}),
			...(relations.length === 0 ? {} : { relations: Object.fromEntries(relations) }),
			...(layers.length === 0 ? {} : { layers }),
			...(many.length === 0 ? {} : { many, children }), // hook:query (many)
			...Object.fromEntries(
				writes.map((v) => {
					const filled = v === 'create' ? spec.create?.filled : undefined;
					const supplied = v === 'create'
						? [...new Set([...(filled?.[c] ?? []), ...initialStamps(m, c)])]
							.filter((field) => columns(v).includes(field))
						: [];
					const children = childInputs(m, a, c, spec[v]?.columns ?? {}, c, c, v, filled);
					return [
						v,
						{
							columns: columns(v),
							...(Object.keys(children).length === 0 ? {} : { with: children }),
							...(supplied.length === 0 ? {} : { filled: supplied })
						}
					];
				})
			),
			...(Object.keys(readonly_fields).length === 0 ? {} : { readonly_fields }),
			...(locks.length === 0 ? {} : { locks }),
			description: model.description,
			...(spec.delete !== undefined && (a.admin || (ca?.delete.length ?? 0) > 0)
				? { delete: true }
				: {}),
			...syncs_of(m, a, c, reads)
		};
	}
	// the system targets a relation, an `id` input or a file field points at: the fields of the output the caller's grants
	// or the kernel directory let it read
	for (const c of TARGETS) {
		const output = viewOutput(m, a, c);
		if (output === undefined) continue;
		const model = SYSTEM.models[c], spec = SYSTEM.exposures[c];
		if (model === undefined || spec === undefined) return yield* fault(`The native catalogue is missing '${c}'.`);
		const read = spec.outputs[output]?.[c]?.fields ?? [];
		const shown = (f: string) => read === 'all' || read.includes(f);
		const readable = Object.entries(model.fields).filter(([f]) => shown(f));
		const relations = Object.entries(SYSTEM.relationships).flatMap(([key, relation]) => {
			const [from, field] = key.split('.');
			return from === c && field !== undefined && shown(field)
				? ([
						[
							field,
							{
								targets: [relation.to].flat(),
								...(relation.optional === true ? { optional: true as const } : {})
							}
						]
					] as const)
				: [];
		});
		out[c] = {
			...labelMetadata(model, shown),
			...(c === 'approval_request' && shown('collection_name') && shown('record_id')
				? { search: ['$label', 'collection_name'] }
				: {}),
			...(output === 'default' ? {} : { output }),
			fields: yield* fieldsOf(readable),
			...(relations.length > 0 ? { relations: Object.fromEntries(relations) } : {})
		};
	}
	return out;
});
