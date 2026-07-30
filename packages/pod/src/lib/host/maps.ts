import { z } from 'zod';
import {
	StaticMapInputSchema,
	type GeolocationSuggestion,
	type HostMapsBinding,
	type StaticMapRenderResult
} from '@norbital-ai/platform-utils/runtime/binding';

export type GoogleMapsOptions = {
	/** A Google Maps Platform key with Static Maps and Places enabled. */
	readonly apiKey: string;
	/**
	 * ccTLD region bias for rendering and place ranking, e.g. `'sg'`. Omitted means no bias, which
	 * ranks results globally rather than near the deployment.
	 */
	readonly region?: string;
	/** Rendered image size in CSS pixels before `scale`. Defaults to 640×320. */
	readonly width?: number;
	readonly height?: number;
};

const MAX_STATIC_MAP_BYTES = 4 * 1024 * 1024;
const MAP_PADDING = 48;
const TILE_SIZE = 256;

const placesAutocompleteResponseSchema = z.object({
	status: z.string(),
	predictions: z.array(z.object({ description: z.string(), place_id: z.string() })).optional()
});

const placeDetailsResponseSchema = z.object({
	status: z.string(),
	result: z
		.object({
			formatted_address: z.string().optional(),
			name: z.string().optional(),
			geometry: z
				.object({ location: z.object({ lat: z.number(), lng: z.number() }).optional() })
				.optional()
		})
		.optional()
});

/** Web-Mercator projection into the unit square, which is what the tile math works in. */
function project(latitude: number, longitude: number): { x: number; y: number } {
	const sinLatitude = Math.min(Math.max(Math.sin((latitude * Math.PI) / 180), -0.9999), 0.9999);
	return {
		x: 0.5 + longitude / 360,
		y: 0.5 - Math.log((1 + sinLatitude) / (1 - sinLatitude)) / (4 * Math.PI)
	};
}

