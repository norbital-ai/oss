import { randomUUID } from 'node:crypto';
import { expect, it } from '@effect/vitest';
import { Context, Effect, Layer, Schema } from 'effect';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { Automations, Callables } from '../src/engine/services.ts';
import { TestWorkspace } from '../../bolt-cli/src/test/index.ts';
import { manifest as base } from './write-fixture.ts';
import { program } from '../../bolt-cli/src/test/guest.ts';

const READABLE = '0199a000-0000-7000-8000-000000000001';
const HIDDEN = '0199a000-0000-7000-8000-000000000002';
const UNREADY = '0199a000-0000-7000-8000-000000000003';
const MISSING = '0199a000-0000-7000-8000-000000000004';
const manifest: EngineManifest = {
	...base,
	models: {
		documents: {
			description: 'Start admission documents',
			record_label: 'record.title',
			fields: { title: { kind: 'text' }, visible: { kind: 'bool' }, ready: { kind: 'bool' } }
		}
	},
	relationships: {},
	exposures: { documents: { outputs: { default: { documents: { fields: 'all' } } } } },
	policies: {
		starter: {
			description: 'Start with a readable document',
			capabilities: { automations: ['inspect'] },
			grants: {
				documents: { outputs: { default: { scopes: { documents: { visible: { eq: true } } } } } }
			}
		}
	},
	teams: {},
	automations: {
		inspect: {
			description: 'Inspect the admitted document after dequeue',
			input: { document: { kind: 'ref', to: 'documents', where: { ready: { eq: true } } } },
			output: { kind: 'text' },
			policies: ['starter']
		}
	}
};
const guest = program(`export default { automation: { inspect: { body: function* (input, ctx) {
	const { documents } = yield* ctx.query({ documents: { where: { id: { eq: input.document } } } });
	return documents.rows[0]?.title;
} } } };`);
const fixture = Effect.gen(function* () {
	const context = yield* Layer.build(
		TestWorkspace.layer({
			manifest,
			guest: yield* guest,
			now: '2026-10-25T08:00:00.000Z',
			seed: {
				documents: [
					{ id: READABLE, title: 'Readable', visible: true, ready: true },
					{ id: HIDDEN, title: 'Hidden', visible: false, ready: true },
					{ id: UNREADY, title: 'Unready', visible: true, ready: false }
				]
			}
		})
	);
	const t = Context.get(context, TestWorkspace);
	const calls = Context.get(context, Callables);
	const authority = (yield* t.as(t.member(['starter']))).authority;
	const start = (runs: Parameters<typeof calls.start>[0]['runs']) =>
		calls.start({
			automation: 'inspect',
			runs,
			authority,
			bindings: { now: t.clock.now(), today: t.clock.now().slice(0, 10), tz: 'UTC' }
		});
	const count = t.db.value(Schema.Number, {
		text: "select count(*)::int from sys_run where automation='inspect'",
		params: []
	});
	const run = (id: string) =>
		t.db.rows(
			Schema.Struct({
				state: Schema.String,
				input: Schema.Json,
				output: Schema.Json
			}),
			{
				text: 'select state,input,output from sys_run where id=$1',
				params: [id]
			}
		);
	return { t, start, count, run };
});

it.live('start admits a readable id and queues the automation until its run is executed', () =>
	Effect.scoped(
		Effect.gen(function* () {
			const f = yield* fixture;
			const id = randomUUID();
			expect(yield* f.start([{ id, input: { document: READABLE } }])).toMatchObject({
				kind: 'committed'
			});
			expect(yield* f.run(id)).toEqual([
				{
					state: 'queued',
					input: { document: READABLE },
					output: null
				}
			]);
			yield* f.t.run_due();
			expect(yield* f.run(id)).toEqual([
				{
					state: 'succeeded',
					input: { document: READABLE },
					output: 'Readable'
				}
			]);
			expect(yield* f.count).toBe(1);
		})
	)
);

