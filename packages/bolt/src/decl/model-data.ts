// Native compiled model metadata. The authoring module imports only its types; executable codecs stay off the guest edge.
import { Predicate, Record as EffectRecord, Schema } from 'effect';
import { FieldData } from './field-data.ts';
import { ExprSchema, COMPUTED_KINDS } from '@norbital-ai/store';
import { column_layers, LAYER_MAX_DEPTH, type ExposureSpec, type ModelParts, type ModelSpec, type ReadLayers, type SearchIndexSpec, type SyncEntry } from './model.ts';
import type { RelationshipSpec } from './names.ts';

const ModelFields = Schema.Record(Schema.String, FieldData);
const ModelStrings = Schema.Array(Schema.String);
const ModelMarker = Schema.optionalKey(Schema.Literal(true));
const SearchIndexData = Schema.Struct({
	description: Schema.String, dim: Schema.Number,
	metric: Schema.Literals(['l2', 'cosine', 'ip']),
	field: Schema.optionalKey(Schema.String), input: ModelFields,
	candidates: Schema.optionalKey(Schema.Literals([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])),
	rerank: ModelMarker
});
const ModelMetadata = {
	/** What a record is, for people and the agent. */
	description: Schema.String,
	/** The previous model name, preserved by a schema rename. */
	was: Schema.optionalKey(Schema.String),
	icon: Schema.optionalKey(Schema.String),
	/**
	 * Pure CEL over `record`: the one identifier for record titles, the primary table column, board cards, pickers,
	 * references, approval requests and record search in Find and the agent (explicit titles and snippets override it).
	 * An own-field label is a generated `bolt_record_label` column in the row's text search document, recomputed on
	 * every write; changing the expression migrates existing rows. One-hop ref fields resolve at read time from the
	 * selected output under its grants, unstored; a hidden dependency shows the id. Use conditionals for optional values
	 * (`record.name != null ? record.name : 'Unnamed'`) and `string(...)` for numbers; clocks and `requestor` are excluded.
	 * Omitted, records show their id, and record search needs a `text` index.
	 * @example
	 * record_label: "record.code + ' · ' + record.name"
	 */
	record_label: Schema.optionalKey(Schema.String)
};
const SystemTableData = Schema.Struct({
	primary: Schema.Union([Schema.Literals(['text', 'uuid', 'identity']), Schema.Struct({ field: Schema.String })]),
	identity: Schema.optionalKey(Schema.String)
});
/** Native storage metadata shares the canonical kind and expression codecs; author literals retain their narrower checks. */
export const ModelData = Schema.Struct({
	...ModelMetadata,
	fields: ModelFields,
	key: Schema.optionalKey(ModelStrings),
	unique: Schema.optionalKey(Schema.Array(Schema.Struct({
		fields: ModelStrings, where: Schema.optionalKey(Schema.JsonObject),
		name: Schema.optionalKey(Schema.String), import_key: ModelMarker
	}))),
	indexes: Schema.optionalKey(Schema.Array(Schema.Struct({
		on: Schema.Array(Schema.Union([Schema.String, Schema.Struct({ lower: Schema.String })])),
		unique: ModelMarker, where: Schema.optionalKey(Schema.JsonObject)
	}))),
	check: Schema.optionalKey(Schema.Record(Schema.String, Schema.JsonObject)),
	locks: Schema.optionalKey(Schema.Record(Schema.String, Schema.Struct({
		where: Schema.JsonObject, except: Schema.optionalKey(ModelStrings)
	}))),
	no_overlap: Schema.optionalKey(Schema.Array(Schema.Struct({
		key: ModelStrings, period: Schema.String, where: Schema.optionalKey(Schema.JsonObject), name: Schema.optionalKey(Schema.String)
	}))),
	computed: Schema.optionalKey(Schema.Record(Schema.String, Schema.Struct({
		kind: Schema.Literals(COMPUTED_KINDS), scale: Schema.optionalKey(Schema.Number), expr: ExprSchema
	}))),
	search: Schema.optionalKey(Schema.Struct({
		text: ModelStrings,
		semantic: Schema.optionalKey(Schema.Struct({ fields: ModelStrings, model: Schema.String, dim: Schema.Number })),
		indexes: Schema.optionalKey(Schema.Record(Schema.String, SearchIndexData))
	})),
	/** Each named constraint's refusal message: a catalogue key, rendered as a refusal's (no schema effect). */
	messages: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
	/** Native physical keys and numbered fields, never a workspace authoring option. */
	table: Schema.optionalKey(SystemTableData)
});
/** Native sync data; guest bodies are markers, never executable manifest values. */
export const SyncData = Schema.Struct({
	with: Schema.String,
	parser: Schema.optionalKey(Schema.Array(Schema.Union([
		Schema.String, Schema.Struct({ type: Schema.String, extensions: ModelStrings })
	]))),
	schema: Schema.optionalKey(ModelFields), context: Schema.optionalKey(ModelFields),
	every: Schema.optionalKey(Schema.String), partitions: Schema.optionalKey(Schema.String),
	read: ModelMarker, write: ModelMarker
});

