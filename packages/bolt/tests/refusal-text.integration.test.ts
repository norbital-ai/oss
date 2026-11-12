// An authored refusal leaves the guest as its catalogue key and values; the engine renders it with the workspace
// catalogue (the path `ctx.t` takes), so a refused act, a policy verdict and a failed run all read the text.
import { expect, layer } from '@effect/vitest';
import { Effect, Layer, Schema } from 'effect';
import { message_text } from '../src/decl/errors/refusal.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { randomUUID } from 'node:crypto';
import type { Json } from '../src/decl/values.ts';
import { Callables } from '../src/engine/services.ts';
import { TestWorkspace } from '../../bolt-cli/src/test/index.ts';
import { program } from '../../bolt-cli/src/test/guest.ts';

const manifest = {
	workspace: { tz: 'UTC', locale: 'en' },
	messages: {
		'errors.short': 'Only {have} of {need} {item} are in stock.',
		'errors.closed': 'Quotes are closed.'
	},
	models: {
		quotes: {
			description: 'A quote',
			record_label: 'record.title',
			fields: { title: { kind: 'text' } }
		}
	},
	relationships: {},
	exposures: {
		quotes: {
			outputs: { default: { quotes: { fields: 'all' } } },
			create: { columns: { quotes: ['title'] } }
		}
	},
	policies: {
		ops: {
			description: 'Ops',
			grants: { quotes: { outputs: { default: {} }, create: { verdict: true } } },
			capabilities: { automations: ['restock'] }
		}
	},
	teams: {},
	automations: { restock: { description: 'Restocks', policies: ['ops'] } },
	mcp: {},
	apps: {},
	custom_fields: {},
	integrations: {},
	agent: { skills: {} },
	needs: []
} satisfies EngineManifest;
const source = `export default {
	policy: { ops: { grants: { quotes: { create: { verdict: function* (changes, ctx) {
		const row = changes.findIndex((c) => c.after.title === 'short');
		return row < 0 ? ctx.allow() : yield* ctx.refuse('errors.short', { row, values: { have: 1, need: 3, item: 'bolts' } });
	} } } } } },
	model: { quotes: { bodies: { create: function* (changes, ctx) {
		return changes.some((c) => c.after.title === 'late')
			? yield* ctx.refuse('errors.closed', { field: 'title' })
			: changes.map((c) => c.set);
	} } } },
	automation: { restock: { body: function* (input, ctx) {
		return yield* ctx.refuse('errors.short', { values: { have: 0, need: 2, item: 'nuts' } });
	} } }
};`;
const Fixture = Layer.unwrap(
	Effect.map(program(source), (guest) =>
		TestWorkspace.layer({ manifest, guest, transforms: ['quotes.create'], now: '2026-11-12T08:00:00.000Z' })
	)
);

layer(Fixture, { excludeTestServices: true })('refusal text', (it) => {
	it.effect('fills a message from the catalogue; an unknown key is itself and an unfilled placeholder stays', () =>
		Effect.sync(() => {
		expect(message_text(manifest.messages, 'errors.short', { have: 1, need: 3, item: 'bolts' })).toBe(
			'Only 1 of 3 bolts are in stock.'
		);
		expect(message_text(manifest.messages, 'errors.short', { have: 1 })).toBe(
			'Only 1 of {need} {item} are in stock.'
		);
		expect(message_text(undefined, 'errors.gone')).toBe('errors.gone');
		})
	);

	it.effect('a refused act reads the rendered text, with its key and values beside it', () =>
		Effect.gen(function* () {
			const t = yield* TestWorkspace;
			const ops = yield* t.as(t.member(['ops']));
			// this file's names index is the type corpus's: the fixture's callables are a runtime-indexed map
			const short: Record<string, Json> = { 'quotes.create': [{ title: 'ok' }, { title: 'short' }] },
				late: Record<string, Json> = { 'quotes.create': [{ title: 'late' }] };
			expect(yield* Effect.flip(ops.act(short))).toMatchObject({
				_tag: 'ActRefused',
				code: 'refused',
				message: 'Only 1 of 3 bolts are in stock.',
				key: 'errors.short',
				values: { have: 1, need: 3, item: 'bolts' },
				rule: 'ops.quotes.create',
				row: 1
			});
			expect(yield* Effect.flip(ops.act(late))).toMatchObject({
				message: 'Quotes are closed.',
				key: 'errors.closed',
				field: 'title'
			});
		})
	);

	it.effect('a refused run stores and reports the rendered text', () =>
		Effect.gen(function* () {
			const t = yield* TestWorkspace;
			const ops = yield* t.as(t.member(['ops']));
			yield* (yield* Callables).start({
				automation: 'restock',
				runs: [{ id: randomUUID(), input: {} }],
				authority: ops.authority,
				bindings: { now: t.clock.now(), today: t.clock.now().slice(0, 10), tz: 'UTC' }
			});
			const { failed } = yield* t.run_due();
			expect(failed).toMatchObject([{ automation: 'restock', error: 'Only 0 of 2 nuts are in stock.' }]);
			expect(
				yield* t.db.rows(Schema.Struct({ code: Schema.String }), {
					text: `SELECT error->>'code' AS code FROM sys_run WHERE automation = 'restock'`,
					params: []
				})
			).toEqual([{ code: 'refused' }]);
		})
	);
});
