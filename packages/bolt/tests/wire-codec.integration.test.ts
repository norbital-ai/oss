// The one wire shape per kind (D6, std/wire), both ways: a decimal is `{ $dec }`, a date and an instant their ISO text,
// a period `{ from, to }` / `{ start, end }` of those. An act takes exactly what q, live, the callback's `before` and
// `ctx.db.query`, an aggregate and a seed load give back.
import { dec } from '@norbital-ai/std/decimal';
import { describe, expect, it } from '@effect/vitest';
import { Context, Deferred, Effect, Layer, Queue, Schema, Stream } from 'effect';
import type { Json } from '../src/decl/values.ts';
import type { ActOutcome as Outcome } from '../src/engine/contracts.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { catalogOf } from '../src/engine/access/pred.ts';
import { lowerRead } from '../src/engine/index.ts';
import { aggregate } from '@norbital-ai/store';
import type { Frame } from '../src/protocol/wire.ts';
import { fromStore } from '../src/protocol/errors.ts';
import { TestWorkspace, type TestOptions } from '../src/test/index.ts';
import { Live, Reads } from '../src/engine/services.ts';
import { actReply, qReply, routeFixture } from './support/route-fixture.ts';
import { program } from './support/guest-fixture.ts';

const columns = ['name', 'amount', 'day', 'at', 'span', 'slot', 'notes'];
const manifest = {
	workspace: { tz: 'UTC', locale: 'en' },
	models: {
		items: {
			description: 'An item',
			label: 'name',
			fields: {
				name: { kind: 'text' },
				amount: { kind: 'decimal', scale: 2 },
				day: { kind: 'date' },
				at: { kind: 'instant' },
				span: { kind: 'period', of: 'date' },
				slot: { kind: 'period', of: 'instant', optional: true },
				notes: { kind: 'json', optional: true },
				seen: { kind: 'json', optional: true }
			}
		}
	},
	relationships: {},
	exposures: {
		items: {
			read: { items: { fields: 'all' } },
			create: { columns: { items: columns } },
			update: { columns: { items: columns } }
		}
	},
	integrations: {},
	policies: {},
	teams: {},
	automations: {},
	connections: {},
	envoys: {},
	mcp: {},
	apps: {},
	customFields: {},
	agent: { skills: {} }
} satisfies EngineManifest;

/** An update callback records the stored row beside its set and through one batched workspace query. */
const guest =
	program(`export default { model: { items: { bodies: { update: function* (changes, ctx) {
	const shape = (r) => r === null ? null : { amount: String(r.amount), day: r.day, at: r.at, span: r.span, slot: r.slot };
	const { items: page } = yield* ctx.db.query({ items: { where: { id: { in: changes.map(({ before }) => before.id) } } } });
	const rows = new Map(page.rows.map((row) => [row.id, row]));
	return changes.map(({ before, set }) => ({ ...set, seen: { before: shape(before), query: shape(rows.get(before.id) ?? null) } }));
} } } } };`);

const input = {
	name: 'a',
	amount: { $dec: '1.50' },
	day: '2026-01-02',
	at: '2026-01-02T03:04:05.000Z',
	span: { from: '2026-01-01', to: null },
	slot: { start: '2026-01-02T09:00:00.000Z', end: null },
	notes: { price: '2.00', on: '2026-03-01' }
} satisfies { readonly [field: string]: Json };
const ID = '0199a000-0000-7000-8000-0000000000a1';
const committed = (o: Outcome) => {
	if (o.kind !== 'committed') throw new Error(JSON.stringify(o));
	return o;
};

const Row = Schema.Record(Schema.String, Schema.Json);
const open = Effect.fn('Test.wireCodec')(function* (
	options: Omit<Extract<TestOptions, { artifact?: never }>, 'manifest' | 'guest'> = {},
	transformed = false
) {
	const context = yield* Layer.build(
		TestWorkspace.layer({
			manifest,
			...options,
			...(transformed
				? {
						manifest: {
							...manifest,
							exposures: {
								items: {
									...manifest.exposures.items,
									update: { ...manifest.exposures.items.update, transform: true }
								}
							}
						},
						guest: yield* guest,
						transforms: ['items.update']
					}
				: {})
		})
	);
	const t = Context.get(context, TestWorkspace),
		route = yield* routeFixture(context),
		authority = t.as(t.admin).authority;
	const act = (callable: string, value: Json) =>
		actReply(route, authority, { callable, input: value, issuedAt: t.clock.now() }).pipe(
			Effect.map((reply) => reply.outcome)
		);
	const get = (id: string) =>
		qReply(route, authority, {
			reads: [{ m: 'query', a: [{ items: { where: { id: { eq: id } } } }] }]
		}).pipe(
			Effect.flatMap((reply) =>
				Schema.decodeUnknownEffect(Schema.Struct({ items: Schema.Struct({ rows: Schema.Array(Row) }) }))(
					reply.answers[0]
				)
			),
			Effect.map((answer) => answer.items.rows[0] ?? null)
		);
	return { t, context, authority, act, get };
});
const createdId = (outcome: Outcome) => {
	const first = committed(outcome).records[0];
	if (first === undefined) throw new Error('The create returned no record');
	return first.id;
};

