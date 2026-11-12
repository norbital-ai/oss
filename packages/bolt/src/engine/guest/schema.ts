import { Schema } from 'effect';

/** Values produced by the tenant-controlled prelude, decoded before the host or engine consumes them. */
export const GuestFinalSchema = Schema.Union([
	Schema.Tuple([Schema.Literal('ok'), Schema.String]),
	Schema.Tuple([Schema.Literal('refused'), Schema.String, Schema.NullOr(Schema.String), Schema.NullOr(Schema.Int), Schema.String]),
	Schema.Tuple([Schema.Literal('missing'), Schema.String]),
	Schema.Tuple([Schema.Literal('error'), Schema.String, Schema.String, Schema.String]),
	Schema.Tuple([Schema.Literal('error'), Schema.String, Schema.String, Schema.String, Schema.String])
]);
/** The prelude's `take()`: end state, the calls crossing now, each call's bytes (`$bin`), and whether a timer ran instead. */
export const GuestTaken = Schema.Tuple([
	Schema.NullOr(GuestFinalSchema),
	Schema.Array(Schema.Tuple([Schema.String, Schema.String, Schema.String, Schema.Number])),
	Schema.Array(Schema.Array(Schema.Uint8Array)),
	Schema.Boolean
]);
export type GuestTaken = typeof GuestTaken.Type;
export const GuestTurnSchema = Schema.Struct({
	taken: GuestTaken,
	lines: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
	dropped: Schema.Number
});
