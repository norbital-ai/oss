/** Site / photo capture must fall within this radius of the job site. */
export const SITE_LOCATION_TOLERANCE_M = 500;

export type LocationLike =
	| {
			geometry?: { lat?: number | null; lon?: number | null } | null;
	  }
	| null
	| undefined;

export function coordinatesOf(location: LocationLike): { lat: number; lon: number } | null {
	const lat = location?.geometry?.lat;
	const lon = location?.geometry?.lon;
	if (lat == null || lon == null) return null;
	return { lat, lon };
}

export function haversineMeters(
	lat1: number | null | undefined,
	lon1: number | null | undefined,
	lat2: number | null | undefined,
	lon2: number | null | undefined
): number | null {
	if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) return null;
	const R = 6371000;
	const toRad = (deg: number) => (deg * Math.PI) / 180;
	const dLat = toRad(lat2 - lat1);
	const dLon = toRad(lon2 - lon1);
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
	return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}

export function exceedsSiteTolerance(
	left: { lat: number; lon: number } | null | undefined,
	right: { lat: number; lon: number } | null | undefined,
	maxDistanceM = SITE_LOCATION_TOLERANCE_M
): boolean {
	const distanceM = haversineMeters(left?.lat, left?.lon, right?.lat, right?.lon);
	return distanceM != null && distanceM > maxDistanceM;
}