describe('wire codec: one shape per kind, both ways (D6)', () => {
	it.live('date both ways: q gives back exactly what act took and the read row goes back in', () =>
		Effect.gen(function* () {
			const a = yield* open({}, true);
			const id = createdId(yield* a.act('items.create', [input]));
			const row = yield* a.get(id);
			if (row === null) throw new Error('Missing created row');
			expect(row).toMatchObject(input);
			committed(
				yield* a.act('items.update', [{
					target: id,
					set: Object.fromEntries(columns.map((f) => [f, row[f] ?? null]))
				}])
			);
			expect(yield* a.get(id)).toMatchObject(input);
		})
	);
	it.live('the callback reads the same shapes through before and ctx.db.query', () =>
		Effect.gen(function* () {
			const a = yield* open({}, true);
			const id = createdId(yield* a.act('items.create', [input]));
			committed(yield* a.act('items.update', [{ target: id, set: { name: 'b' } }]));
			const shape = {
				amount: '1.50',
				day: input.day,
				at: input.at,
				span: input.span,
				slot: input.slot
			};
			expect((yield* a.get(id))?.['seen']).toEqual({ before: shape, query: shape });
		})
	);
	it.live('a live patch carries the shapes a read gives', () =>
		Effect.gen(function* () {
			const a = yield* open();
			const live = Context.get(a.context, Live);
			const frames: Frame[] = [],
				ready = yield* Deferred.make<string>(),
				received = yield* Queue.unbounded<Frame>();
			yield* live.connect(a.authority).pipe(
				Stream.runForEach((frame) =>
					Effect.sync(() => {
						frames.push(frame);
						Queue.offerUnsafe(received, frame);
						if (frame.t === 'hello') Deferred.doneUnsafe(ready, Effect.succeed(frame.conn));
					})
				),
				Effect.forkScoped
			);
			const conn = yield* Deferred.await(ready);
			const select = Object.fromEntries(columns.map((f) => [f, true]));
			yield* live.register(conn, 'items', {
				read: lowerRead(manifest, 'read', ['items', { all: true, select }])
			});
			committed(yield* a.act('items.create', [input]));
			yield* live.settled;
			let last = frames.filter((frame) => frame.t === 'patch').at(-1);
			while (last === undefined) {
				yield* Queue.take(received);
				last = frames.filter((frame) => frame.t === 'patch').at(-1);
			}
			expect(last.ops).toMatchObject([{ op: 'upsert', index: 0, row: input }]);
		})
	);
	it.live('an aggregate keys a date bucket by its ISO day and sums to `{ $dec }`', () =>
		Effect.gen(function* () {
			const a = yield* open({ seed: { items: [{ id: ID, ...input }] } });
			const reads = Context.get(a.context, Reads);
			const [page] = yield* reads.run(
				[
					yield* aggregate(catalogOf(manifest), 'items', {
						by: [{ month: 'day' }],
						count: true,
						sum: ['amount'],
						all: true
					}).pipe(Effect.mapError(fromStore))
				],
				{ as: 'workspace' },
				{ now: a.t.clock.now(), today: a.t.clock.now().slice(0, 10), tz: 'UTC' }
			);
			expect(page).toMatchObject({
				rows: [{ key: { day: '2026-01-01' }, count: 1, sum: { amount: { $dec: '1.50' } } }]
			});
		})
	);
	it.live('a seed pack written from std values loads back as the read shape', () =>
		Effect.gen(function* () {
			const row = Schema.decodeUnknownSync(Schema.fromJsonString(Row))(
				JSON.stringify({ id: ID, ...input, amount: dec('1.50') })
			);
			expect(row['amount']).toEqual({ $dec: '1.50' });
			const a = yield* open({ seed: { items: [row] } });
			expect(yield* a.get(ID)).toMatchObject(input);
		})
	);
});
