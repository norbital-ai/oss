import { expect, it } from 'vitest';
import { directions_url } from '../src/map/directions.ts';

it('keeps the chosen start, intermediate stops and destination in travel order', () => {
	const stops = [1, 2, 3, 4, 5].map((lat) => ({ lat, lng: 103 + lat / 10 }));
	const href = directions_url(stops);
	expect(href).toBeTypeOf('string');
	if (href === null) throw new Error('Expected a directions URL');
	const url = new URL(href);
	expect(url.origin).toBe('https://www.google.com');
	expect(Object.fromEntries(url.searchParams)).toEqual({
		api: '1',
		origin: '1,103.1',
		destination: '5,103.5',
		travelmode: 'driving',
		waypoints: '2,103.2|3,103.3|4,103.4'
	});
	const direct = directions_url(stops.slice(0, 2));
	if (direct === null) throw new Error('Expected a direct route URL');
	expect(new URL(direct).searchParams.has('waypoints')).toBe(false);
});

it('refuses an incomplete, oversized or invalid itinerary without dropping stops', () => {
	const point = { lat: 1.3, lng: 103.8 };
	for (const stops of [
		[],
		[point],
		Array.from({ length: 6 }, () => point),
		[point, { lat: NaN, lng: 1 }],
		[point, { lat: 91, lng: 0 }],
		[point, { lat: 0, lng: -181 }]
	])
		expect(directions_url(stops)).toBeNull();
});
