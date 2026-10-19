import { Schema } from 'effect';

/** Shared by the authored public page, its loader and the sweep's hydration decoder. */
export default Schema.Struct({
	titles: Schema.Array(Schema.String),
	caller: Schema.String,
	path: Schema.String
});