function unproject(x: number, y: number): { latitude: number; longitude: number } {
	return {
		latitude: (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI,
		longitude: (x - 0.5) * 360
	};
}

/**
 * Google Maps Platform, with the operator's own key.
 *
 * The zoom is derived rather than fixed: every marker is projected, the bounding box is measured,
 * and the largest zoom that still fits the box inside the padded viewport wins. A single marker has
 * no box to fit, so it falls back to street-level 14. `markerPositions` is returned in fractional
 * image coordinates so a caller can overlay its own labels on the rendered bytes without repeating
 * the projection.
 */
export function googleMaps(options: GoogleMapsOptions): HostMapsBinding {
	if (!options.apiKey.trim()) throw new Error('googleMaps requires a non-empty apiKey');
	const width = options.width ?? 640;
	const height = options.height ?? 320;

	return {
		async renderStaticMap(rawInput): Promise<StaticMapRenderResult> {
			const input = StaticMapInputSchema.parse(rawInput);
			const url = new URL('https://maps.googleapis.com/maps/api/staticmap');
			const projected = input.markers.map((marker) => project(marker.latitude, marker.longitude));
			const xValues = projected.map((marker) => marker.x);
			const yValues = projected.map((marker) => marker.y);
			const minX = Math.min(...xValues);
			const maxX = Math.max(...xValues);
			const minY = Math.min(...yValues);
			const maxY = Math.max(...yValues);
			const xSpan = Math.max((maxX - minX) * TILE_SIZE, Number.EPSILON);
			const ySpan = Math.max((maxY - minY) * TILE_SIZE, Number.EPSILON);
			const zoom =
				minX === maxX && minY === maxY
					? 14
					: Math.max(
							1,
							Math.min(
								18,
								Math.floor(
									Math.min(
										Math.log2((width - MAP_PADDING * 2) / xSpan),
										Math.log2((height - MAP_PADDING * 2) / ySpan)
									)
								)
							)
						);
			const centerWorld = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
			const center = unproject(centerWorld.x, centerWorld.y);
			const worldSize = TILE_SIZE * 2 ** zoom;
			const markerPositions = projected.map((marker) => ({
				x: 0.5 + ((marker.x - centerWorld.x) * worldSize) / width,
				y: 0.5 + ((marker.y - centerWorld.y) * worldSize) / height
			}));

			url.searchParams.set('size', `${width}x${height}`);
			url.searchParams.set('scale', '2');
			url.searchParams.set('format', 'png');
			url.searchParams.set('maptype', 'roadmap');
			if (options.region) url.searchParams.set('region', options.region);
			url.searchParams.set('center', `${center.latitude},${center.longitude}`);
			url.searchParams.set('zoom', String(zoom));
			for (const marker of input.markers) {
				url.searchParams.append(
					'markers',
					[
						`color:${marker.tone === 'alert' ? '0xc2410c' : '0xb7791f'}`,
						...(marker.label ? [`label:${marker.label}`] : []),
						`${marker.latitude},${marker.longitude}`
					].join('|')
				);
			}
			url.searchParams.set('key', options.apiKey);

			const response = await fetch(url);
			if (!response.ok) {
				throw new Error(`Google Maps Static API returned HTTP ${response.status}.`);
			}
			const mimeType = response.headers.get('content-type')?.split(';')[0];
			if (mimeType !== 'image/png' && mimeType !== 'image/jpeg') {
				throw new Error('Google Maps Static API returned an unsupported image type.');
			}
			const data = new Uint8Array(await response.arrayBuffer());
			if (data.byteLength > MAX_STATIC_MAP_BYTES) {
				throw new Error('Google Maps Static API returned an unexpectedly large image.');
			}
			return { mimeType, data, markerPositions };
		},

		async autocompleteGeolocation(rawQuery): Promise<readonly GeolocationSuggestion[]> {
			const query = z.string().trim().min(1).max(500).parse(rawQuery);
			const autocompleteUrl = new URL(
				'https://maps.googleapis.com/maps/api/place/autocomplete/json'
			);
			autocompleteUrl.searchParams.set('key', options.apiKey);
			autocompleteUrl.searchParams.set('input', query);
			if (options.region) autocompleteUrl.searchParams.set('region', options.region);

			// Autocomplete is a typing aid, so every failure degrades to "the text you typed, with no
			// coordinates" rather than surfacing an error into the field. A user can always save the
			// address they wrote; losing the geometry is recoverable, losing the keystroke is not.
			try {
				const autocompleteResponse = await fetch(autocompleteUrl);
				if (!autocompleteResponse.ok) {
					throw new Error(`Places autocomplete returned HTTP ${autocompleteResponse.status}.`);
				}
				const autocompleteData = placesAutocompleteResponseSchema.parse(
					await autocompleteResponse.json()
				);
				if (autocompleteData.status !== 'OK' && autocompleteData.status !== 'ZERO_RESULTS') {
					throw new Error(`Places autocomplete API returned ${autocompleteData.status}.`);
				}

				const suggestions = await Promise.all(
					(autocompleteData.predictions ?? []).slice(0, 5).map(async (prediction) => {
						const detailsUrl = new URL('https://maps.googleapis.com/maps/api/place/details/json');
						detailsUrl.searchParams.set('key', options.apiKey);
						detailsUrl.searchParams.set('place_id', prediction.place_id);
						detailsUrl.searchParams.set('fields', 'geometry,formatted_address,name');
						try {
							const detailsResponse = await fetch(detailsUrl);
							if (!detailsResponse.ok) {
								throw new Error(`Place details returned HTTP ${detailsResponse.status}.`);
							}
							const detailsData = placeDetailsResponseSchema.parse(await detailsResponse.json());
							const place = detailsData.status === 'OK' ? detailsData.result : undefined;
							const location = place?.geometry?.location;
							return {
								formattedAddress: place?.formatted_address ?? place?.name ?? prediction.description,
								latitude: location?.lat ?? null,
								longitude: location?.lng ?? null
							};
						} catch (cause) {
							console.warn('[pod:maps] place details lookup failed', cause);
							return {
								formattedAddress: prediction.description,
								latitude: null,
								longitude: null
							};
						}
					})
				);
				return suggestions.length > 0
					? suggestions
					: [{ formattedAddress: query, latitude: null, longitude: null }];
			} catch (cause) {
				console.warn('[pod:maps] places autocomplete failed', cause);
				return [{ formattedAddress: query, latitude: null, longitude: null }];
			}
		}
	};
}
