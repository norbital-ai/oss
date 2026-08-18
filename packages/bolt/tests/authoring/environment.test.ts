import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { defineEnvironment, describeEnvironment } from '../../src/authoring/environment-schema.js';

/**
 * `+env.ts` declares what a workspace needs from its environment. It never carries a value: the
 * values live in the Secrets vault, and only server-side code reads them.
 */
describe('environment declaration', () => {
	it('reads a declaration into the shape a form needs', () => {
		const spec = defineEnvironment({
			GEOCODING_API_KEY: { label: 'Geocoding key', description: 'Used by the address picker.' },
			MAP_TILE_URL: { secret: false, default: 'https://tiles.example/{z}/{x}/{y}.png' }
		});
		expect(describeEnvironment(spec)).toEqual([
			{
				name: 'GEOCODING_API_KEY',
				label: 'Geocoding key',
				description: 'Used by the address picker.',
				secret: true
			},
			{
				name: 'MAP_TILE_URL',
				label: 'MAP_TILE_URL',
				secret: false,
				default: 'https://tiles.example/{z}/{x}/{y}.png'
			}
		]);
	});

	it('treats a declaration that says nothing as a secret', () => {
		// Guessing wrong in the other direction leaks a credential.
		expect(describeEnvironment(defineEnvironment({ TOKEN: {} }))[0]?.secret).toBe(true);
	});

	it('refuses a name that would read differently in the vault, the form and the shell', () => {
		expect(() => defineEnvironment({ apiKey: {} })).toThrow(/SCREAMING_SNAKE_CASE/);
		expect(() => defineEnvironment({ '9LIVES': {} })).toThrow(/SCREAMING_SNAKE_CASE/);
	});

	it('refuses a default on a secret, which is a credential written into source', () => {
		expect(() => defineEnvironment({ API_KEY: { default: 'sk-live-oops' } })).toThrow(
			/credential written into source/
		);
		// The same default is fine once the author says it is not sensitive.
		expect(() =>
			defineEnvironment({ REGION: { secret: false, default: 'ap-southeast-1' } })
		).not.toThrow();
	});

	it('never lets a secret default reach the form even if one is somehow present', () => {
		// `defineEnvironment` refuses this pairing, so the guard exists for a declaration built by hand.
		const [entry] = describeEnvironment({
			variables: { API_KEY: { secret: true, default: 'sk-live-oops' } }
		});
		expect(entry).not.toHaveProperty('default');
	});

	it('describes an absent declaration as an empty form rather than failing', () => {
		expect(describeEnvironment(undefined)).toEqual([]);
	});
});

describe('secrets command surface', () => {
	it('exposes status and write, and deliberately no read', () => {
		// The one line that would put every credential a fetch away from a browser. Asserted on the
		// dispatch source because its absence is the guarantee — a test that only exercised the
		// commands that exist could never notice one being added.
		const dispatch = readFileSync(
			new URL('../../src/runtime/dispatch.ts', import.meta.url),
			'utf8'
		);
		expect(dispatch).toContain("case 'secrets.status'");
		expect(dispatch).toContain("case 'secrets.write'");
		expect(dispatch).not.toContain("case 'secrets.read'");
	});
});
