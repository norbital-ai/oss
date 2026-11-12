import { Schema } from 'effect';

/** The readable page and its control refs, with host-provided page metadata retained. */
export const BrowserSnapshotSchema = Schema.StructWithRest(
	Schema.Struct({ url: Schema.String, title: Schema.NullOr(Schema.String), text: Schema.String }),
	[Schema.Record(Schema.String, Schema.Json)]
);
export type BrowserSnapshot = typeof BrowserSnapshotSchema.Type;

/** One action on a ref from the current snapshot. */
export const BrowserStepSchema = Schema.Union([
	Schema.Struct({ click: Schema.String }),
	Schema.Struct({ type: Schema.Struct({ ref: Schema.String, text: Schema.String, submit: Schema.optionalKey(Schema.Boolean) }) }),
	Schema.Struct({ select: Schema.Struct({ ref: Schema.String, value: Schema.String }) }),
	Schema.Struct({ press: Schema.String }),
	Schema.Struct({ hover: Schema.String }),
	Schema.Struct({ scroll: Schema.Struct({ ref: Schema.optionalKey(Schema.String), y: Schema.optionalKey(Schema.Finite) }) }),
	Schema.Struct({ wait: Schema.Struct({ text: Schema.optionalKey(Schema.String), ms: Schema.optionalKey(Schema.Finite) }) })
]);
export type BrowserStep = typeof BrowserStepSchema.Type;
