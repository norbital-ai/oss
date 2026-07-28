export type TGeolocationPickerGeometry = {
	lon: number;
	lat: number;
};

export type TGeolocationPickerValue = {
	geometry: TGeolocationPickerGeometry | null;
	formatted_address: string;
	type: 'Point';
	srid: number;
};

export function parseGeolocationPickerValue(value: unknown): TGeolocationPickerValue | null {
	if (value == null || typeof value !== 'object') return null;
	const formattedAddress = Reflect.get(value, 'formatted_address');
	const type = Reflect.get(value, 'type');
	const srid = Reflect.get(value, 'srid');
	const geometry = Reflect.get(value, 'geometry');
	if (typeof formattedAddress !== 'string' || type !== 'Point' || typeof srid !== 'number') {
		return null;
	}
	if (geometry === null) {
		return { geometry: null, formatted_address: formattedAddress, type, srid };
	}
	if (geometry == null || typeof geometry !== 'object') return null;
	const lon = Reflect.get(geometry, 'lon');
	const lat = Reflect.get(geometry, 'lat');
	if (typeof lon !== 'number' || typeof lat !== 'number') return null;
	return { geometry: { lon, lat }, formatted_address: formattedAddress, type, srid };
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
