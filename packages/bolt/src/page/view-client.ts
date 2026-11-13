// Native controls share the page transport without choosing an unrelated result type or exposing native reads to authors.
import { Array as Arr, Effect, Result, Schema, SchemaGetter } from 'effect';
import { Decimal } from '@norbital-ai/store/decimal';
import { KindSchema, type Value } from '@norbital-ai/store/kind';
import { encode_wire, type Json } from '@norbital-ai/store/wire';
import type { ModelExposure, RecordOf, RowOf, SourceColumns, SourceRow, ViewBolt, ViewSource } from '@norbital-ai/ui';
import { unref } from '@norbital-ai/ui/read';
import { ReadFailed } from '../decl/errors.ts';
import { read_answer, aggregate_answer, type ReadCatalog } from '../protocol/read-answer.ts';
import { kind_value } from '../protocol/output-contract.ts';
import { HistoryRevisionSchema, HistorySnapshotSchema } from '../protocol/record-contracts.ts';
import type { Bolt } from './bolt.ts';
import type { Query } from './page-bolt.ts';

type ModelKey = Parameters<ViewBolt['model_query']>[0];
type Pages = Effect.Success<ReturnType<ViewBolt['query']>>;
type Row = Pages[string]['rows'][number];
type ModelRow<C, M> = (M extends 'record' ? RecordOf<C> : RowOf<C>) & Row;
type ModelPages<C, M> = Readonly<Record<string, Omit<Pages[string], 'rows'> & { rows: readonly ModelRow<C, M>[] }>>;
type SourcePages<S> = Readonly<Record<string, Omit<Pages[string], 'rows'> & { rows: readonly (SourceRow<S> & Partial<SourceColumns<S>>)[] }>>;
type Host = Omit<ViewBolt, 'query' | 'model_query' | 'source_query' | 'project_record' | 'aggregate' | 'history'> & Pick<Bolt, 'native_query'>;

const ValueSelf: Schema.Decoder<Value> = Schema.suspend(() => Schema.Union([
	Schema.Null, Schema.Boolean, Schema.Finite, Schema.String,
	Schema.declare((value: unknown): value is Decimal => value instanceof Decimal),
	Schema.Array(ValueSelf), Schema.Record(Schema.String, ValueSelf)
]));
const Values = Schema.Record(Schema.String, ValueSelf);
const Row = Schema.StructWithRest(Schema.Struct({ id: Schema.String }), [Values]);
const Page = <S extends Schema.Top>(row: S) => Schema.Struct({
	rows: Schema.Array(row), next: Schema.NullOr(Schema.String), total: Schema.optionalKey(Schema.Number)
});
const Buckets = Page(Values);
const Pages = Schema.Record(Schema.String, Page(Row));
const isObject = (value: Json | undefined): value is Readonly<Record<string, Json>> =>
	value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value);
const isList = (value: Json | undefined): value is readonly Json[] => Array.isArray(value);
const refused = (message: string): never => { throw new ReadFailed({ code: 'protocol', message }); };
const kindText = Schema.encodeSync(KindSchema);
const sameKind = (left: Parameters<typeof kindText>[0], right: Parameters<typeof kindText>[0]) =>
	JSON.stringify(kindText(left)) === JSON.stringify(kindText(right));

