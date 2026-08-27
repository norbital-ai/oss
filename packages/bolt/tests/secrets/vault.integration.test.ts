import { Effect } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import { collection, field, policy, workspace } from '../../src/authoring/workspace-schema.js';
import { defineEnvironment } from '../../src/authoring/environment-schema.js';
import { Secrets } from '../../src/runtime/secrets/secrets.js';
import { makeBoltTestRuntime, type BoltTestRuntime } from '../support/bolt-test-layer.js';

/**
 * The Secrets vault over real SQL.
 *
 * The rules worth checking against a database rather than a mock: an unset value reads as `null`
 * rather than throwing, an undeclared name is refused in both directions, and clearing deletes
 * rather than storing emptiness — an empty string would pass every downstream null check while the
 * secret is not actually there.
 */

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

const withEnvironment = workspace({
	name: 'test-workspace',
	version: '1',
	collections: [collection({ name: 'people', fields: { name: field.string({ required: true }) } })],
	apps: [],
	policies: [
		policy({ name: 'admin', effect: 'allow', actions: ['*'], capabilities: { apps: ['*'] } })
	],
	teams: {
		admin: ['admin']
	},
	automations: [],
	envoys: [],
	integrations: [],
	prompt: 'You are the test workspace agent.',
	tools: [],
	skills: [],
	requiredFacilities: [],
	environment: defineEnvironment({
		GEOCODING_API_KEY: { label: 'Geocoding key' },
		MAP_TILE_URL: { secret: false, default: 'https://tiles.example/{z}/{x}/{y}.png' }
	})
});

describe('secrets vault', () => {
	it('reads an unset value as null rather than failing', async () => {
		harness = await makeBoltTestRuntime(withEnvironment);
		const { runtime, effectId } = harness;
		const value = await runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Secrets.Service).read(effectId('read'), 'GEOCODING_API_KEY');
			})
		);
		// Every declared variable is optional; a caller that cannot proceed says so itself.
		expect(value).toBeNull();
	});

	it('falls back to a declared default, which only a non-secret may have', async () => {
		harness = await makeBoltTestRuntime(withEnvironment);
		const { runtime, effectId } = harness;
		const value = await runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Secrets.Service).read(effectId('read'), 'MAP_TILE_URL');
			})
		);
		expect(value).toBe('https://tiles.example/{z}/{x}/{y}.png');
	});

	it('round-trips a stored value', async () => {
		harness = await makeBoltTestRuntime(withEnvironment);
		const { runtime, effectId } = harness;
		const value = await runtime.runPromise(
			Effect.gen(function* () {
				const secrets = yield* Secrets.Service;
				yield* secrets.write(effectId('write'), 'GEOCODING_API_KEY', 'sk-test-123', 'admin-1');
				return yield* secrets.read(effectId('read'), 'GEOCODING_API_KEY');
			})
		);
		expect(value).toBe('sk-test-123');
	});

	it('clears by deleting, not by storing an empty string', async () => {
		harness = await makeBoltTestRuntime(withEnvironment);
		const { runtime, effectId } = harness;
		const value = await runtime.runPromise(
			Effect.gen(function* () {
				const secrets = yield* Secrets.Service;
				yield* secrets.write(effectId('write'), 'GEOCODING_API_KEY', 'sk-test-123', 'admin-1');
				yield* secrets.write(effectId('clear'), 'GEOCODING_API_KEY', '', 'admin-1');
				return yield* secrets.read(effectId('read'), 'GEOCODING_API_KEY');
			})
		);
		// `''` would be a value: every `?? fallback` and `!= null` downstream would treat the secret as
		// present while it is not.
		expect(value).toBeNull();
		expect(await harness.database.query('select 1 from bolt_secrets')).toHaveLength(0);
	});

	it('refuses a name +env.ts does not declare, reading and writing alike', async () => {
		harness = await makeBoltTestRuntime(withEnvironment);
		const { runtime, effectId } = harness;
		const readFailure = await runtime.runPromise(
			Effect.flip(
				Effect.gen(function* () {
					return yield* (yield* Secrets.Service).read(effectId('read'), 'NOT_DECLARED');
				})
			)
		);
		const writeFailure = await runtime.runPromise(
			Effect.flip(
				Effect.gen(function* () {
					yield* (yield* Secrets.Service).write(effectId('write'), 'NOT_DECLARED', 'x', 'admin-1');
				})
			)
		);
		expect(readFailure._tag).toBe('Bolt.Secrets.NotDeclared');
		expect(writeFailure._tag).toBe('Bolt.Secrets.NotDeclared');
	});

	it('reports which names are set without reporting any value', async () => {
		harness = await makeBoltTestRuntime(withEnvironment);
		const { runtime, effectId } = harness;
		const status = await runtime.runPromise(
			Effect.gen(function* () {
				const secrets = yield* Secrets.Service;
				yield* secrets.write(effectId('write'), 'GEOCODING_API_KEY', 'sk-test-123', 'admin-1');
				return yield* secrets.status(effectId('status'));
			})
		);
		const byName = new Map(status.map((entry) => [entry.name, entry]));
		expect(byName.get('GEOCODING_API_KEY')?.configured).toBe(true);
		expect(byName.get('MAP_TILE_URL')?.configured).toBe(false);
		// The whole point: nothing in this payload carries the stored value.
		expect(JSON.stringify(status)).not.toContain('sk-test-123');
	});

	it('describes an empty declaration rather than failing when +env.ts is absent', async () => {
		harness = await makeBoltTestRuntime();
		const { runtime, effectId } = harness;
		const status = await runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Secrets.Service).status(effectId('status'));
			})
		);
		expect(status).toEqual([]);
	});
});
