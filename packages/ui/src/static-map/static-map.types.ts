import { Schema } from 'effect';

const StaticMapMarkerSchema = Schema.Struct({
	latitude: Schema.Number,
	longitude: Schema.Number,
	label: Schema.optional(Schema.String),
	ariaLabel: Schema.optional(Schema.String),
	tone: Schema.optional(Schema.Literals(['default', 'alert']))
});
export type StaticMapMarker = typeof StaticMapMarkerSchema.Type;

const StaticMapRequestSchema = Schema.Struct({
	markers: Schema.Array(StaticMapMarkerSchema)
});
export type StaticMapRequest = typeof StaticMapRequestSchema.Type;

const StaticMapMarkerPositionSchema = Schema.Struct({
	x: Schema.Number,
	y: Schema.Number
});
type StaticMapMarkerPosition = typeof StaticMapMarkerPositionSchema.Type;

const StaticMapImageSchema = Schema.Struct({
	mimeType: Schema.Literals(['image/png', 'image/jpeg']),
	dataBase64: Schema.String,
	markerPositions: Schema.optional(Schema.Array(StaticMapMarkerPositionSchema))
});
export type StaticMapImage = typeof StaticMapImageSchema.Type;
