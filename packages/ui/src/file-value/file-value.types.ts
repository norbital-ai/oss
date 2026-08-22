import { Schema } from 'effect';

export const FileMetadataSchema = Schema.Struct({
	summary: Schema.String,
	structure_hint: Schema.String
});
export type FileMetadata = typeof FileMetadataSchema.Type;

export const FileValueSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	size: Schema.Number,
	type: Schema.String,
	url: Schema.String,
	metadata: Schema.optional(FileMetadataSchema),
	indexed_status: Schema.optional(
		Schema.Literals(['pending', 'indexing', 'ready', 'failed', 'not_indexable'])
	),
	indexed_error: Schema.optional(Schema.NullOr(Schema.String))
});
export type FileValue = typeof FileValueSchema.Type;
