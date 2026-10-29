// The one read request (P3, decisions 1, 4, 7, 8): a page's `bolt.query`, an automation's or policy's `ctx.query` and the
// agent's `read` tool send the same JSON layer map. Keys without a dot are roots (models with `read`), each reading one
// named output (`output`, `default` when absent); `'<root>.<rel>…'` is one of that output's declared read layers, at most
// `LAYER_MAX_DEPTH` segments. `decodeReadRequest` refuses anything but that JSON (an unknown option, a sixth level,
// `output`/`asOf`/`after` below a root, a function); `planReadRequest` checks the paths against the declarations and
// groups them by root, implied parents filled in.
import { Result, Schema } from 'effect';
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
/** One layer's value; `output`, `asOf` and `after` belong to a root only. `{}` reads every exposed field with the defaults. */
export const LayerRequestSchema = Schema.Struct({
	/** The root's named read output (`default` when absent): its fixed fields and layers. */
	output: Schema.optionalKey(Schema.String),
	where: Schema.optionalKey(Schema.JsonObject),
	fields: Schema.optionalKey(Fields),
	orderBy: Schema.optionalKey(Schema.Json),
	limit: Schema.optionalKey(
		Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: READ_LIMIT }))
	),
	after: Schema.optionalKey(Schema.String),
	/** Text over `search.text`; on a root also `{ <index>: input }` or `{ semantic }`. */
	search: Schema.optionalKey(Schema.Union([Schema.String, Schema.JsonObject])),
	aggregate: Schema.optionalKey(Aggregate),
	/** An ISO instant: the root and its layers as they stood then. */
	asOf: Schema.optionalKey(Schema.String)
});
export type LayerRequestJson = typeof LayerRequestSchema.Type;
const PATH = new RegExp(
	`^[A-Za-z_][A-Za-z0-9_]*(\\.[A-Za-z_][A-Za-z0-9_]*){0,${LAYER_MAX_DEPTH - 1}}$`
);
const shape = (request: { readonly [path: string]: LayerRequestJson }): string | undefined => {
	const paths = Object.keys(request);
	if (paths.length === 0) return 'a read request names at least one root';
	for (const path of paths) {
		if (!PATH.test(path))
			return `'${path}' is no layer path: a model, then up to ${LAYER_MAX_DEPTH - 1} relations, dot-separated`;
		const layer = request[path]!;
		if (
			path.includes('.') &&
			(layer.output !== undefined || layer.asOf !== undefined || layer.after !== undefined)
		)
			return `'${path}': output, asOf and after belong to a root`;
	}
	return undefined;
};
export const ReadRequestSchema = Schema.Record(Schema.String, LayerRequestSchema).check(
	Schema.makeFilter(shape)
);
export type ReadRequestJson = typeof ReadRequestSchema.Type;
const decode = Schema.decodeUnknownResult(ReadRequestSchema, { onExcessProperty: 'error' });
/** The one decoder of a read request off any wire: JSON only, exact keys, at most `LAYER_MAX_DEPTH` levels. */
export const decodeReadRequest = (u: unknown): Result.Result<ReadRequestJson, string> =>
	Result.mapError(decode(u), (e) => e.message);

const DynamicReadSchema = ReadRequestSchema.pipe(Schema.brand('DynamicRead'));
/** A read request built at runtime (a rule engine's reads): only `dynamicRead` makes one, so a literal never falls to it. */
export type DynamicRead = typeof DynamicReadSchema.Type;
/**
 * A runtime-built read request for `ctx.query`/`ctx.db.query`: decoded here exactly as the wire is (throws on a request
 * that is not one), checked against the declarations by the host like any other, answered untyped (`DynamicAnswer`).
 */
export const dynamicRead: (request: ReadRequestJson) => DynamicRead = Schema.decodeUnknownSync(
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
export function planReadRequest(
	request: ReadRequestJson,
	exposures: { readonly [model: string]: ExposureSpec }
): Result.Result<ReadPlan, string> {
	const plan: { [root: string]: { [path: string]: LayerRequestJson } } = {};
	for (const [path, layer] of Object.entries(request)) {
		const segments = path.split('.'),
			root = segments[0]!;
		const spec = exposures[root];
		if (spec === undefined || root === 'sys_run')
			return Result.fail(`'${root}' is no read root: a root is a model with read`);
		const output = request[root]?.output ?? 'default';
		const read = output === 'default' ? spec.read : spec.outputs?.[output];
		if (read === undefined)
			return Result.fail(
				`'${root}' declares no read output '${output}'; it declares: ${['default', ...Object.keys(spec.outputs ?? {})].join(', ')}`
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