/** The private UI boundary: author queries keep their literal request inference on the original client. */
export function view_client(
	client: Host,
	read_catalog: ReadCatalog,
	catalog: Readonly<Record<string, ModelExposure>>
): ViewBolt {
	/** A model view's row: the wire codec of its default output's promised fields, the same codecs every read answer uses. */
	const model_wire = (model: ModelKey, mode: 'list' | 'record') => {
		const level = read_catalog[model]?.['default']?.[model];
		if (level === undefined) return refused(`The default read output of '${model}' is not granted for this model view.`);
		const required = mode === 'record' ? Object.keys(level.fields) : level.list_fields;
		const fields = Object.fromEntries(required.map((field) => {
			const kind = level.fields[field];
			if (kind === undefined) return refused(`No declared schema exists for '${model}.${field}'.`);
			return [field, kind_value(kind)];
		}));
		return Schema.StructWithRest(Schema.Struct(fields), [Values]);
	};
	/** Rows already decoded by their read answer validate on the codecs' type side. */
	const model_row = <C extends ModelKey, M extends 'list' | 'record'>(model: C, mode: M) => {
		const shape = Schema.toType(model_wire(model, mode)), complete = Schema.is(shape);
		// Both the declared fields and the generated row type come from this supplied model, never an independent T.
		return shape.pipe(Schema.decodeTo(Schema.declare((value: unknown): value is ModelRow<C, M> => complete(value))));
	};
	const query: ViewBolt['query'] = (request) => client.native_query(
		{ m: 'query', a: [request] },
		Schema.suspend(() => read_answer(read_catalog, request).pipe(Schema.decodeTo(Pages)))
	);
	const project_record = <C extends ModelKey>(model: C, record: Row): ModelRow<C, 'record'> | null => {
		if (read_catalog[model]?.['default']?.[model] === undefined) return null;
		const decoded = Schema.decodeUnknownResult(model_row(model, 'record'))(record);
		return Result.isSuccess(decoded) ? decoded.success : null;
	};

	function model_read<C extends ModelKey, M extends 'list' | 'record'>(
		model: C, request: Readonly<Record<string, Json>>, mode: M
	) {
		const original = request[model], defaults = read_catalog[model]?.['default']?.[model];
		const required = defaults === undefined ? undefined
			: mode === 'record' ? Object.keys(defaults.fields) : defaults.list_fields;
		const prepared = required === undefined || !isObject(original) ? request : {
			...request,
			[model]: {
				...original,
				output: original['output'] ?? 'default',
				...(isList(original['fields']) ? {
					fields: [...new Set<Json>([...original['fields'], ...required])]
				} : {})
			}
		};
		const schema = Schema.suspend(() => {
			if (defaults === undefined || required === undefined)
				return refused(`The default read output of '${model}' is not granted for this model view.`);
			if (Object.keys(prepared).length !== 1 || !isObject(original))
				return refused('A model view must read exactly its own model root.');
			const output = original['output'] ?? 'default';
			if (typeof output !== 'string') return refused('The model view output is not named.');
			const selected = read_catalog[model]?.[output]?.[model];
			const picked = Arr.isArray(original['fields']) ? original['fields'].filter((field): field is string => typeof field === 'string') : [];
			for (const field of new Set([...required, ...picked.filter((field) => defaults.fields[field] !== undefined)])) {
				const expected = defaults.fields[field], actual = selected?.fields[field];
				if (expected === undefined || actual === undefined || !sameKind(expected, actual))
					return refused(`'${model}.${output}' cannot supply the model view field '${field}'.`);
			}
			const pages = read_answer(read_catalog, prepared).pipe(Schema.decodeTo(Pages));
			const normalized = pages.pipe(Schema.decodeTo(Pages, {
				decode: SchemaGetter.transform((answer) => Object.fromEntries(Object.entries(answer).map(([root, page]) => [
					root, { ...page, rows: unref(catalog, root, Object.keys(catalog[root]?.relations ?? {}), page.rows) }
				]))),
				encode: SchemaGetter.forbiddenEncoding
			}));
			return normalized.pipe(Schema.decodeTo(Schema.Struct({ [model]: Page(model_row(model, mode)) })));
		});
		return { prepared, schema };
	}
	function model_query<C extends ModelKey>(model: C, request: Readonly<Record<string, Json>>, mode: 'list'): Query<ModelPages<C, 'list'>>;
	function model_query<C extends ModelKey>(model: C, request: Readonly<Record<string, Json>>, mode: 'record'): Query<ModelPages<C, 'record'>>;
	function model_query<C extends ModelKey, M extends 'list' | 'record'>(model: C, request: Readonly<Record<string, Json>>, mode: M) {
		const { prepared, schema } = model_read(model, request, mode);
		return client.native_query({ m: 'query', a: [prepared] }, schema);
	}
	function source_query<S extends ViewSource>(source: S, request: Readonly<Record<string, Json>>): Query<SourcePages<S>> {
		if (typeof source !== 'string') return refused('A model-source read requires a model source.');
		const { prepared, schema } = model_read(source, request, 'list');
		const valid = Schema.is(Schema.toType(schema));
		return client.native_query({ m: 'query', a: [prepared] }, schema.pipe(
			Schema.decodeTo(Schema.declare((value: unknown): value is SourcePages<S> => valid(value)))
		));
	}

	function aggregate(model: string, args: Record<string, Value> & { readonly by: Value }): Query<typeof Buckets.Type>;
	function aggregate(model: string, args: Value): Query<typeof Values.Type | typeof Buckets.Type>;
	function aggregate(model: string, args: Value) {
		const wire = encode_wire(args);
		const grouped = isObject(wire) && Object.hasOwn(wire, 'by');
		return grouped
			? client.native_query({ m: 'aggregate', a: [model, wire] }, Schema.suspend(() =>
				aggregate_answer(read_catalog, model, args).pipe(Schema.decodeTo(Buckets))))
			: client.native_query({ m: 'aggregate', a: [model, wire] }, Schema.suspend(() =>
				aggregate_answer(read_catalog, model, args).pipe(Schema.decodeTo(Values))));
	}
	function history<C extends ModelKey>(model: C, id: string, options: { at?: Json; output?: string; view: true }): Query<(typeof HistorySnapshotSchema.Type & { readonly projection: ModelRow<C, 'record'> | null }) | null>;
	function history(model: string, id: string, options?: { at?: Json; output?: string }): Query<readonly typeof HistoryRevisionSchema.Type[]>;
	function history<C extends ModelKey>(model: C, id: string, options: { at?: Json; output?: string; view?: true } = {}) {
		const snapshot = Schema.NullOr(HistorySnapshotSchema);
		const projected = Schema.suspend(() => {
			const row = read_catalog[model]?.['default']?.[model] === undefined ? undefined : model_row(model, 'record');
			// stored values are wire JSON; the projected field then holds the decoded row
			const record = row === undefined ? undefined : model_wire(model, 'record').pipe(Schema.decodeTo(row));
			return snapshot.pipe(Schema.decodeTo(Schema.NullOr(Schema.Struct({
				...HistorySnapshotSchema.fields, projection: row === undefined ? Schema.Null : Schema.NullOr(row)
			})), { decode: SchemaGetter.transform((value) => {
				if (value === null) return null;
				if (record === undefined) return { ...value, projection: null };
				const decoded = Schema.decodeUnknownResult(record)(value.compatible);
				return { ...value, projection: Result.isSuccess(decoded) ? decoded.success : null };
			}), encode: SchemaGetter.forbiddenEncoding }));
		});
		return options.view === true
			? client.native_query({ m: 'history', a: [model, id, options] }, projected)
			: client.native_query({ m: 'history', a: [model, id, options] }, Schema.Array(HistoryRevisionSchema));
	}
	return {
		refresh: client.refresh,
		query, model_query, source_query, project_record, aggregate, history,
		clock: client.clock,
		act: client.act,
		run: client.run,
		sync_control: client.sync_control,
		file_url: client.file_url,
		approvals: client.approvals,
		actor: client.actor,
		locale: client.locale,
		t: client.t,
		...(client.record_capabilities === undefined ? {} : { record_capabilities: client.record_capabilities }),
		...(client.restore === undefined ? {} : { restore: client.restore }),
		...(client.runs === undefined ? {} : { runs: client.runs }),
		...(client.decode === undefined ? {} : { decode: client.decode }),
		...(client.describe === undefined ? {} : { describe: client.describe }),
		...(client.options === undefined ? {} : { options: client.options })
	};
}
