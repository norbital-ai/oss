// `bolt seed` restores the bank's rows into a scratch database before it sends anything: a seed the host would refuse
// mid-restore (a row naming an integration instance the seed lacks) fails here, and the target is never touched.
import { Effect, Result } from 'effect';
import { expect } from 'vitest';
import { it } from '@effect/vitest';
import { decode_projected_manifest } from '../../bolt/src/engine/manifest.ts';
import { pushSeed } from '../src/cli/seed.ts';
import type { Seeding } from '../src/compiler/artifact/seed.ts';

const manifest = Result.getOrThrow(
	decode_projected_manifest({
		workspace: { tz: 'UTC', locale: 'en' },
		models: {
			entities: { description: 'A legal entity', record_label: 'record.name', fields: { name: { kind: 'text' } } }
		},
		relationships: { 'entities.hotline': { to: 'sys_integration', optional: true } },
		exposures: { entities: { outputs: { default: { entities: { fields: 'all' } } } } },
		integrations: {},
		policies: {},
		teams: {},
		automations: {},
		mcp: {},
		apps: {},
		custom_fields: {},
		agent: { skills: {} }
	})
);
const target = { url: 'http://host.test', tenant: 'demo', secret: 'test-secret', scope: 'local' };
const seeding = (hotline: string | null): Seeding => ({
	tree: 'acme',
	rows: { entities: [{ id: '0190f1e2-3c4d-7e8f-9a0b-1c2d3e4f5a6b', name: 'Acme', hotline }] },
	start: [],
	assets: [],
	bytes: () => new Uint8Array()
});

it.live('a seed that does not restore is refused before the host is called', () =>
	Effect.gen(function* () {
		const calls: string[] = [];
		const fetched: typeof fetch = async (input) => {
			calls.push(String(input));
			return Response.json({ value: null });
		};
		const original = globalThis.fetch;
		globalThis.fetch = fetched;
		yield* Effect.addFinalizer(() => Effect.sync(() => (globalThis.fetch = original)));
		const refused = yield* Effect.flip(pushSeed(manifest, seeding('missing-instance'), target));
		expect(refused.message).toMatch(/^the seed does not restore: /);
		expect(calls).toEqual([]);
		yield* pushSeed(manifest, seeding(null), target);
		expect(calls).toEqual(['http://host.test/__colony/ops']);
	}).pipe(Effect.scoped)
);

it.live("a bank row's `{ asset }` file value restores as the file reference the host stores", () =>
	Effect.gen(function* () {
		const original = globalThis.fetch;
		globalThis.fetch = async () => Response.json({ value: null });
		yield* Effect.addFinalizer(() => Effect.sync(() => (globalThis.fetch = original)));
		const withFile = Result.getOrThrow(
			decode_projected_manifest({
				workspace: { tz: 'UTC', locale: 'en' },
				models: {
					photos: {
						description: 'A photo',
						record_label: 'record.id',
						fields: {
							photo: { kind: 'file', accept: ['image/jpeg'], max: '1MiB' },
							pages: { kind: 'file', accept: ['image/jpeg'], max: '1MiB', many: true, optional: true }
						}
					}
				},
				relationships: {},
				exposures: { photos: { outputs: { default: { photos: { fields: 'all' } } } } },
				integrations: {},
				policies: {},
				teams: {},
				automations: {},
				mcp: {},
				apps: {},
				custom_fields: {},
				agent: { skills: {} }
			})
		);
		const bytes = new TextEncoder().encode('jpeg');
		yield* pushSeed(
			withFile,
			{
				tree: 'acme',
				rows: {
					photos: [
						{
							id: '0190f1e2-3c4d-7e8f-9a0b-1c2d3e4f5a6b',
							photo: { asset: 'assets/a.jpg' },
							pages: [{ asset: 'assets/a.jpg' }]
						}
					]
				},
				start: [],
				assets: [{ path: 'assets/a.jpg', sha256: 'a'.repeat(64), bytes: bytes.byteLength, content_type: 'image/jpeg' }],
				bytes: () => bytes
			},
			target
		);
	}).pipe(Effect.scoped)
);