it.live('start refuses hidden, missing and id.where-mismatched references without enqueueing', () =>
	Effect.scoped(
		Effect.gen(function* () {
			const f = yield* fixture;
			for (const document of [HIDDEN, MISSING, UNREADY]) {
				const id = randomUUID();
				expect(yield* f.start([{ id, input: { document } }])).toMatchObject({
					kind: 'refused',
					code: 'not_found',
					field: 'document',
					message: 'No readable documents has this id.'
				});
				expect(yield* f.run(id)).toEqual([]);
				expect(yield* f.count).toBe(0);
			}
		})
	)
);

it.live('an invalid reference in a bulk start prevents every run from enqueueing', () =>
	Effect.scoped(
		Effect.gen(function* () {
			const f = yield* fixture;
			const readable = randomUUID(),
				invalid = randomUUID();
			expect(
				yield* f.start([
					{ id: readable, input: { document: READABLE } },
					{ id: invalid, input: { document: UNREADY } }
				])
			).toMatchObject({ kind: 'refused', code: 'not_found', field: 'document' });
			expect(yield* f.run(readable)).toEqual([]);
			expect(yield* f.run(invalid)).toEqual([]);
			expect(yield* f.count).toBe(0);
			expect(yield* f.start([{ id: readable, input: { document: READABLE } }])).toMatchObject({
				kind: 'committed'
			});
			expect(yield* f.count).toBe(1);
		})
	)
);

it.live('a cached call returns its value without a queued run and expires by its declared lifetime', () =>
	Effect.scoped(Effect.gen(function* () {
		const context = yield* Layer.build(TestWorkspace.layer({
			manifest: {
				...manifest,
				integrations: { crm: { description: 'Quote source', driver: 'http', http: { base_url: 'https://quotes.test' } } },
				policies: { starter: { description: 'Calls quotes', grants: {}, capabilities: { automations: ['quote'] } } },
				automations: { quote: {
					description: 'Cached quote', mode: 'call', cache: '30s', policies: ['starter'],
					input: { symbol: { kind: 'text' } }, output: { kind: 'int' }
				} }
			},
			guest: yield* program(`export default { automation: { quote: { body: function* (input, ctx) {
				return yield* ctx.request('crm', {method:'GET',path:'/quote',query:{symbol:input.symbol},output:{kind:'int'}});
			} } } };`),
			now: '2026-10-25T08:00:00.000Z',
			seed: { sys_integration: [{ id: 'crm', integration: 'crm', name: 'Quotes' }] }
		}));
		const t = Context.get(context, TestWorkspace),
			automations = Context.get(context, Automations),
			calls = Context.get(context, Callables),
			authority = (yield* t.as(t.member(['starter']))).authority;
		let requests = 0;
		t.fakes.links.answer = () => Effect.sync(() => ({ status: 200, body: ++requests }));
		const call = (symbol: string) => automations.call({
			automation: 'quote', input: { symbol }, authority,
			bindings: { now: t.clock.now(), today: '2026-10-25', tz: 'UTC' }
		}).pipe(Effect.provide(context));
		expect(yield* call('SGD')).toMatchObject({ kind: 'committed', output: 1, records: [] });
		expect(yield* call('SGD')).toMatchObject({ kind: 'committed', output: 1 });
		expect(requests).toBe(1);
		expect(yield* call('MYR')).toMatchObject({ kind: 'committed', output: 2 });
		t.clock.advance('31s');
		expect(yield* call('SGD')).toMatchObject({ kind: 'committed', output: 3 });
		expect(yield* calls.start({
			automation: 'quote', runs: [{ id: randomUUID(), input: { symbol: 'SGD' } }],
			authority, bindings: { now: t.clock.now(), today: '2026-10-25', tz: 'UTC' }
		})).toMatchObject({ kind: 'refused', code: 'invalid_input' });
		expect(yield* t.db.value(Schema.Number, {
			text: "SELECT count(*)::int FROM sys_run WHERE automation='quote'", params: []
		})).toBe(0);
	}))
);
