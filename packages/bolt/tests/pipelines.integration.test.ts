// engine/pipelines on PGlite: one guarantee per test (§3.3.5, rule 30): crm's ERP item import and a CSV export.
import { describe, expect, it } from '@effect/vitest';
import { Context, Effect, Layer, Option, Schema } from 'effect';
import type { Json } from '../src/decl/values.ts';
import type { Outcome } from '../src/engine/contracts.ts';
import type { Holder } from '../src/engine/access/authority.ts';
import { Callables, Pipelines, Reads, RunHandlers } from '../src/engine/services.ts';
import { upload } from '../src/engine/callables/upload.ts';
import { readableFile } from '../src/engine/decisions/index.ts';
import { randomUUID } from 'node:crypto';
import { TestWorkspace } from '../src/test/index.ts';
import { program } from './support/guest-fixture.ts';
import { actReply, qReply, routeFixture } from './support/route-fixture.ts';
import { guestSource, manifest } from './catalogue-fixture.ts';

const NOW = '2026-09-25T10:00:00.000Z';
const guest = program(guestSource);
const ok = (o: Outcome) => {
	if (o.kind !== 'committed') throw new Error(JSON.stringify(o));
	return o;
};
const required = <T>(value: T | undefined): T => {
	if (value === undefined) throw new Error('fixture value missing');
	return value;
};
const FileId = Schema.Struct({ id: Schema.String });
const setup = () =>
	Effect.gen(function* () {
		const context = yield* Layer.build(
			TestWorkspace.layer({ manifest, guest: yield* guest, now: NOW })
		);
		const t = Context.get(context, TestWorkspace),
			route = yield* routeFixture(context),
			feeds = Context.get(context, Pipelines);
		const stored = t.fakes.files.blobs;
		const bindings = () => ({ now: NOW, today: NOW.slice(0, 10), tz: 'UTC', params: {} });
		const sales = t.as(t.member(['sales'])).authority;
		const caller = (key: string) => ({
			authority: sales,
			bindings: bindings(),
			key,
			issuedAt: NOW
		});
		const act = (callable: string, input: Json) =>
			actReply(route, sales, { callable, input, issuedAt: NOW }).pipe(
				Effect.map((reply) => reply.outcome)
			);
		const read = () =>
			qReply(route, sales, {
				reads: [{ m: 'read', a: ['products', { all: true, orderBy: 'external_code' }] }]
			}).pipe(
				Effect.flatMap((reply) =>
					Schema.decodeUnknownEffect(
						Schema.Struct({ rows: Schema.Array(Schema.Record(Schema.String, Schema.Json)) })
					)(reply.answers[0])
				)
			);
		const put = (who: Holder, body: Json, mime = 'application/json') =>
			upload({
				id: randomUUID(),
				collection: 'products',
				field: '$import',
				name: 'feed.json',
				mime,
				bytes: new TextEncoder().encode(JSON.stringify(body)),
				authority: t.as(who).authority,
				now: NOW
			}).pipe(Effect.provide(context));
		const fileId = (o: Outcome) =>
			Schema.decodeUnknownEffect(FileId)(ok(o).output).pipe(Effect.map((file) => file.id));
		const runAs = (starter: Holder, input: Json) =>
			Effect.gen(function* () {
				const handler = yield* Context.get(context, RunHandlers).handler('products.pipeline');
				if (Option.isNone(handler)) throw new Error('products.pipeline handler missing');
				return yield* handler
					.value(input, { id: randomUUID(), starter })
					.pipe(Effect.provide(context));
			});
		const may = (who: Holder, id: string) =>
			readableFile(
				{
					manifest,
					db: t.db,
					read: Context.get(context, Reads).run,
					authority: t.as(who).authority,
					bindings: bindings()
				},
				id,
				'products.$export'
			);
		const start = (who: Holder, input: Json) =>
			Context.get(context, Callables).start({
				automation: 'products.pipeline',
				runs: [{ id: randomUUID(), input }],
				authority: t.as(who).authority,
				bindings: bindings()
			});
		return { t, feeds, stored, caller, act, read, put, fileId, runAs, may, start };
	});

