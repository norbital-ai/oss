import { randomUUID } from 'node:crypto';
import { expect, it } from '@effect/vitest';
import { Context, Effect, Layer, Schema } from 'effect';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { Callables } from '../src/engine/services.ts';
import { TestWorkspace } from '../src/test/index.ts';
import { manifest as base } from './write-fixture.ts';
import { program } from '../src/test/guest.ts';

const READABLE = '0199a000-0000-7000-8000-000000000001';
const HIDDEN = '0199a000-0000-7000-8000-000000000002';
const UNREADY = '0199a000-0000-7000-8000-000000000003';
const MISSING = '0199a000-0000-7000-8000-000000000004';
const manifest: EngineManifest = {
	...base,
	models: {
		documents: {
			description: 'Start admission documents',
			label: 'title',
			fields: { title: { kind: 'text' }, visible: { kind: 'bool' }, ready: { kind: 'bool' } }
		}
	},
	relationships: {},
	exposures: { documents: { read: { documents: { fields: 'all' } } } },
	policies: {
		starter: {
			description: 'Start with a readable document',
			automations: ['inspect'],
			grants: { documents: { read: { documents: { where: { visible: { eq: true } } } } } }
		}
	},
	teams: {},
	automations: {
		inspect: {
			description: 'Inspect the admitted document after dequeue',
			input: { document: { kind: 'id', of: 'documents', where: { ready: { eq: true } } } },
			runAs: 'trigger'
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
	const authority = t.as(t.member(['starter'])).authority;
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
			yield* f.t.runDue();
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
					code: 'notFound',
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
			).toMatchObject({ kind: 'refused', code: 'notFound', field: 'document' });
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
