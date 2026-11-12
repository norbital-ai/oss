// The one read request (P3, decisions 1, 4, 7, 8): a page's `bolt.query`, an automation's or policy's `ctx.query` and the
// agent's `read` tool send the same JSON tree: one model root, reading one named output (`default` when absent),
// then one key per nested relation. Native resolved paths stay within `LAYER_MAX_DEPTH` segments. `decode_read_request` refuses anything but that JSON (an unknown option, a sixth level,
// `output`/`as_of`/`after` below a root, a function); `plan_read_request` checks the paths against the declarations and
// groups them by root, implied parents filled in.
import { Predicate, Result, Schema } from 'effect';
import type { Json } from '../decl/values.ts';
import { LAYER_MAX_DEPTH, type ExposureSpec } from '../decl/model.ts';

/** Every list's default and largest `limit`: a root page and each nested many-layer per parent row (decision 7). */
export const READ_LIMIT = 10_000;
const Fields = Schema.Array(Schema.String);
const Aggregate = Schema.Struct({
	count: Schema.optionalKey(Schema.Literal(true)),
	sum: Schema.optionalKey(Fields),
	avg: Schema.optionalKey(Fields),
	min: Schema.optionalKey(Fields),
	max: Schema.optionalKey(Fields),
	/** A field, a list of fields, or a calendar bucket (`{ month: 'issued_on' }`) on a root. */
	by: Schema.optionalKey(Schema.Json)
});
/** One layer's value; `output`, `as_of` and `after` belong to a root only. `{}` reads every exposed field with the defaults. */
export const LayerRequestSchema = Schema.Struct({
	/** The root's named read output (`default` when absent): its fixed fields and layers. */
	output: Schema.optionalKey(Schema.String),
	where: Schema.optionalKey(Schema.JsonObject),
	fields: Schema.optionalKey(Fields),
	order_by: Schema.optionalKey(Schema.Json),
	limit: Schema.optionalKey(
		Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: READ_LIMIT }))
	),
	after: Schema.optionalKey(Schema.String),
	/** Text over `search.text`; on a root also `{ <index>: input }` or `{ semantic }`. */
	search: Schema.optionalKey(Schema.Union([Schema.String, Schema.JsonObject])),
	aggregate: Schema.optionalKey(Aggregate),
	/** An ISO instant: the root and its layers as they stood then. */
	as_of: Schema.optionalKey(Schema.String)
});
export type LayerRequestJson = typeof LayerRequestSchema.Type;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const OPTIONS = new Set(Object.keys(LayerRequestSchema.fields));
const decodeLayer = Schema.decodeUnknownResult(LayerRequestSchema, { onExcessProperty: 'error' });
/** Resolved paths are native IR only; a request crosses every author boundary as nested nodes. */
export type ReadLayersJson = Readonly<Record<string, LayerRequestJson>>;
function layersOf(request: Readonly<Record<string, Json>>): Result.Result<ReadLayersJson, string> {
	const layers = new Map<string, LayerRequestJson>();
	const visit = (path: string, node: Json, depth: number): string | undefined => {
		if (depth > LAYER_MAX_DEPTH || !Predicate.isObject(node) || Array.isArray(node))
			return `${path}: expected a read node at most ${LAYER_MAX_DEPTH} levels deep`;
		const entries = Object.entries<Json>(node);
		const decoded = decodeLayer(Object.fromEntries(entries.filter(([key]) => OPTIONS.has(key))));
		if (Result.isFailure(decoded)) return `${path}: ${decoded.failure.message}`;
		const layer = decoded.success;
		if (depth > 1 && (layer.output !== undefined || layer.as_of !== undefined || layer.after !== undefined))
			return `${path}: output, as_of and after belong to a root`;
		layers.set(path, layer);
		for (const [relation, child] of entries) {
			if (OPTIONS.has(relation)) continue;
			if (!NAME.test(relation)) return `${path}.${relation}: use a nested relation name`;
			const error = visit(`${path}.${relation}`, child, depth + 1);
			if (error !== undefined) return error;
		}
		return undefined;
	};
	if (Object.keys(request).length === 0) return Result.fail('a read request names at least one root');
	for (const [root, node] of Object.entries(request)) {
		if (!NAME.test(root)) return Result.fail(`${root}: expected a model name and nested relations`);
		const error = visit(root, node, 1);
		if (error !== undefined) return Result.fail(error);
	}
	return Result.succeed(Object.fromEntries(layers));
}
export const ReadRequestSchema = Schema.JsonObject.check(Schema.makeFilter((request) => {
	const decoded = layersOf(request);
	return Result.isFailure(decoded) ? decoded.failure : undefined;
}));
export type ReadRequestJson = typeof ReadRequestSchema.Type;
const decode = Schema.decodeUnknownResult(ReadRequestSchema);
/** Decode the single public tree shape, then lower to native paths. */
export const decode_read_request = (u: unknown): Result.Result<ReadLayersJson, string> =>
	Result.flatMap(Result.mapError(decode(u), (error) => error.message), layersOf);

