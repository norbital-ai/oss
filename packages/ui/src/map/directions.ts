/** Three intermediate stops work in Google Maps on mobile browsers as well as desktop. */
export const MAX_ROUTE_STOPS = 5;
/** A travel-ordered itinerary handed to the navigation app only when the person opens it. */
export function directions_url(stops: readonly { lat: number; lng: number }[]): string | null {
	if (
		stops.length < 2 ||
		stops.length > MAX_ROUTE_STOPS ||
		stops.some(
			({ lat, lng }) =>
				!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180
		)
	)
		return null;
	const locations = stops.map(({ lat, lng }) => `${lat},${lng}`);
	const origin = locations[0];
	const destination = locations.at(-1);
	if (origin === undefined || destination === undefined) return null;
	const query = new URLSearchParams({
		api: '1',
		origin,
		destination,
		travelmode: 'driving'
	});
	if (locations.length > 2) query.set('waypoints', locations.slice(1, -1).join('|'));
	return `https://www.google.com/maps/dir/?${query}`;
}
