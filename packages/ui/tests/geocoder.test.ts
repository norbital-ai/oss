// @ts-nocheck -- executed directly by Node with --experimental-strip-types.
// The keyless geocoder ranks the workspace's own country first: a worldwide search names London's Wilkinson Road before
// Singapore's, so the query is also asked with the region's name and its places lead.
import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_GEOCODER, regionOf } from '../src/kinds/context.ts';

const feature = (country, street, city) => ({
	geometry: { coordinates: [103.88, 1.3] },
	properties: { countrycode: country, street, city, country: country === 'SG' ? 'Singapore' : 'United Kingdom' }
});

test('places in the workspace region come first, then the rest', async () => {
	const asked = [];
	globalThis.fetch = async (url) => {
		asked.push(decodeURIComponent(String(url)));
		const near = String(url).includes('Singapore');
		return new Response(JSON.stringify({ features: near ? [feature('SG', 'Wilkinson Road', 'Singapore')] : [feature('GB', 'Wilkinson Road', 'London')] }));
	};
	const hits = await DEFAULT_GEOCODER.search('40 wilkinson road', { region: regionOf('en-SG') });
	assert.ok(asked.some((u) => u.includes('40 wilkinson road, Singapore')));
	assert.deepEqual(hits.map((h) => h.address.includes('Singapore')), [true, false]);
});

test('without a region, the search is the plain worldwide one', async () => {
	const asked = [];
	globalThis.fetch = async (url) => (asked.push(String(url)), new Response(JSON.stringify({ features: [] })));
	await DEFAULT_GEOCODER.search('40 wilkinson road', { region: regionOf('en') });
	assert.equal(asked.length, 1);
});