export const ConstraintData = /* @__PURE__ */ (() => {
	const where = Schema.Record(Schema.String, Schema.Json);
	const optionalWhere = Schema.optionalKey(where);
	const fields = Schema.Array(Schema.String);
	const message = Schema.optionalKey(Schema.String);
	return Schema.Record(
		Schema.String,
		Schema.Union([
			Schema.Struct({
				unique: Schema.NonEmptyArray(Schema.String),
				where: optionalWhere,
				import_key: Schema.optionalKey(Schema.Literal(true)),
				message
			}),
			Schema.Struct({ check: where, message }),
			Schema.Struct({ no_overlap: Schema.String, per: fields, where: optionalWhere, message }),
			Schema.Struct({ locked: where, except: Schema.optionalKey(fields), message })
		])
	);
})();

/** Native relation metadata is shared by lowering and artifact decoding. */
export const RelationshipData = Schema.Struct({
	to: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
	inverse: Schema.optionalKey(Schema.String), optional: ModelMarker,
	default: Schema.optionalKey(Schema.Struct({ var: Schema.Literals(['requestor.id', 'requestor.party']) })),
	on_delete: Schema.optionalKey(Schema.Literals(['restrict', 'cascade', 'set_null'])),
	owned: ModelMarker, where: Schema.optionalKey(Schema.JsonObject)
});
const SourceIndexData = Schema.Union([
	Schema.Struct({
		on: Schema.Array(Schema.Union([Schema.String, Schema.Struct({ lower: Schema.String })])),
		unique: ModelMarker, where: Schema.optionalKey(Schema.JsonObject)
	}),
	Schema.Struct({ text: ModelStrings }),
	Schema.Struct({ semantic: Schema.Struct({ fields: ModelStrings, model: Schema.String, dim: Schema.Number }) }),
	Schema.Struct({
		description: Schema.String, dim: Schema.Number, metric: Schema.Literals(['l2', 'cosine', 'ip']),
		vector: Schema.Unknown, probe: Schema.Unknown, input: ModelFields,
		rerank: Schema.optionalKey(Schema.Unknown), candidates: SearchIndexData.fields.candidates
	})
]);
/** Bodies and unresolved trees remain unknown until their owning compiler/lowerer validates them; no claimed literal type. */
const SourceModelData = Schema.Struct({
	...ModelMetadata,
	fields: Schema.Record(Schema.String, Schema.Union([
		FieldData,
		Schema.Struct({ kind: Schema.Literals(COMPUTED_KINDS), computed: ExprSchema, scale: Schema.optionalKey(Schema.Number) })
	])),
	constraints: Schema.optionalKey(ConstraintData),
	indexes: Schema.optionalKey(Schema.Record(Schema.String, SourceIndexData)),
	outputs: Schema.optionalKey(Schema.StructWithRest(Schema.Struct({ default: Schema.Unknown }), [
		Schema.Record(Schema.String, Schema.Unknown)
	])),
	create: Schema.optionalKey(Schema.Struct({
		columns: Schema.Unknown, filled: Schema.optionalKey(Schema.Unknown),
		transform: Schema.optionalKey(Schema.Unknown), effect: Schema.optionalKey(Schema.Unknown)
	})),
	update: Schema.optionalKey(Schema.Struct({
		columns: Schema.Unknown, transform: Schema.optionalKey(Schema.Unknown), effect: Schema.optionalKey(Schema.Unknown)
	})),
	delete: Schema.optionalKey(Schema.Struct({
		transform: Schema.optionalKey(Schema.Unknown), effect: Schema.optionalKey(Schema.Unknown)
	})),
	syncs: Schema.optionalKey(Schema.Record(Schema.String, Schema.Struct({
		with: Schema.String,
		parser: Schema.optionalKey(Schema.Array(Schema.Union([
			Schema.String, Schema.Struct({ type: Schema.String, extensions: ModelStrings, parse: Schema.Unknown })
		]))),
		schema: Schema.optionalKey(ModelFields), context: Schema.optionalKey(ModelFields),
		every: Schema.optionalKey(Schema.String), partitions: Schema.optionalKey(Schema.String),
		read: Schema.optionalKey(Schema.Unknown), write: Schema.optionalKey(Schema.Unknown)
	})))
});
const decodeSourceModel = Schema.decodeUnknownSync(SourceModelData, { onExcessProperty: 'error' });
const decodeSystemModel = Schema.decodeUnknownSync(Schema.Struct({
	...SourceModelData.fields,
	table: SystemTableData
}), { onExcessProperty: 'error' });
const decodeRelationship = Schema.decodeUnknownSync(RelationshipData, { onExcessProperty: 'error' });
const OutputFields = Schema.Union([Schema.Literal('all'), ModelStrings]);

