import { Schema } from 'effect';

/** Values produced by the tenant-controlled prelude, decoded before the host or engine consumes them. */
export const GuestFinalSchema = Schema.Union([
	Schema.Tuple([Schema.Literal('ok'), Schema.String]),
	Schema.Tuple([Schema.Literal('refused'), Schema.String, Schema.NullOr(Schema.String), Schema.NullOr(Schema.Int), Schema.String]),
	Schema.Tuple([Schema.Literal('missing'), Schema.String]),
	Schema.Tuple([Schema.Literal('error'), Schema.String, Schema.String, Schema.String]),
	Schema.Tuple([Schema.Literal('error'), Schema.String, Schema.String, Schema.String, Schema.String])
]);
export const GuestTakenSchema = Schema.Tuple([
	Schema.NullOr(GuestFinalSchema),
	Schema.Array(Schema.Tuple([Schema.String, Schema.String, Schema.String, Schema.Number])),
	Schema.Array(Schema.Array(Schema.Uint8Array)),
	Schema.Boolean
]);
export const GuestTurnSchema = Schema.Struct({
	taken: GuestTakenSchema,
	lines: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
	dropped: Schema.Number
});