describe('pipelines: import and export feeds', () => {
	it.live(
		"crm's ERP item import: one act as the caller, codes already on file skipped by known + map",
		() =>
			Effect.gen(function* () {
				const { t, feeds, caller, act, read } = yield* setup();
				ok(yield* act('products.create', { external_code: 'P1', name: 'kept', price: '1.00' }));
				t.count.reset();
				const imported = yield* feeds.import(
					'products',
					{
						items: [
							{ external_code: ' P1 ', name: 'renamed' },
							{ external_code: 'P2', name: ' bolt ', unit_price: '2.50' }
						]
					},
					caller('k1'),
					{}
				);
				if (!imported.applied) throw new Error(JSON.stringify(imported));
				const o = ok(imported.outcome);
				expect(t.count.writes).toBe(1);
				expect(o.records).toHaveLength(1);
				const rows = (yield* read()).rows;
				expect(rows.map((r) => [r['external_code'], r['name'], r['price']])).toEqual([
					['P1', 'kept', { $dec: '1.00' }],
					['P2', 'bolt', { $dec: '2.50' }]
				]);
			})
	);

	it.live('an import is refused as the caller would be refused', () =>
		Effect.gen(function* () {
			const { t, feeds, caller } = yield* setup();
			const reader = { ...caller('k2'), authority: t.as(t.member(['viewer'])).authority };
			expect(
				yield* feeds.import('products', { items: [{ external_code: 'P9', name: 'x' }] }, reader, {})
			).toMatchObject({
				applied: false,
				findings: [{ row: null, severity: 'refuse', message: expect.stringContaining('may not') }]
			});
		})
	);

	it.live(
		'an export is every row the caller reads, the declared fields, stored as a CSV file',
		() =>
			Effect.gen(function* () {
				const { feeds, stored, caller, act } = yield* setup();
				ok(
					yield* act('products.create', [
						{ external_code: 'P1', name: 'a, "quoted"', price: '1.00' },
						{ external_code: 'P2', name: 'b' }
					])
				);
				expect(yield* feeds.export('products', caller('x'))).toMatchObject({
					name: 'products-2026-09-25.csv',
					file: { mime: 'text/csv' }
				});
				const [head, ...lines] = new TextDecoder()
					.decode(required([...stored.values()][0]))
					.split('\r\n');
				expect([head, ...lines.sort()]).toEqual([
					'external_code,name,price',
					'P1,"a, ""quoted""",1.00',
					'P2,b,'
				]);
			})
	);

	it.live(
		'an uploaded feed file runs as products.pipeline under its starter: one act, the rows as the caller wrote them',
		() =>
			Effect.gen(function* () {
				const { t, read, put, fileId, runAs } = yield* setup();
				const who = t.member(['sales']);
				const file = yield* fileId(
					yield* put(who, { items: [{ external_code: 'P7', name: 'bolt', unit_price: '2.50' }] })
				);
				expect(yield* runAs(who, { mode: 'import', file })).toEqual({
					applied: true,
					created: 1,
					updated: 0,
					deleted: 0,
					findings: []
				});
				const [row] = (yield* read()).rows;
				expect(row).toMatchObject({
					external_code: 'P7',
					name: 'bolt',
					price: { $dec: '2.50' },
					created_by: who.id
				});
			})
	);

	it.live(
		"a feed file is its uploader's alone, is JSON, and decodes against the import's declared input",
		() =>
			Effect.gen(function* () {
				const { t, put, fileId, runAs, read } = yield* setup();
				const who = t.member(['sales']);
				const mine = yield* fileId(yield* put(who, { items: [] }));
				expect(
					yield* runAs(t.member(['sales']), { mode: 'import', file: mine }).pipe(Effect.flip)
				).toMatchObject({ code: 'notFound' });
				expect(
					yield* runAs(who, {
						mode: 'import',
						file: yield* fileId(yield* put(who, { items: [{ name: 'no code' }] }))
					})
				).toMatchObject({
					applied: false,
					findings: [
						{ row: null, column: 'external_code', message: 'is required', severity: 'refuse' }
					]
				});
				expect((yield* read()).rows).toEqual([]);
				expect(yield* put(who, {}, 'text/csv')).toMatchObject({
					kind: 'refused',
					code: 'invalidInput'
				});
				expect(yield* put(t.member(['viewer']), {})).toMatchObject({
					kind: 'refused',
					code: 'forbidden'
				});
			})
	);

	it.live(
		"an export run stores the file as its starter's and answers its FileRef, which no other member downloads",
		() =>
			Effect.gen(function* () {
				const { t, stored, act, runAs, may } = yield* setup();
				ok(yield* act('products.create', { external_code: 'P1', name: 'a', price: '1.20' }));
				const who = t.member(['viewer']);
				const out = yield* Schema.decodeUnknownEffect(
					Schema.Struct({
						file: Schema.Struct({
							id: Schema.String,
							name: Schema.String,
							mime: Schema.String,
							bytes: Schema.Number,
							sha256: Schema.String
						})
					})
				)(yield* runAs(who, { mode: 'export' }));
				expect(out.file).toMatchObject({ name: 'products-2026-09-25.csv', mime: 'text/csv' });
				expect(new TextDecoder().decode(required([...stored.values()][0]))).toContain('P1,a,1.20');
				expect([
					yield* may(who, out.file.id),
					yield* may(t.member(['viewer']), out.file.id)
				]).toEqual([true, false]);
			})
	);

	it.live(
		'starting products.pipeline is gated by the collection grant (import: create, export: read) and records the starter',
		() =>
			Effect.gen(function* () {
				const { t, start } = yield* setup();

				expect(yield* start(t.member(['viewer']), { mode: 'import', file: 'f' })).toMatchObject({
					kind: 'refused',
					code: 'forbidden'
				});
				expect(yield* start(t.member(['integration']), { mode: 'export' })).toMatchObject({
					kind: 'refused',
					code: 'forbidden'
				});
				expect(yield* start(t.member(['sales']), { mode: 'import', file: 'f' })).toMatchObject({
					kind: 'committed'
				});
				expect(yield* start(t.member(['viewer']), { mode: 'export' })).toMatchObject({
					kind: 'committed'
				});
				const rows = yield* t.db.rows(
					Schema.Struct({ starter: Schema.Struct({ policies: Schema.Array(Schema.String) }) }),
					{ text: `SELECT starter FROM sys_run WHERE automation = 'products.pipeline'`, params: [] }
				);
				expect(rows.map((r) => r.starter.policies).sort()).toEqual([['sales'], ['viewer']]);
			})
	);
});
