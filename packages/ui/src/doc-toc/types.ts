import { Schema } from 'effect';

const DocTocItemSchema = Schema.Struct({
	title: Schema.String,
	url: Schema.String,
	depth: Schema.Number
});
export type DocTocItem = typeof DocTocItemSchema.Type;

const DocTocItemInfoSchema = Schema.Struct({
	id: Schema.String,
	active: Schema.Boolean,
	t: Schema.Number,
	fallback: Schema.Boolean,
	original: DocTocItemSchema
});
export type DocTocItemInfo = typeof DocTocItemInfoSchema.Type;

const DocTocTrackBoundsSchema = Schema.Struct({
	top: Schema.Number,
	bottom: Schema.Number
});
export type DocTocTrackBounds = typeof DocTocTrackBoundsSchema.Type;
