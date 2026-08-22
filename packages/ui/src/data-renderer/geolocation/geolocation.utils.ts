import { Schema } from 'effect';

const geolocationGeometrySchema = Schema.Struct({
	lon: Schema.Number,
	lat: Schema.Number
});

/** Geocoder answer shape: PostGIS-ish Point plus the human address the picker displays. */
const geolocationPickerValueSchema = Schema.Struct({
	geometry: Schema.NullOr(geolocationGeometrySchema),
	formatted_address: Schema.String,
	type: Schema.Literal('Point'),
	srid: Schema.Number
});
export type TGeolocationPickerValue = typeof geolocationPickerValueSchema.Type;

const decodeGeolocationPickerValue = Schema.decodeUnknownResult(geolocationPickerValueSchema);

function parseGeolocationPickerValue(value: unknown): TGeolocationPickerValue | null {
	const decoded = decodeGeolocationPickerValue(value);
	return decoded._tag === 'Success' ? decoded.success : null;
}

export function parseGeolocationPickerValues(
	value: unknown,
	multiple: boolean
): TGeolocationPickerValue | TGeolocationPickerValue[] | null {
	if (!multiple) return parseGeolocationPickerValue(value);
	return Array.isArray(value)
		? value.flatMap((item) => {
				const location = parseGeolocationPickerValue(item);
				return location ? [location] : [];
			})
		: [];
}
