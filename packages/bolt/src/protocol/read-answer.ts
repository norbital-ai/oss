import { Result, Schema } from 'effect';
import { input_schema, KindSchema, type Value } from '@norbital-ai/store/kind';
import type { Json } from '@norbital-ai/store';
import type { ReadAnswer, ReadRequestBase } from '../decl/ctx.ts';
import { ReadFailed } from '../decl/errors.ts';
import { decode_read_request, type LayerRequestJson } from './read-request.ts';
import { RowLabelField, RowStateFields } from './record-contracts.ts';
import { kind_value } from './output-contract.ts';

/** Exact field descriptors of each granted output; a layer uses its root's grant, never its target's root grant. */
const ReadOutputs = Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Struct({
	model: Schema.String,
	many: Schema.Boolean,
	list_fields: Schema.Array(Schema.String),
	fields: Schema.Record(Schema.String, KindSchema)
})));
type ReadOutputs = typeof ReadOutputs.Type;
export const ReadCatalog = Schema.Record(Schema.String, ReadOutputs);
export type ReadCatalog = typeof ReadCatalog.Type;
type Codec = Schema.Codec<Value, Json>;
type Field = Codec | Schema.optionalKey<Codec>;
type Level = ReadOutputs[string][string];

function failed(message: string): never {
	throw new ReadFailed({ code: 'protocol', message });
}
const count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const decimal = input_schema({ kind: 'decimal', scale: 0 });
const date = input_schema({ kind: 'date' });
const PlainObject = Schema.declare((value: unknown): value is Readonly<Record<string, unknown>> => {
	if (value === null || typeof value !== 'object') return false;
	const prototype: unknown = Object.getPrototypeOf(value);
	return (prototype === null || prototype === Object.prototype) && Reflect.ownKeys(value).every((key) =>
		typeof key === 'string' && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true &&
		Object.getOwnPropertyDescriptor(value, key)?.get === undefined
	);
});
const PlainArray = Schema.declare((value: unknown): value is readonly unknown[] => {
	if (!Array.isArray(value)) return false;
	const length: unknown = Object.getOwnPropertyDescriptor(value, 'length')?.value;
	if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) return false;
	const keys = Reflect.ownKeys(value);
	return keys.length === length + 1 && keys.every((key) => {
		if (key === 'length') return true;
		if (typeof key !== 'string') return false;
		const index = Number(key), descriptor = Object.getOwnPropertyDescriptor(value, key);
		return Number.isInteger(index) && index >= 0 && index < length && String(index) === key &&
			descriptor?.enumerable === true && descriptor.get === undefined;
	});
});
const WireInput: Schema.Decoder<Json> = Schema.suspend(() => Schema.Union([
	Schema.Null, Schema.Boolean, Schema.Finite, Schema.String,
	PlainArray.pipe(Schema.decodeTo(Schema.Array(WireInput))), PlainObject.pipe(Schema.decodeTo(Schema.Record(Schema.String, WireInput)))
]));
/** Validate rich authored inputs before encoding, so invalid functions and non-JSON values cannot silently disappear. */
export function read_wire(value: unknown): Json {
	const decoded = Schema.decodeUnknownResult(WireInput)(value);
	return Result.isSuccess(decoded)
		? decoded.success
		: failed('A read takes plain JSON values.');
}
const own = <A>(record: Readonly<Record<string, A>>, key: string): A | undefined =>
	Object.hasOwn(record, key) ? record[key] : undefined;
const output_of = (catalog: ReadCatalog, model: string, output: string): ReadOutputs[string] => {
	const outputs = own(catalog, model);
	return outputs === undefined ? failed(`No read schema is available for '${model}'.`)
		: own(outputs, output) ?? failed(`No granted read schema is available for '${model}.${output}'.`);
};
const field_of = (level: Level, name: string): Codec => {
	const kind = own(level.fields, name);
	return kind === undefined ? failed(`'${level.model}.${name}' is not a field of this read output.`) : kind_value(kind);
};
const page = (row: Codec, total = false): Codec => total
	? Schema.Struct({ rows: Schema.Array(row), next: Schema.NullOr(Schema.String), total: count })
	: Schema.Struct({ rows: Schema.Array(row), next: Schema.NullOr(Schema.String) });