const DynamicReadSchema = ReadRequestSchema.pipe(Schema.brand('DynamicRead'));
/** A read request built at runtime (a rule engine's reads): only `dynamic_read` makes one, so a literal never falls to it. */
export type DynamicRead = typeof DynamicReadSchema.Type;
/**
 * A runtime-built read request for `ctx.query`: decoded here exactly as the wire is (throws on a request
 * that is not one), checked against the declarations by the host like any other, answered untyped (`DynamicAnswer`).
 */
export const dynamic_read: (request: ReadRequestJson) => DynamicRead = Schema.decodeUnknownSync(
	DynamicReadSchema,
	{ onExcessProperty: 'error' }
);
/** A decoded request grouped by root: each root's layers by path, every implied parent present (`{}`). */
export type ReadPlan = {
	readonly [root: string]: { readonly [path: string]: LayerRequestJson };
};
/**
 * The request checked against the declarations (`exposures`, the built-in layer's included): each root is a model with
 * `read` other than a ledger reading an output it declares, each path one that output declares. Naming
 * `'orders.lines.product'` implies `'orders'` and `'orders.lines'`. Authority, defaults and lowering are the host's
 * (`ReadEngine`).
 */
export function plan_read_request(
	request: ReadLayersJson,
	exposures: { readonly [model: string]: ExposureSpec }
): Result.Result<ReadPlan, string> {
	const plan: { [root: string]: { [path: string]: LayerRequestJson } } = {};
	for (const [path, layer] of Object.entries(request)) {
		if (layer.search !== undefined && layer.aggregate !== undefined)
			return Result.fail(
				`'${path}': search cannot be combined with aggregate; a read's total already counts its matches`
			);
		if (layer.fields !== undefined && layer.aggregate !== undefined)
			return Result.fail(
				`'${path}': aggregate answers measures, not rows, so it takes no fields; a read's total already counts its matches`
			);
		const segments = path.split('.');
		const [root] = segments;
		if (root === undefined) return Result.fail(`'${path}' is no read root: a root is a model with read`);
		const spec = Object.hasOwn(exposures, root) ? exposures[root] : undefined;
		if (spec === undefined || root === 'sys_run')
			return Result.fail(`'${root}' is no read root: a root is a model with read`);
		const output = request[root]?.output ?? 'default';
		const read = Object.hasOwn(spec.outputs, output) ? spec.outputs[output] : undefined;
		if (read === undefined)
			return Result.fail(
				`'${root}' declares no read output '${output}'; it declares: ${Object.keys(spec.outputs).join(', ')}`
			);
		if (!Object.hasOwn(read, path))
			return Result.fail(
				`'${path}' is not a read layer ${root}${output === 'default' ? '' : `'s ${output} output`} declares`
			);
		const layers = (plan[root] ??= {});
		for (let i = 1; i < segments.length; i++) layers[segments.slice(0, i).join('.')] ??= {};
		layers[path] = layer;
	}
	return Result.succeed(plan);
}
