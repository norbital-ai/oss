// The kit's integration verbs: `receive` fails on what it cannot decode, `syncs.write` commits a read page without
// the read body, `syncs.test` runs the definition's test, and `integrations` pairs over a test's provider.
import { expect, layer } from '@effect/vitest';
import { Effect, Layer, Predicate, Schema } from 'effect';
import type { Json } from '../src/decl/values.ts';
import type { Provider } from '@norbital-ai/host-api';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { TestWorkspace } from '../../bolt-cli/src/test/index.ts';
import { program } from '../../bolt-cli/src/test/guest.ts';

const manifest = {
	workspace: { tz: 'UTC', locale: 'en' },
	messages: { 'errors.code': 'Product codes start with P, not {code}.' },
	models: {
		products: {
			description: 'An ERP product',
			record_label: 'record.name',
			key: ['code'],
			unique: [{ fields: ['code'], import_key: true }],
			fields: { code: { kind: 'text' }, name: { kind: 'text' } }
		}
	},
	relationships: {},
	exposures: {
		products: {
			outputs: { default: { products: { fields: 'all' } } },
			create: { columns: { products: ['code', 'name'] } },
			syncs: { erp: { with: 'erp', read: true } }
		}
	},
	integrations: {
		erp: { description: 'The ERP', driver: 'http', test: true, http: { base_url: 'https://erp.example/api' } }
	},
	policies: { clerk: { description: 'Reads products', grants: { products: { outputs: { default: {} }, create: {} } } } },
	teams: {},
	automations: {},
	mcp: {},
	apps: {},
	custom_fields: {},
	agent: { skills: {} },
	needs: []
} satisfies EngineManifest;
const source = `export default {
	model: { products: { bodies: {
		create: function* (changes, ctx) {
			const row = changes.findIndex((c) => !c.after.code.startsWith('P'));
			return row < 0 ? changes.map((c) => c.set) : yield* ctx.refuse('errors.code', { row, values: { code: changes[row].after.code } });
		},
		syncs: { erp: { read: function* () { return { rows: [] }; } } }
	} } },
	integration_definition: { erp: { bodies: { test: function* () { throw new Error('erp offline'); } } } }
};`;
/** Pairs on `{ key }`: writes the credential and a connected status, as a real provider does. */
const fake: Provider = {
	driver: 'whatsapp',
	id: 'fake',
	label: 'Fake',
	setup: { kind: 'form', steps: [], fields: [{ name: 'key', label: 'Key', secret: true }] },
	async open(ctx) {
		return {
			async send() {
				return { provider_id: 'x' };
			},
			async pair(input) {
				const key = Predicate.isObject(input) ? input['key'] : undefined;
				if (typeof key !== 'string') throw new Error('a key is required');
				await ctx.credentials.write(new Map([['credential', { key }]]));
				await ctx.status({ state: 'connected', account: key });
			},
			async close() {}
		};
	}
};
const Fixture = Layer.unwrap(
	Effect.map(program(source), (guest) =>
		TestWorkspace.layer({
			manifest,
			guest,
			transforms: ['products.create'],
			providers: [fake],
			now: '2026-11-12T08:00:00.000Z',
			seed: {
				sys_integration: [
					{ id: 'erp1', integration: 'erp', name: 'ERP' },
					{ id: 'wa1', integration: 'whatsapp', name: 'Phone' }
				]
			}
		})
	)
);
const Products = Schema.Struct({ code: Schema.String, name: Schema.String });

layer(Fixture, { excludeTestServices: true })('kit integration verbs', (it) => {
	it.effect('receive fails on a value that is no inbound message, such as a delivery report', () =>
		Effect.gen(function* () {
			const t = yield* TestWorkspace;
			const failure = yield* Effect.flip(
				t.receive('wa1', { kind: 'delivery', provider_id: 'x', report: { kind: 'delivered' } })
			);
			expect(failure).toMatchObject({ _tag: 'KitInvalid', message: expect.stringContaining('event()') });
			yield* t.event('wa1', {
				kind: 'delivery',
				provider_id: 'unknown',
				report: { kind: 'delivered', at: t.clock.now(), provider: 'fake' }
			});
		})
	);

	it.effect('syncs.write commits a read page to a model only its sync writes: by remote id, updated, deleted, refused as its callbacks say', () =>
		Effect.gen(function* () {
			const t = yield* TestWorkspace;
			const products = t.db.rows(Products, { text: 'SELECT code, name FROM products ORDER BY code', params: [] });
			yield* t.syncs.write('products.sync.erp', [{ $id: 'r1', code: 'P1', name: 'Bolt' }]);
			yield* t.syncs.write('products.sync.erp', [
				{ $id: 'r1', code: 'P1', name: 'Bolt M6' },
				{ $id: 'r2', code: 'P2', name: 'Nut' }
			]);
			expect(yield* products).toEqual([
				{ code: 'P1', name: 'Bolt M6' },
				{ code: 'P2', name: 'Nut' }
			]);
			yield* t.syncs.write('products.sync.erp', [{ $id: 'r2', $deleted: true }], { instance: 'erp1' });
			expect(yield* products).toEqual([{ code: 'P1', name: 'Bolt M6' }]);
			expect(yield* Effect.flip(t.syncs.write('products.sync.erp', [{ $id: 'r3', code: 'X3', name: 'Washer' }]))).toMatchObject({
				_tag: 'ActRefused',
				message: 'Product codes start with P, not X3.',
				key: 'errors.code'
			});
			// a member's create, granted or not, is refused: the sync alone writes the model
			const clerk = yield* t.as(t.member(['clerk'])),
				create: Record<string, Json> = { 'products.create': [{ code: 'P9', name: 'Pin' }] };
			expect(yield* Effect.flip(clerk.act(create))).toMatchObject({ _tag: 'ActRefused' });
		})
	);

	it.effect("syncs.test runs the definition's test body", () =>
		Effect.gen(function* () {
			const t = yield* TestWorkspace;
			expect((yield* Effect.flip(t.syncs.test('erp1'))).message).toContain('erp offline');
		})
	);

	it.effect('integrations pairs an instance over the provider; may answers who manages it', () =>
		Effect.gen(function* () {
			const t = yield* TestWorkspace;
			expect(yield* t.integrations.may(t.admin, 'wa1')).toBe(true);
			expect(yield* t.integrations.may(t.member(['clerk']), 'wa1')).toBe(false);
			expect(yield* t.integrations.may(t.admin, 'none')).toBe(null);
			yield* t.integrations.pair('wa1', { key: 'k1' });
			expect(
				yield* t.db.rows(Schema.Struct({ state: Schema.String }), {
					text: `SELECT status->>'state' AS state FROM sys_integration WHERE id = 'wa1'`,
					params: []
				})
			).toEqual([{ state: 'connected' }]);
		})
	);
});
