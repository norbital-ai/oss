import { Schema } from 'effect';

/** Source media the image preview decoder accepts. Other media are delivered unchanged. */
export const ImagePreviewMimeSchema = Schema.Literals([
	'image/jpeg',
	'image/png',
	'image/heic',
	'image/heif'
]);

export const ImageMetadataSchema = Schema.Struct({
	format: Schema.Literals(['jpeg', 'png', 'heic']),
	width: Schema.Number,
	height: Schema.Number,
	pdq: Schema.String,
	exif: Schema.Struct({
		taken_at: Schema.optionalKey(Schema.String),
		gps: Schema.optionalKey(Schema.Struct({ lat: Schema.Number, lng: Schema.Number })),
		software: Schema.optionalKey(Schema.String),
		make: Schema.optionalKey(Schema.String),
		model: Schema.optionalKey(Schema.String)
	})
});

/** What an ingest answers (plan 12) with its image bytes decoded by `bytes`: Convert's wire (base64) or the port's ABI. */
export const ingest_answer = <B extends Schema.Codec<Uint8Array, unknown>>(bytes: B) => {
	const fields = {
		images: Schema.Array(Schema.Struct({ name: Schema.String, mime: Schema.String, bytes })),
		meta: Schema.Struct({
			usage: Schema.optionalKey(
				Schema.Struct({
					calls: Schema.Array(Schema.String),
					model: Schema.String,
					input: Schema.Number,
					output: Schema.Number,
					cost: Schema.Number
				})
			),
			stats: Schema.Struct({
				pages: Schema.NullOr(Schema.Number),
				bytes: Schema.Number,
				cpuMs: Schema.Number,
				wallMs: Schema.Number
			})
		})
	};
	return Schema.Union([
		Schema.Struct({ kind: Schema.Literal('document'), html: Schema.String, ...fields }),
		Schema.Struct({ kind: Schema.Literal('data'), json: Schema.Json, ...fields })
	]);
};
export const IngestedSchema = ingest_answer(Schema.Uint8Array);