/** Aggregate keys and measures are validated by the same selected layer's field kinds as ordinary rows. */
function aggregate(level: Level, options: NonNullable<LayerRequestJson['aggregate']>, root: boolean): Codec {
	const fields = new Map<string, Field>();
	const by: readonly Json[] = options.by === undefined ? [] : Array.isArray(options.by) ? options.by : [options.by];
	if (options.by !== undefined && by.length === 0) failed('An aggregate names at least one bucket.');
	if (options.count === true || by.length > 0) fields.set('count', count);
	if (by.length > 0) {
		const keys = new Map<string, Codec>();
		for (const bucket of by) {
			if (typeof bucket === 'string') keys.set(bucket, field_of(level, bucket));
			else {
				const entries: readonly [string, Json][] = bucket !== null && typeof bucket === 'object' && !Array.isArray(bucket) ? Object.entries<Json>(bucket) : [];
				const [entry] = entries;
				if (entries.length !== 1 || entry === undefined || typeof entry[1] !== 'string')
					failed('An aggregate bucket does not name one field.');
				const [unit, field] = entry;
				if (!['day', 'week', 'month', 'quarter', 'year'].includes(unit)) failed(`Unknown aggregate bucket '${unit}'.`);
				const kind = own(level.fields, field);
				if (kind === undefined || (kind.kind !== 'date' && kind.kind !== 'instant') || kind.many === true)
					failed(`'${level.model}.${field}' is not a calendar aggregate field.`);
				keys.set(field, kind.optional === true ? Schema.NullOr(date) : date);
			}
		}
		fields.set('key', Schema.Struct(Object.fromEntries(keys)));
	}
	for (const measure of ['sum', 'avg', 'min', 'max'] as const) {
		const picked = options[measure];
		if (picked === undefined) continue;
		const values = new Map<string, Codec>();
		for (const field of picked) {
			const kind = own(level.fields, field);
			if (kind === undefined) failed(`'${level.model}.${field}' is not a field of this read output.`);
			if ((measure === 'sum' || measure === 'avg') &&
				(!['int', 'number', 'decimal', 'money', 'sum', 'count'].includes(kind.kind) || kind.many === true))
				failed(`'${level.model}.${field}' is not a numeric aggregate field.`);
			values.set(field, Schema.NullOr(measure === 'sum' || measure === 'avg' ? decimal : field_of(level, field)));
		}
		fields.set(measure, Schema.Struct(Object.fromEntries(values)));
	}
	const row: Codec = Schema.Struct(Object.fromEntries(fields));
	return by.length === 0 ? row : root ? page(row) : Schema.Array(row);
}

/** A dynamic request's runtime decoder. Its output is structural values; callers cannot select an unrelated type. */
export function read_answer(catalog: ReadCatalog, request: unknown): Codec {
	const decoded = decode_read_request(read_wire(request));
	if (Result.isFailure(decoded)) return failed(decoded.failure);
	const layers = decoded.success;
	const answers = new Map<string, Codec>();
	for (const [root, top] of Object.entries(layers)) {
		if (root.includes('.')) continue;
		const output = output_of(catalog, root, top.output ?? 'default');
		const layer = (path: string): Level => own(output, path) ?? failed(`'${path}' is not a layer of this read output.`);
		const row = (path: string, distance = false): Codec => {
			const level = layer(path), node = own(layers, path);
			if (node === undefined) return failed(`'${path}' has no read node.`);
			const children = Object.keys(layers).filter((child) => child.slice(0, child.lastIndexOf('.')) === path);
			const fields = new Map<string, Field>();
			for (const field of new Set(['id', ...(node.fields ?? Object.keys(level.fields))])) {
				if (children.includes(`${path}.${field}`)) continue;
				fields.set(field, field_of(level, field));
			}
			for (const child of children) {
				const target = layer(child), child_node = own(layers, child);
				if (child_node === undefined) return failed(`'${child}' has no read node.`);
				const name = child.slice(path.length + 1);
				if (!target.many && child_node.aggregate !== undefined) return failed(`'${child}' is a ref, not an aggregate layer.`);
				fields.set(name, child_node.aggregate !== undefined
					? aggregate(target, child_node.aggregate, false)
					: target.many ? Schema.Array(row(child)) : Schema.NullOr(row(child)));
			}
			for (const [name, field] of Object.entries(path === root ? RowStateFields : RowLabelField)) fields.set(name, field);
			if (distance) fields.set('$distance', Schema.Finite);
			return Schema.Struct(Object.fromEntries(fields));
		};
		if (top.aggregate !== undefined) {
			if (Object.keys(layers).some((path) => path.startsWith(`${root}.`))) failed('An aggregate root cannot select relationship layers.');
			answers.set(root, aggregate(layer(root), top.aggregate, true));
		} else {
			const search = top.search !== null && typeof top.search === 'object';
			answers.set(root, page(row(root, search), !search));
		}
	}
	return Schema.Struct(Object.fromEntries(answers));
}

/** The refinement is tied to this exact request and its granted output schemas, after rich field decoding. */
export function typed_read_answer<const R extends ReadRequestBase>(catalog: ReadCatalog, request: R) {
	const answer = read_answer(catalog, request);
	const valid = Schema.is(Schema.toType(answer));
	return answer.pipe(Schema.decodeTo(Schema.declare((value: unknown): value is ReadAnswer<R> => valid(value))));
}

const AggregateArguments = Schema.Struct({
	output: Schema.optionalKey(Schema.String),
	count: Schema.optionalKey(Schema.Literal(true)),
	sum: Schema.optionalKey(Schema.Array(Schema.String)), avg: Schema.optionalKey(Schema.Array(Schema.String)),
	min: Schema.optionalKey(Schema.Array(Schema.String)), max: Schema.optionalKey(Schema.Array(Schema.String)),
	by: Schema.optionalKey(Schema.Json)
});
export const aggregate_answer = (catalog: ReadCatalog, model: string, args: unknown): Codec => {
	const decoded = Schema.decodeUnknownResult(AggregateArguments)(read_wire(args));
	if (Result.isFailure(decoded)) return failed(decoded.failure.message);
	const options = decoded.success;
	const output = output_of(catalog, model, options.output ?? 'default');
	const level = own(output, model) ?? failed(`'${model}' has no root read schema.`);
	const { output: _output, ...measures } = options;
	return aggregate(level, measures, true);
};
