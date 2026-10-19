// The Effect test kit: scoped acquisition and typed refusal failures, with no Promise facet.
import { Context, Effect, Layer, Option, Schema } from 'effect';
import { PGlite } from '@electric-sql/pglite';
import { it, vi } from '@effect/vitest';
import { Pristine } from '../src/engine/db/pglite.ts';
import { ActRefused } from '../src/decl/errors.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { expect, layer, TestWorkspace } from '../src/test/index.ts';

const manifest = {
	workspace: { tz: 'UTC', locale: 'en' },
	models: {
		customers: { description: 'A customer', label: 'name', fields: { name: { kind: 'text' } } }
	},
	relationships: {},
	collections: { customers: { read: { fields: 'all' }, create: { input: { columns: ['name'] } } } },
	policies: { reader: { description: 'Reads customers', grants: { customers: { read: true } } } },
	automations: {},
	integrations: {},
	pipelines: {},
	teams: {},
	connections: {},
	envoys: {},
	mcp: {},
	apps: {},
	customFields: {},
	agent: { skills: {} }
} satisfies EngineManifest;

it.live('computed NULL values decode without widening required computed strings', () =>
	Effect.scoped(
		Effect.gen(function* () {
			const computed = {
				...manifest,
				models: {
					customers: {
						...manifest.models.customers,
						fields: {
							name: { kind: 'text' },
							email: { kind: 'text', optional: true },
							party: { kind: 'json', optional: true }
						},
						computed: {
							party_id: { kind: 'text', expr: { jsonText: [{ field: 'party' }, 'id'] } },
							email_lower: {
								kind: 'text',
								expr: { regexReplace: [{ field: 'email' }, '[^0-9]', ''] }
							},
							name_upper: { kind: 'text', expr: { upper: { field: 'name' } } },
							email_label: { kind: 'text', expr: { concat: [{ field: 'email' }, ' contact'] } },
							email_default: { kind: 'text', expr: { coalesce: [{ field: 'email' }, 'unknown'] } },
							email_chain: { kind: 'text', expr: { upper: { field: 'email_lower' } } }
						}
					}
				}
			} satisfies EngineManifest;
			const t = Context.get(
				yield* Layer.build(
					TestWorkspace.layer({
						manifest: computed,
						seed: { customers: [{ id: '0199a000-0000-4000-8000-000000000001', name: 'Acme' }] }
					})
				),
				TestWorkspace
			);
			const selected = {
				select: {
					name: true,
					email_lower: true,
					name_upper: true,
					email_label: true,
					email_default: true,
					email_chain: true
				},
				all: true
			} satisfies { select: Record<string, true>; all: true };
			expect((yield* t.as(t.admin).read('customers', selected)).rows[0]).toMatchObject({
				name: 'Acme',
				email_lower: null,
				name_upper: 'ACME',
				email_label: ' contact',
				email_default: 'unknown',
				email_chain: null
			});
			expect((yield* t.as(t.member(['reader'])).read('customers', selected)).rows[0]).toMatchObject(
				{
					email_lower: null,
					name_upper: 'ACME',
					email_default: 'unknown',
					email_chain: null
				}
			);
			expect(
				(yield* t
					.as(t.admin)
					.read('sys_user', { select: { party_id: true, phone_key: true }, all: true })).rows[0]
			).toMatchObject({ party_id: null, phone_key: null });
		})
	)
);

it.live('schema images are shared across isolated copies and change with the declaration', () =>
	Effect.scoped(
		Effect.gen(function* () {
			const pristine = yield* Pristine.pipe(Effect.flatten, Effect.provide(Pristine.layer));
			const create = vi.spyOn(PGlite, 'create');
			return yield* Effect.gen(function* () {
				const id = '0199a000-0000-4000-8000-000000000001';
				const contexts = yield* Effect.all(
					['Acme', 'Beta'].map((name) =>
						Layer.build(TestWorkspace.layer({ manifest, seed: { customers: [{ id, name }] } }))
					),
					{ concurrency: 'unbounded' }
				);
				const first = contexts[0],
					second = contexts[1];
				if (first === undefined || second === undefined)
					throw new Error('Both workspaces are acquired.');
				const a = Context.get(first, TestWorkspace),
					b = Context.get(second, TestWorkspace);
				const dumpOptions = Schema.decodeUnknownOption(
					Schema.Struct({ loadDataDir: Schema.instanceOf(Blob) })
				);
				const images = create.mock.calls
					.flatMap(([options]) => {
						const decoded = dumpOptions(options);
						return Option.isSome(decoded) ? [decoded.value.loadDataDir] : [];
					})
					.slice(-2);
				expect(images).toHaveLength(2);
				expect(images[0]).toBe(images[1]);
				expect(images[0]).not.toBe(pristine);
				yield* a.db.write({
					text: 'UPDATE customers SET name = $1 WHERE id = $2',
					params: ['Changed', id]
				});
				expect(
					yield* b.db.rows(Schema.Struct({ name: Schema.String }), {
						text: 'SELECT name FROM customers',
						params: []
					})
				).toEqual([{ name: 'Beta' }]);
				const extended = {
					...manifest,
					models: {
						customers: {
							...manifest.models.customers,
							fields: {
								...manifest.models.customers.fields,
								marked: { kind: 'bool', default: false }
							}
						}
					}
				} satisfies EngineManifest;
				const changed = Context.get(
					yield* Layer.build(
						TestWorkspace.layer({
							manifest: extended,
							seed: { customers: [{ id, name: 'Gamma', marked: true }] }
						})
					),
					TestWorkspace
				);
				expect(
					yield* changed.db.rows(Schema.Struct({ name: Schema.String, marked: Schema.Boolean }), {
						text: 'SELECT name, marked FROM customers',
						params: []
					})
				).toEqual([{ name: 'Gamma', marked: true }]);
			}).pipe(Effect.ensuring(Effect.sync(() => create.mockRestore())));
		})
	)
);

layer(TestWorkspace.layer({ manifest }))('TestWorkspace', (it) => {
	it.effect('a caller commits through act, and a refused act fails with ActRefused', () =>
		Effect.gen(function* () {
			const t = yield* TestWorkspace;
			const created = yield* t.as(t.admin).act('customers.create', { name: 'Acme' });
			expect(created.kind).toBe('committed');
			const refused = yield* Effect.flip(
				t.as(t.member(['reader'])).act('customers.create', { name: 'Beta' })
			);
			expect(refused).toBeInstanceOf(ActRefused);
			expect(refused).toMatchObject({ _tag: 'ActRefused', code: 'forbidden' });
		})
	);

	it.effect('an act exposes only its Effect and fails with the original refusal', () =>
		Effect.gen(function* () {
			const t = yield* TestWorkspace;
			const act = t.as(t.member(['reader'])).act('customers.create', { name: 'Beta' });
			expect(Effect.isEffect(act)).toBe(true);
			expect('then' in act).toBe(false);
			expect(yield* Effect.flip(act)).toMatchObject({ _tag: 'ActRefused', code: 'forbidden' });
		})
	);
});
