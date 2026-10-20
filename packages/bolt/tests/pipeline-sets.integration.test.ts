// engine/pipelines on PGlite: an import as a set over a scope (§3.3.5, rule 30). An xlsx upload by header, a template
// download, the scope's deletes in the same act under the collection's guards, and findings that refuse or wait.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from '@effect/vitest';
import { Context, Effect, Layer, Option, Result, Schema } from 'effect';
import type { Json } from '../src/decl/values.ts';
import type { Outcome } from '../src/engine/contracts.ts';
import type { Holder } from '../src/engine/access/authority.ts';
import { decodeManifest } from '../src/engine/manifest.ts';
import { RunHandlers } from '../src/engine/services.ts';
import { program } from './support/guest-fixture.ts';
import { actReply, qReply, routeFixture } from './support/route-fixture.ts';
import { xlsxCells, xlsxOf, type Cell } from '../src/engine/files/xlsx.ts';
import { upload } from '../src/engine/callables/upload.ts';
import { TestWorkspace } from '../src/test/index.ts';

const NOW = '2026-09-25T10:00:00.000Z';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const manifest = Result.getOrThrow(
	decodeManifest({
		workspace: { tz: 'UTC', locale: 'en' },
		models: {
			shifts: {
				description: 'A person-day',
				label: 'person',
				key: ['person', 'day'],
				fields: {
					person: { kind: 'text' },
					day: { kind: 'date' },
					hours: { kind: 'int', optional: true },
					locked: { kind: 'bool', default: false },
					status: {
						kind: 'state',
						initial: 'open',
						states: { open: { to: ['paid'] }, paid: { edit: 'none' } }
					}
				}
			},
			leave_codes: {
				description: 'A leave class',
				label: 'code',
				key: ['code'],
				fields: { code: { kind: 'text' } }
			},
			days_off: {
				description: 'A day of leave',
				label: 'person',
				fields: { person: { kind: 'text' }, day: { kind: 'date' }, leave: { kind: 'text' } }
			}
		},
		relationships: {},
		collections: {
			shifts: {
				read: { fields: 'all' },
				create: { input: { columns: ['person', 'day', 'hours', 'locked'] } },
				update: { input: { columns: ['hours', 'locked', 'status'] } },
				delete: { transform: true }
			},
			leave_codes: { read: { fields: 'all' }, create: { input: { columns: ['code'] } } },
			days_off: {
				read: { fields: 'all' },
				create: { input: { columns: ['person', 'day', 'leave'] } }
			}
		},
		integrations: {},
		pipelines: {
			shifts: {
				import: {
					description: 'The roster sheet: a set per person over the days it covers.',
					onConflict: 'update',
					check: true,
					template: true,
					known: true,
					related: { days_off: true },
					context: { site: { kind: 'text', optional: true } },
					scope: { by: ['person'], range: 'day', of: true },
					input: {
						rows: {
							kind: 'list',
							of: {
								kind: 'object',
								fields: {
									row: { kind: 'number' },
									person: { kind: 'text', label: 'Person' },
									day: { kind: 'date', label: 'Day' },
									hours: { kind: 'int', optional: true },
									leave: { kind: 'text', optional: true }
								}
							}
						}
					}
				}
			}
		},
		policies: {
			hr: {
				description: 'HR',
				grants: {
					shifts: { read: true, create: true, update: true, delete: true },
					leave_codes: { read: true },
					days_off: { read: true, create: true }
				}
			},
			shifts_only: {
				description: 'Shifts, no leave',
				grants: {
					shifts: { read: true, create: true, update: true, delete: true },
					leave_codes: { read: true },
					days_off: { read: true }
				}
			}
		},
		teams: {},
		automations: {},
		connections: {},
		envoys: {},
		mcp: {},
		apps: {},
		customFields: {},
		agent: { skills: {} }
	})
);
const source = `export default {
	collection: { shifts: { bodies: { transform: function* (inputs, ctx) { for (const [i, input] of inputs.entries()) {
		const before = ctx.existing[i];
		if (before?.locked && (input.$delete || ('hours' in input && (input.hours ?? null) !== (before.hours ?? null)))) yield* ctx.refuse(before.person + ' ' + before.day + ' is settled');
	} return inputs;
	} } } },
	pipeline: { shifts: { spec: { import: {
		records: (input) => input.rows,
		known: function* (ctx, records, { context }) { return { site: context.site ?? null, leave: Object.fromEntries((yield* ctx.read('leave_codes', { all: true })).rows.map((r) => [r.code, r.id])) }; },
		// a zero-hour row is a blank day: no row, but still in scope (so its stored day is deleted)
		map: (r, { known }) => r.hours === 0 ? null : ({ person: known.site === null ? r.person : known.site + '/' + r.person, day: r.day, hours: r.hours ?? null }),
		scope: { of: (r, { known }) => ({ person: known.site === null ? r.person : known.site + '/' + r.person, day: r.day }) },
		related: { days_off: (r, { known }) => r.leave === undefined ? [] : [{ person: r.person, day: r.day, leave: known.leave[r.leave] }] },
		check: function* (ctx, { records, rows, known }) { return [...rows.flatMap((r, i) => r === null || r.hours === null || r.hours <= 10 ? []
			: [{ row: records[i].row, column: 'hours', message: 'over ten hours', severity: r.hours > 24 ? 'refuse' : 'warn' }]),
			...records.flatMap((r) => r.leave === undefined || r.leave in known.leave ? [] : [{ row: r.row, column: 'leave', message: 'no such leave', severity: 'refuse' }])]; },
		template: function* (ctx, { context }) { return (yield* ctx.read('shifts', { all: true, orderBy: 'day' })).rows
			.filter((r) => context.site === undefined || r.person.startsWith(context.site + '/')).map((r) => ({ person: r.person, day: r.day, hours: r.hours })); },
	} } } },
};`;
const guest = program(source);
const ok = (o: Outcome) => {
	if (o.kind !== 'committed') throw new Error(JSON.stringify(o));
	return o;
};
const required = <T>(value: T | undefined): T => {
	if (value === undefined) throw new Error('fixture value missing');
	return value;
};
const setup = (invoked: (target: string) => void = () => {}) =>
	Effect.gen(function* () {
		const context = yield* Layer.build(
			TestWorkspace.layer({
				manifest,
				guest: yield* guest,
				transforms: ['shifts'],
				now: NOW,
				cpu: (invocation) => invoked(invocation.target)
			})
		);
		const t = Context.get(context, TestWorkspace),
			route = yield* routeFixture(context),
			who = t.member(['hr']);
		const authority = (holder: Holder) => t.as(holder).authority;
		const act = (callable: string, input: Json, holder: Holder = who) =>
			actReply(route, authority(holder), { callable, input, issuedAt: NOW }).pipe(
				Effect.map((reply) => reply.outcome)
			);
		const files = { stored: t.fakes.files.blobs };
		const read = (collection: string, options: Json = { all: true }) =>
			qReply(route, authority(who), { reads: [{ m: 'read', a: [collection, options] }] }).pipe(
				Effect.flatMap((reply) =>
					Schema.decodeUnknownEffect(
						Schema.Struct({ rows: Schema.Array(Schema.Record(Schema.String, Schema.Json)) })
					)(reply.answers[0])
				)
			);
		const run = (input: Json, starter: Holder = who) =>
			Effect.gen(function* () {
				const handler = yield* Context.get(context, RunHandlers).handler('shifts.pipeline');
				if (Option.isNone(handler)) throw new Error('shifts.pipeline handler missing');
				return yield* handler.value(input, { id: randomUUID(), starter });
			});
		const put = (cells: Cell[][], holder: Holder = who) =>
			upload({
				id: randomUUID(),
				collection: 'shifts',
				field: '$import',
				name: 'roster.xlsx',
				mime: XLSX,
				bytes: xlsxOf(cells),
				authority: authority(holder),
				now: NOW
			}).pipe(
				Effect.provide(context),
				Effect.flatMap((outcome) =>
					Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }))(ok(outcome).output)
				),
				Effect.map((file) => file.id)
			);
		const sheet = (cells: Cell[][], extra: { [key: string]: Json } = {}) =>
			Effect.gen(function* () {
				return yield* run({ mode: 'import', file: yield* put(cells), ...extra });
			});
		const seed = (rows: { person: string; day: string; hours?: number; locked?: boolean }[]) =>
			act('shifts.create', rows).pipe(Effect.map(ok));
		const shifts = () =>
			read('shifts', { all: true, orderBy: ['person', 'day'] }).pipe(
				Effect.map((page) =>
					page.rows.map((row) => [row['person'], row['day'], row['hours'] ?? null])
				)
			);
		return { t, who, act, files, read, run, put, sheet, seed, shifts };
	});