/**
 * Splits a model literal into storage (`ModelSpec`, refs removed), its refs (`RelationshipSpec` by `'<name>.<field>'`) and,
 * when it declares `outputs.default`, its exposure (`ExposureSpec`). Output trees become native read paths and
 * a body (a function or the check serializer's `true`) becomes its marker.
 */
export function split_model(name: string, source: unknown): ModelParts {
	return model_parts(name, decodeSourceModel(source));
}
/** Built-in tables share ordinary lowering after their separate physical metadata has been decoded. */
export function split_system_model(name: string, source: unknown): ModelParts {
	const { table, ...literal } = decodeSystemModel(source);
	const parts = model_parts(name, literal);
	return { ...parts, model: { ...parts.model, table } };
}
function model_parts(name: string, literal: typeof SourceModelData.Type): ModelParts {
	const {
		fields,
		constraints,
		indexes,
		outputs,
		create,
		update,
		delete: del,
		syncs,
		...storage
	} = literal;
	const own: Record<string, ModelSpec['fields'][string]> = {};
	const computed: Record<string, NonNullable<ModelSpec['computed']>[string]> = {};
	const relationships: { [key: string]: RelationshipSpec } = {};
	for (const [field, kind] of Object.entries(fields)) {
		if ('computed' in kind)
			computed[field] = {
				kind: kind.kind,
				expr: kind.computed,
				...(kind.scale === undefined ? {} : { scale: kind.scale })
			};
		else if (kind.kind !== 'ref') own[field] = kind;
		else if (kind.many === true) {
			const { on_delete, owned, inverse, where, ...value } = kind;
			if (on_delete !== undefined || owned === true || inverse !== undefined)
				throw new Error(`'${name}.${field}': many references are inline values`);
			own[field] = {
				...value,
				...(where === undefined
					? {}
					: { where: Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(where) })
			};
		} else {
			const { kind: _ref, ...relationship } = kind;
			relationships[`${name}.${field}`] = decodeRelationship(relationship);
		}
	}
	type RuleData = Pick<ModelSpec, 'key' | 'unique' | 'check' | 'no_overlap' | 'locks' | 'messages'>;
	const rules: { -readonly [K in keyof RuleData]: RuleData[K] } = {};
	if (constraints !== undefined) {
		const unique: NonNullable<ModelSpec['unique']>[number][] = [];
		const check: Record<string, NonNullable<ModelSpec['check']>[string]> = {};
		const no_overlap: NonNullable<ModelSpec['no_overlap']>[number][] = [];
		const locks: Record<string, NonNullable<ModelSpec['locks']>[string]> = {};
		const messages: Record<string, string> = {};
		for (const [rule, constraint] of Object.entries(constraints)) {
			if (constraint.message !== undefined) messages[rule] = constraint.message;
			if ('unique' in constraint) {
				const { unique: fields, where, import_key } = constraint;
				if (import_key === true) {
					if (rules.key !== undefined)
						throw new Error(`model '${name}': only one unique constraint may be the import_key`);
					if (where !== undefined)
						throw new Error(`model '${name}': import_key '${rule}' cannot be partial`);
					rules.key = fields;
				}
				unique.push({ fields, name: rule,
					...(where === undefined ? {} : { where }),
					...(import_key === undefined ? {} : { import_key }) });
			} else if ('check' in constraint) {
				check[rule] = constraint.check;
			} else if ('no_overlap' in constraint) {
				const { no_overlap: period, per: key, where } = constraint;
				no_overlap.push({ key, period, name: rule, ...(where === undefined ? {} : { where }) });
			} else {
				const { locked: where, except } = constraint;
				locks[rule] = { where, ...(except === undefined ? {} : { except }) };
			}
		}
		if (unique.length > 0) rules.unique = unique;
		if (Object.keys(check).length > 0) rules.check = check;
		if (no_overlap.length > 0) rules.no_overlap = no_overlap;
		if (Object.keys(locks).length > 0) rules.locks = locks;
		if (Object.keys(messages).length > 0) rules.messages = messages;
	}
	const physical: NonNullable<ModelSpec['indexes']>[number][] = [];
	const text = new Set<string>();
	let semantic: NonNullable<ModelSpec['search']>['semantic'];
	const searches: Record<string, SearchIndexSpec> = {};
	for (const [index, entry] of Object.entries(indexes ?? {})) {
		if ('on' in entry) physical.push(entry);
		else if ('text' in entry) for (const field of entry.text) text.add(field);
		else if ('semantic' in entry) {
			if (semantic !== undefined) throw new Error(name + ': declare one semantic index');
			semantic = entry.semantic;
		} else {
			if (index === 'semantic')
				throw new Error(name + ": 'semantic' is reserved for semantic search");
			searches[index] = {
				description: entry.description,
				dim: entry.dim,
				metric: entry.metric,
				input: entry.input,
				...(typeof entry.vector === 'string' ? { field: entry.vector } : {}),
				...(entry.candidates === undefined ? {} : { candidates: entry.candidates }),
				...(entry.rerank === undefined ? {} : { rerank: true })
			};
		}
	}
	const stored: ModelSpec = {
		...storage,
		...rules,
		fields: own,
		...(Object.keys(computed).length === 0 ? {} : { computed }),
		...(physical.length === 0 ? {} : { indexes: physical }),
		...(text.size === 0 && semantic === undefined && Object.keys(searches).length === 0
			? {}
			: {
					search: {
						text: [...text],
						...(semantic === undefined ? {} : { semantic }),
						...(Object.keys(searches).length === 0 ? {} : { indexes: searches })
					}
				})
	};
	if (outputs === undefined) return { model: stored, relationships };
	const { default: defaultOutput, ...named } = outputs;
	const layersOf = (output: unknown): ReadLayers => {
		const layers: Record<string, { fields: 'all' | readonly string[] }> = {};
		const add = (path: string, layer: unknown, depth: number) => {
			if (depth > LAYER_MAX_DEPTH || !Predicate.isReadonlyObject(layer) || Array.isArray(layer))
				throw new Error(`${path}: expected a nested output at most ${LAYER_MAX_DEPTH} levels deep`);
			layers[path] = { fields: Schema.decodeUnknownSync(OutputFields)(layer['fields']) };
			for (const [relation, child] of Object.entries(layer)) {
				if (relation === 'fields') continue;
				if (relation.includes('.')) throw new Error(`${path}.${relation}: use a nested output`);
				add(`${path}.${relation}`, child, depth + 1);
			}
		};
		add(name, output, 1);
		return layers;
	};
	const exposure: ExposureSpec = {
		outputs: { default: layersOf(defaultOutput), ...EffectRecord.map(named, layersOf) },
		...(create === undefined
			? {}
			: {
					create: {
						columns: column_layers(name, create.columns),
						...(create.filled === undefined ? {} : { filled: column_layers(name, create.filled) }),
						...(create.transform === undefined ? {} : { transform: true }),
						...(create.effect === undefined ? {} : { effect: true }),
					}
				}),
		...(update === undefined
			? {}
			: {
					update: {
						columns: column_layers(name, update.columns),
						...(update.transform === undefined ? {} : { transform: true }),
						...(update.effect === undefined ? {} : { effect: true })
					}
				}),
		...(del === undefined ? {} : { delete: {
			...(del.transform === undefined ? {} : { transform: true }),
			...(del.effect === undefined ? {} : { effect: true })
		} }),
		...(syncs === undefined
			? {}
			: {
					syncs: EffectRecord.map(syncs, (x): SyncEntry => ({
						with: x.with,
						...(x.parser === undefined
							? {}
							: {
									parser: x.parser.map((p) =>
										typeof p === 'string' ? p : { type: p.type, extensions: p.extensions }
									)
								}),
						...(x.schema === undefined ? {} : { schema: x.schema }),
						...(x.context === undefined ? {} : { context: x.context }),
						...(x.every === undefined ? {} : { every: x.every }),
						...(x.partitions === undefined ? {} : { partitions: x.partitions }),
						...(x.read === undefined ? {} : { read: true }),
						...(x.write === undefined ? {} : { write: true })
					}))
				})
	};
	return { model: stored, relationships, exposure };
}

