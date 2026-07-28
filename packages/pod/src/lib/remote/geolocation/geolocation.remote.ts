import type { TGeolocation } from '$lib/authoring/builtin/custom_types.js';
import { Guard, requireAuthMiddleware } from '$lib/remote/guard.server.js';
import { requireRuntimeFacility } from '$lib/server/run/facilities.js';
import { AutocompleteGeolocationInputSchema } from './schema.js';

function toGeolocationValue(
	formattedAddress: string,
	location?: { lat: number; lng: number }
): TGeolocation {
	return {
		geometry: location ? { lon: location.lng, lat: location.lat } : null,
		formatted_address: formattedAddress,
		type: 'Point',
		srid: 4326
	};
}

const authenticated = Guard.init().use(requireAuthMiddleware());

export const autocompleteGeolocation = authenticated.query(
	AutocompleteGeolocationInputSchema,
	async (input): Promise<TGeolocation[]> => {
		const trimmed = input.trim();
		if (!trimmed) return [];

		const suggestions = await requireRuntimeFacility('maps').autocompleteGeolocation(trimmed);
		return suggestions.map((suggestion) =>
			toGeolocationValue(
				suggestion.formattedAddress,
				suggestion.latitude == null || suggestion.longitude == null
					? undefined
					: { lat: suggestion.latitude, lng: suggestion.longitude }
			)
		);
	}
);