describe('pipeline import: xlsx, template, scope, findings', () => {
	it.live(
		'the template is the declared columns by label (the sheet row is its own) prefilled by the template query',
		() =>
			Effect.gen(function* () {
				const { files, run, seed } = yield* setup();
				yield* seed([{ person: 'ann', day: '2026-01-02', hours: 8 }]);
				const out = yield* Schema.decodeUnknownEffect(
					Schema.Struct({ file: Schema.Struct({ name: Schema.String, mime: Schema.String }) })
				)(yield* run({ mode: 'template' }));
				expect(out.file).toMatchObject({ name: 'shifts-template.xlsx', mime: XLSX });
				expect(xlsxCells(required([...files.stored.values()].at(-1)))).toEqual([
					['Person', 'Day', 'hours', 'leave'],
					['ann', '2026-01-02', 8]
				]);
			})
	);

	it.live(
		'an xlsx upload fills the list by header (any case, label or name); blank cells and rows are dropped, other columns ignored',
		() =>
			Effect.gen(function* () {
				const { sheet, shifts } = yield* setup();
				const out = yield* sheet([
					['person', 'DAY', 'hours', 'Note'],
					['ann', '2026-01-01', 8, 'x'],
					[null, '', null],
					['bob', '2026-01-01', '', 'y']
				]);
				expect(out).toEqual({ applied: true, created: 2, updated: 0, deleted: 0, findings: [] });
				expect(yield* shifts()).toEqual([
					['ann', '2026-01-01', 8],
					['bob', '2026-01-01', null]
				]);
			})
	);

	it.live(
		'ISO date cells use their written calendar day while invalid timestamps return row findings',
		() =>
			Effect.gen(function* () {
				const { sheet, shifts } = yield* setup();
				expect(
					yield* sheet([
						['Person', 'Day', 'hours'],
						['ann', '2026-06-03T00:00:00.000Z', 8],
						['bob', '2026-06-03T00:30:00+08:00', 8],
						['cy', '2026-06-03T23:30:00-08:00', 8],
						['dee', '2026-06-03T08:00:00', 8],
						['eve', 46176, 8]
					])
				).toEqual({ applied: true, created: 5, updated: 0, deleted: 0, findings: [] });
				const before = yield* shifts();
				expect(before).toEqual([
					['ann', '2026-06-03', 8],
					['bob', '2026-06-03', 8],
					['cy', '2026-06-03', 8],
					['dee', '2026-06-03', 8],
					['eve', '2026-06-03', 8]
				]);
				expect(
					yield* sheet([
						['Person', 'Day', 'hours'],
						['ann', 'not-a-date', 7],
						['bob', '2026-02-30T00:00:00Z', 7],
						['cy', '2026-06-03T25:00:00Z', 7]
					])
				).toMatchObject({
					applied: false,
					findings: [
						{ row: 2, column: 'Day', severity: 'refuse' },
						{ row: 3, column: 'Day', severity: 'refuse' },
						{ row: 4, column: 'Day', severity: 'refuse' }
					]
				});
				expect(yield* shifts()).toEqual(before);
			})
	);

	it.live(
		'a set over the scope: per person, the days from first to last the file leaves out are deleted, in one statement',
		() =>
			Effect.gen(function* () {
				const { t, run, put, seed, shifts } = yield* setup();
				yield* seed([
					{ person: 'ann', day: '2026-01-01', hours: 8 },
					{ person: 'ann', day: '2026-01-02', hours: 8 },
					{ person: 'ann', day: '2026-01-03', hours: 8 },
					{ person: 'ann', day: '2026-01-09', hours: 8 },
					{ person: 'bob', day: '2026-01-02', hours: 8 }
				]);
				const file = yield* put([
					['Person', 'Day', 'hours'],
					['ann', '2026-01-01', 8],
					['ann', '2026-01-03', 6]
				]);
				t.count.reset();
				const out = yield* run({ mode: 'import', file });
				expect(out).toEqual({ applied: true, created: 0, updated: 1, deleted: 1, findings: [] });
				expect(t.count.writes).toBe(1);
				expect(yield* shifts()).toEqual([
					['ann', '2026-01-01', 8],
					['ann', '2026-01-03', 6],
					['ann', '2026-01-09', 8],
					['bob', '2026-01-02', 8]
				]);
			})
	);

	it.live('the scope of N records is one guest invocation, as map is', () =>
		Effect.gen(function* () {
			const targets: string[] = [];
			const { sheet } = yield* setup((target) => targets.push(target));
			const out = yield* sheet([
				['Person', 'Day', 'hours'],
				['ann', '2026-01-01', 8],
				['ann', '2026-01-02', 0],
				['bob', '2026-01-01', 6]
			]);
			expect(out).toMatchObject({ applied: true, created: 2 });
			const count = (body: string) =>
				targets.filter((t) => t === `pipeline.shifts.spec.import.${body}`).length;
			expect([count('scope.of'), count('map')]).toEqual([1, 1]);
		})
	);

	it.live(
		"a settled row restated unchanged passes; deleting or changing one refuses the whole file through the collection's guard",
		() =>
			Effect.gen(function* () {
				const { sheet, seed, shifts } = yield* setup();
				yield* seed([
					{ person: 'ann', day: '2026-01-01', hours: 8, locked: true },
					{ person: 'ann', day: '2026-01-02', hours: 8, locked: true }
				]);
				expect(
					yield* sheet([
						['Person', 'Day', 'hours'],
						['ann', '2026-01-01', 8],
						['ann', '2026-01-02', 8],
						['ann', '2026-01-03', 4]
					])
				).toMatchObject({ applied: true, created: 1 });
				const before = yield* shifts();
				const pruned = yield* sheet([
					['Person', 'Day', 'hours'],
					['ann', '2026-01-01', 8],
					['ann', '2026-01-03', 5]
				]);
				expect(pruned).toEqual({
					applied: false,
					findings: [
						{ row: null, column: '', message: 'ann 2026-01-02 is settled', severity: 'refuse' }
					]
				});
				expect(
					yield* sheet([
						['Person', 'Day', 'hours'],
						['ann', '2026-01-01', 9]
					])
				).toMatchObject({ applied: false, findings: [{ severity: 'refuse' }] });
				expect(yield* shifts()).toEqual(before);
			})
	);

	it.live(
		'a row in a state that locks it refuses an import that changes it, though the import names it by key',
		() =>
			Effect.gen(function* () {
				const { t, act, sheet, shifts } = yield* setup();
				const [id] = ok(
					yield* act('shifts.create', { person: 'cy', day: '2026-01-01', hours: 8 })
				).records.map((r) => r.id);
				ok(yield* act('shifts.update', { target: required(id), set: { status: 'paid' } }, t.admin));
				expect(
					yield* sheet([
						['Person', 'Day', 'hours'],
						['cy', '2026-01-01', 7]
					])
				).toMatchObject({
					applied: false,
					findings: [{ message: expect.stringContaining('locked'), severity: 'refuse' }]
				});
				expect(
					yield* sheet([
						['Person', 'Day', 'hours'],
						['cy', '2026-01-01', 8]
					])
				).toMatchObject({ applied: true });
			})
	);

	it.live(
		'a warn finding waits for acceptance and writes nothing; accepted, the same file is written; a refuse blocks either way',
		() =>
			Effect.gen(function* () {
				const { sheet, shifts } = yield* setup();
				const cells: Cell[][] = [
					['Person', 'Day', 'hours'],
					['ann', '2026-01-01', 12]
				];
				expect(yield* sheet(cells)).toEqual({
					applied: false,
					findings: [{ row: 2, column: 'hours', message: 'over ten hours', severity: 'warn' }]
				});
				expect(yield* shifts()).toEqual([]);
				expect(yield* sheet(cells, { accept: true })).toMatchObject({
					applied: true,
					created: 1,
					findings: [{ severity: 'warn' }]
				});
				expect(
					yield* sheet(
						[
							['Person', 'Day', 'hours'],
							['bob', '2026-01-01', 30]
						],
						{ accept: true }
					)
				).toMatchObject({ applied: false, findings: [{ row: 2, severity: 'refuse' }] });
			})
	);

	it.live(
		'a bad cell or a missing column is a refuse finding on its sheet row and column header',
		() =>
			Effect.gen(function* () {
				const { sheet } = yield* setup();
				expect(
					yield* sheet([
						['Person', 'Day', 'hours'],
						['ann', '2026-01-01', 'lots']
					])
				).toEqual({
					applied: false,
					findings: [
						{ row: 2, column: 'hours', message: 'Expected number | null', severity: 'refuse' }
					]
				});
				expect(
					yield* sheet([
						['Person', 'hours'],
						['ann', 3]
					])
				).toEqual({
					applied: false,
					findings: [
						{ row: 1, column: 'Day', message: 'The sheet has no such column.', severity: 'refuse' }
					]
				});
			})
	);

	it.live(
		'known resolves once per upload; related rows and the set are written in one act; context narrows and defaults',
		() =>
			Effect.gen(function* () {
				const { t, act, files, read, run, put, seed, shifts } = yield* setup();
				const [annual] = ok(yield* act('leave_codes.create', { code: 'AL' }, t.admin)).records.map(
					(r) => r.id
				);
				yield* seed([
					{ person: 'hq/ann', day: '2026-01-01', hours: 8 },
					{ person: 'hq/ann', day: '2026-01-02', hours: 8 },
					{ person: 'ann', day: '2026-01-02', hours: 8 }
				]);
				const file = yield* put([
					['Person', 'Day', 'hours', 'leave'],
					['ann', '2026-01-01', 8],
					['ann', '2026-01-02', null, 'AL']
				]);
				t.count.reset();
				expect(yield* run({ mode: 'import', file, context: { site: 'hq' } })).toEqual({
					applied: true,
					created: 0,
					updated: 1,
					deleted: 0,
					findings: []
				});
				expect(t.count.writes).toBe(1);
				expect(yield* shifts()).toEqual([
					['ann', '2026-01-02', 8],
					['hq/ann', '2026-01-01', 8],
					['hq/ann', '2026-01-02', null]
				]);
				const off = (yield* read('days_off')).rows.map((r) => [r['person'], r['day'], r['leave']]);
				expect(off).toEqual([['ann', '2026-01-02', annual]]);
				yield* run({ mode: 'template', context: { site: 'hq' } });
				expect(xlsxCells(required([...files.stored.values()].at(-1))).map((r) => r[0])).toEqual([
					'Person',
					'hq/ann',
					'hq/ann'
				]);
			})
	);

	it.live(
		'a related row the caller may not write refuses the whole file, the main rows and the set included',
		() =>
			Effect.gen(function* () {
				const { t, act, run, put, shifts } = yield* setup();
				ok(yield* act('leave_codes.create', { code: 'AL' }, t.admin));
				const who2 = t.member(['shifts_only']);
				const file = yield* put(
					[
						['Person', 'Day', 'hours', 'leave'],
						['bo', '2026-01-01', 8],
						['bo', '2026-01-02', null, 'AL']
					],
					who2
				);
				expect(yield* run({ mode: 'import', file }, who2)).toMatchObject({
					applied: false,
					findings: [{ severity: 'refuse' }]
				});
				expect(yield* shifts()).toEqual([]);
			})
	);

	it.live(
		'a known-based check refuses an unknown key on its row; the context is decoded like any input',
		() =>
			Effect.gen(function* () {
				const { run, sheet } = yield* setup();
				expect(
					yield* sheet([
						['Person', 'Day', 'leave'],
						['ann', '2026-01-01', 'XX']
					])
				).toEqual({
					applied: false,
					findings: [{ row: 2, column: 'leave', message: 'no such leave', severity: 'refuse' }]
				});
				expect(
					yield* run({ mode: 'template', context: { site: 7 } }).pipe(Effect.flip)
				).toMatchObject({ code: 'invalidInput' });
			})
	);

	it.live(
		'a blank row (mapped to nothing) is still in scope: its stored day is deleted, a person with only blanks too',
		() =>
			Effect.gen(function* () {
				const { sheet, seed, shifts } = yield* setup();
				yield* seed([
					{ person: 'ann', day: '2026-01-01', hours: 8 },
					{ person: 'ann', day: '2026-01-02', hours: 8 },
					{ person: 'bob', day: '2026-01-05', hours: 8 },
					{ person: 'bob', day: '2026-01-06', hours: 8 }
				]);
				expect(
					yield* sheet([
						['Person', 'Day', 'hours'],
						['ann', '2026-01-01', 8],
						['ann', '2026-01-02', 0],
						['bob', '2026-01-05', 0]
					])
				).toEqual({ applied: true, created: 0, updated: 0, deleted: 2, findings: [] });
				expect(yield* shifts()).toEqual([
					['ann', '2026-01-01', 8],
					['bob', '2026-01-06', 8]
				]);
			})
	);
});
