// The keyless geocoder ranks the workspace's own country first: a worldwide search names London's Wilkinson Road before
// Singapore's, so the query is also asked with the region's name and its places lead.
import assert from 'node:assert/strict';
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';
import { photonGeocoder, regionOf } from '../src/kinds/context.ts';

const feature = (country: string, street: string, city: string) => ({
	geometry: { coordinates: [103.88, 1.3] },
	properties: {
		countrycode: country,
		street,
		city,
		country: country === 'SG' ? 'Singapore' : 'United Kingdom'
	}
});

it.live('places in the workspace region come first, then the rest', () =>
	Effect.gen(function* () {
		const asked: string[] = [];
		const fetch: typeof globalThis.fetch = async (url) => {
			asked.push(decodeURIComponent(String(url)));
			const near = String(url).includes('Singapore');
			return new Response(
				JSON.stringify({
					features: near
						? [feature('SG', 'Wilkinson Road', 'Singapore')]
						: [feature('GB', 'Wilkinson Road', 'London')]
				})
			);
		};
		const region = regionOf('en-SG');
		assert.ok(region);
		const hits = yield* photonGeocoder
			.search('40 wilkinson road', { region })
			.pipe(Effect.provideService(FetchHttpClient.Fetch, fetch));
		assert.ok(asked.some((u) => u.includes('40 wilkinson road, Singapore')));
		assert.deepEqual(
			hits.map((h) => h.address.includes('Singapore')),
			[true, false]
		);
	})
);

it.live('without a region, the search is the plain worldwide one', () =>
	Effect.gen(function* () {
		const asked: string[] = [];
		const fetch: typeof globalThis.fetch = async (url) => (
			asked.push(String(url)),
			new Response(JSON.stringify({ features: [] }))
		);
		const region = regionOf('en');
		yield* photonGeocoder
			.search('40 wilkinson road', region === undefined ? {} : { region })
			.pipe(Effect.provideService(FetchHttpClient.Fetch, fetch));
		assert.equal(asked.length, 1);
	})
);
