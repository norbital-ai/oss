// A write callback's workspace read answers a model's computed (generated stored) fields, as its typed Row promises.
import { Context, Effect, Layer, Schema } from 'effect';
import { expect, it } from '@effect/vitest';
import { TestWorkspace } from '../../bolt-cli/src/test/index.ts';
import { program } from '../../bolt-cli/src/test/guest.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import type { Json } from '../src/decl/values.ts';
import { manifest as base, NOW } from './write-fixture.ts';

const manifest: EngineManifest = {
	...base,
	models: {
		prices: {
			description: 'A price',
			record_label: 'record.name',
			fields: { name: { kind: 'text' }, amount: { kind: 'int' } },
			computed: { doubled: { kind: 'int', expr: { times: [{ field: 'amount' }, 2] } } }
		},
		quotes: { description: 'A quote', record_label: 'record.title', fields: { title: { kind: 'text' }, note: { kind: 'text' } } }
	},
	relationships: {},
	exposures: {
		prices: { outputs: { default: { prices: { fields: 'all' } } } },
		quotes: { outputs: { default: { quotes: { fields: 'all' } } }, create: { columns: { quotes: ['title'] }, transform: true } }
	},
	policies: {}
};
/** An act map over this file's models, which the type registry does not name. */
const untyped = (acts: { readonly [callable: string]: Json }) => acts;
const guest = program(`export default { model: { quotes: { bodies: {
	create: function* (changes, ctx) {
		const { prices } = yield* ctx.query({ prices: {} });
		return changes.map(({ set }) => ({ ...set, note: String(prices.rows[0].doubled) }));
	}
} } } };`);

it.live('a write callback reads computed fields through an unscoped read', () =>
	Effect.scoped(
		Effect.gen(function* () {
			const context = yield* Layer.build(
				TestWorkspace.layer({
					manifest,
					guest: yield* guest,
					transforms: ['quotes.create'],
					now: NOW,
					seed: { prices: [{ id: '00000000-0000-4000-8000-000000000001', name: 'base', amount: 21 }] }
				})
			);
			const t = Context.get(context, TestWorkspace);
			const admin = yield* t.as(t.admin);
			expect((yield* admin.act(untyped({ 'quotes.create': [{ title: 'q' }] }))).kind).toBe('committed');
			expect(yield* t.db.value(Schema.String, { text: 'SELECT note FROM quotes', params: [] })).toBe('42');
		})
	)
);
