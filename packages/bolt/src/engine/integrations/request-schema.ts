// The authored output kind shared by integration requests and AI inference, independent of their runtimes.
import { Schema } from 'effect';
import type { Kind } from '@norbital-ai/std/kind';

const KindCommon = {
	optional: Schema.optionalKey(Schema.Literal(true)),
	default: Schema.optionalKey(Schema.Json),
	unique: Schema.optionalKey(Schema.Literal(true)),
	label: Schema.optionalKey(Schema.String),
	help: Schema.optionalKey(Schema.String),
	hidden: Schema.optionalKey(Schema.Literal(true))
};
const Range = { min: Schema.optionalKey(Schema.Number), max: Schema.optionalKey(Schema.Number) };
const DatePrecision = Schema.Literals(['year', 'month', 'week', 'day']);
const TimePrecision = Schema.Literals(['hour', 'minute']);
const Precision = Schema.Literals(['year', 'month', 'week', 'day', 'hour', 'minute']);
/** The authored output declaration crosses as JSON; only a decoded kind reaches std/kind's value codec. */
export const RequestOutput: Schema.Codec<Kind> = Schema.suspend(() =>
	Schema.Union([
		Schema.Struct({
			...KindCommon,
			kind: Schema.Literal('text'),
			format: Schema.optionalKey(
				Schema.Literals(['email', 'phone', 'url', 'zone', 'markdown', 'cel', 'team'])
			),
			max: Schema.optionalKey(Schema.Number),
			many: Schema.optionalKey(Schema.Literal(true))
		}),
		Schema.Struct({ ...KindCommon, ...Range, kind: Schema.Literal('int') }),
		Schema.Struct({ ...KindCommon, ...Range, kind: Schema.Literal('number') }),
		Schema.Struct({
			...KindCommon,
			...Range,
			kind: Schema.Literal('decimal'),
			scale: Schema.Number,
			precision: Schema.optionalKey(Schema.Number)
		}),
		Schema.Struct({
			...KindCommon,
			kind: Schema.Literal('money'),
			currency: Schema.optionalKey(Schema.String),
			scale: Schema.optionalKey(Schema.Number)
		}),
		...(['currency', 'bool', 'duration', 'point'] as const).map((kind) =>
			Schema.Struct({ ...KindCommon, kind: Schema.Literal(kind) })
		),
		Schema.Struct({
			...KindCommon,
			kind: Schema.Literal('date'),
			precision: Schema.optionalKey(DatePrecision)
		}),
		Schema.Struct({
			...KindCommon,
			kind: Schema.Literal('instant'),
			precision: Schema.optionalKey(Precision)
		}),
		Schema.Struct({
			...KindCommon,
			kind: Schema.Literal('time'),
			precision: Schema.optionalKey(TimePrecision)
		}),
		Schema.Struct({
			...KindCommon,
			kind: Schema.Literal('period'),
			of: Schema.Literal('date'),
			precision: Schema.optionalKey(DatePrecision)
		}),
		Schema.Struct({
			...KindCommon,
			kind: Schema.Literal('period'),
			of: Schema.Literal('instant'),
			precision: Schema.optionalKey(Precision)
		}),
		Schema.Struct({
			...KindCommon,
			kind: Schema.Literal('enum'),
			values: Schema.Array(Schema.String),
			many: Schema.optionalKey(Schema.Literal(true))
		}),
		Schema.Struct({
			...KindCommon,
			kind: Schema.Literal('state'),
			initial: Schema.String,
			states: Schema.Record(
				Schema.String,
				Schema.Struct({
					to: Schema.optionalKey(Schema.Array(Schema.String)),
					edit: Schema.optionalKey(
						Schema.Union([Schema.Literals(['all', 'none']), Schema.Array(Schema.String)])
					)
				})
			)
		}),
		Schema.Struct({
			...KindCommon,
			kind: Schema.Literal('seq'),
			pattern: Schema.optionalKey(Schema.String),
			per: Schema.optionalKey(Schema.Array(Schema.String))
		}),
		Schema.Struct({
			...KindCommon,
			kind: Schema.Literal('sum'),
			of: Schema.String,
			where: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
			money: Schema.optionalKey(Schema.Struct({ currency: Schema.optionalKey(Schema.String) }))
		}),
		Schema.Struct({
			...KindCommon,
			kind: Schema.Literal('count'),
			of: Schema.String,
			where: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json))
		}),
		Schema.Struct({
			...KindCommon,
			kind: Schema.Literal('json'),
			shape: Schema.optionalKey(RequestOutput)
		}),
		Schema.Struct({
			...KindCommon,
			kind: Schema.Literal('file'),
			accept: Schema.Array(Schema.String),
			max: Schema.String,
			multiple: Schema.optionalKey(Schema.Literal(true))
		}),
		Schema.Struct({
			...KindCommon,
			kind: Schema.Literal('vector'),
			dim: Schema.Number,
			metric: Schema.Literals(['l2', 'cosine', 'ip'])
		}),
		Schema.Struct({
			...KindCommon,
			kind: Schema.Literal('custom'),
			of: Schema.String,
			many: Schema.optionalKey(Schema.Literal(true))
		}),
		Schema.Struct({
			...KindCommon,
			kind: Schema.Literal('id'),
			of: Schema.String,
			where: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json))
		}),
		Schema.Struct({
			...KindCommon,
			...Range,
			kind: Schema.Literal('list'),
			of: RequestOutput,
			key: Schema.optionalKey(Schema.String)
		}),
		Schema.Struct({
			...KindCommon,
			kind: Schema.Literal('object'),
			fields: Schema.Record(Schema.String, RequestOutput),
			rest: Schema.optionalKey(RequestOutput)
		}),
		Schema.Struct({
			...KindCommon,
			kind: Schema.Literal('union'),
			of: Schema.Array(RequestOutput)
		}),
		Schema.Struct({
			...KindCommon,
			kind: Schema.Literal('union'),
			by: Schema.String,
			arms: Schema.Record(Schema.String, Schema.Record(Schema.String, RequestOutput))
		}),
		Schema.Struct({ ...KindCommon, kind: Schema.Literal('record'), of: RequestOutput })
	])
);
