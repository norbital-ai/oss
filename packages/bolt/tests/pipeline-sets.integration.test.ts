// engine/pipelines on PGlite: an import as a set over a scope (§3.3.5, rule 30). An xlsx upload by header, a template
// download, the scope's deletes in the same act under the collection's guards, and findings that refuse or wait.
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Json } from '../src/decl/values.ts';
import type { EngineManifest, FilesPort, Outcome } from '../src/engine/contracts.ts';
import { xlsxCells, xlsxOf, type Cell } from '../src/engine/agent/xlsx.ts';
import { upload } from '../src/engine/callables/upload.ts';
import { guestRunner } from '../src/engine/guest/runner.ts';
import { lowerRead } from '../src/engine/index.ts';
import { pipelines } from '../src/engine/pipelines/pipeline.ts';
import { testWorkspace, type TestWorkspace } from '../src/test/index.ts';

const NOW = '2026-09-25T10:00:00.000Z';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const manifest = {
	workspace: { tz: 'UTC', locale: 'en' },
	models: {
		shifts: { description: 'A person-day', label: 'person', key: ['person', 'day'], fields: { person: { kind: 'text' }, day: { kind: 'date' },
			hours: { kind: 'int', optional: true }, locked: { kind: 'bool', default: false },
			status: { kind: 'state', initial: 'open', states: { open: { to: ['paid'] }, paid: { edit: 'none' } } } } },
		leave_codes: { description: 'A leave class', label: 'code', key: ['code'], fields: { code: { kind: 'text' } } },
		days_off: { description: 'A day of leave', label: 'person', fields: { person: { kind: 'text' }, day: { kind: 'date' }, leave: { kind: 'text' } } },
	},
	relationships: {},
	collections: { shifts: { read: { fields: 'all' }, create: { input: { columns: ['person', 'day', 'hours', 'locked'] } },
		update: { input: { columns: ['hours', 'locked', 'status'] } }, delete: { transform: true } },
		leave_codes: { read: { fields: 'all' }, create: { input: { columns: ['code'] } } },
		days_off: { read: { fields: 'all' }, create: { input: { columns: ['person', 'day', 'leave'] } } } },
	integrations: {},
	pipelines: {
		shifts: { import: { description: 'The roster sheet: a set per person over the days it covers.', onConflict: 'update', check: true, template: true, known: true,
			related: { days_off: true }, context: { site: { kind: 'text', optional: true } },
			scope: { by: ['person'], range: 'day', of: true },
			input: { rows: { kind: 'list', of: { kind: 'object', fields: { row: { kind: 'number' }, person: { kind: 'text', label: 'Person' },
				day: { kind: 'date', label: 'Day' }, hours: { kind: 'int', optional: true }, leave: { kind: 'text', optional: true } } } } } } },
	},
	policies: { hr: { description: 'HR', grants: { shifts: { read: true, create: true, update: true, delete: true }, leave_codes: { read: true }, days_off: { read: true, create: true } } },
		shifts_only: { description: 'Shifts, no leave', grants: { shifts: { read: true, create: true, update: true, delete: true }, leave_codes: { read: true }, days_off: { read: true } } } },
	teams: {}, automations: {}, channels: {}, connections: {}, envoys: {}, mcp: {}, apps: {}, customFields: {}, agent: { skills: {} },
} as unknown as EngineManifest;
const source = `export default {
	collection: { shifts: { bodies: { transform: (inputs, ctx) => inputs.map((input, i) => {
		const before = ctx.existing[i];
		if (before?.locked && (input.$delete || ('hours' in input && (input.hours ?? null) !== (before.hours ?? null)))) ctx.refuse(before.person + ' ' + before.day + ' is settled');
		return input;
	}) } } },
	pipeline: { shifts: { spec: { import: {
		records: (input) => input.rows,
		known: async (ctx, records, { context }) => ({ site: context.site ?? null, leave: Object.fromEntries((await ctx.read('leave_codes', { all: true })).rows.map((r) => [r.code, r.id])) }),
		// a zero-hour row is a blank day: no row, but still in scope (so its stored day is deleted)
		map: (r, { known }) => r.hours === 0 ? null : ({ person: known.site === null ? r.person : known.site + '/' + r.person, day: r.day, hours: r.hours ?? null }),
		scope: { of: (r, { known }) => ({ person: known.site === null ? r.person : known.site + '/' + r.person, day: r.day }) },
		related: { days_off: (r, { known }) => r.leave === undefined ? [] : [{ person: r.person, day: r.day, leave: known.leave[r.leave] }] },
		check: async (ctx, { records, rows, known }) => [...rows.flatMap((r, i) => r === null || r.hours === null || r.hours <= 10 ? []
			: [{ row: records[i].row, column: 'hours', message: 'over ten hours', severity: r.hours > 24 ? 'refuse' : 'warn' }]),
			...records.flatMap((r) => r.leave === undefined || r.leave in known.leave ? [] : [{ row: r.row, column: 'leave', message: 'no such leave', severity: 'refuse' }])],
		template: async (ctx, { context }) => (await ctx.read('shifts', { all: true, orderBy: 'day' })).rows
			.filter((r) => context.site === undefined || r.person.startsWith(context.site + '/')).map((r) => ({ person: r.person, day: r.day, hours: r.hours })),
	} } } },
};`;
const guest = { source };
const runner = guestRunner(guest, { lowerRead: (member, args) => lowerRead(manifest, member, args), console: () => {} });

let t: TestWorkspace, who: ReturnType<TestWorkspace['member']>;
beforeEach(async () => { t = await testWorkspace({ manifest, guest, transforms: ['shifts'], now: NOW }); who = t.member(['hr']); });
const ok = (o: Outcome) => { if (o.kind !== 'committed') throw new Error(JSON.stringify(o)); return o; };
const hr = () => who;
const store = (): FilesPort & { stored: Map<string, Uint8Array> } => {
	const stored = new Map<string, Uint8Array>();
	return { stored, put: async (bytes, meta) => { const key = `k${stored.size}`; stored.set(key, bytes); return { key, bytes: bytes.byteLength, sha256: '', mime: meta.mime }; },
		get: async (key) => stored.get(key)!, url: async () => '', remove: async () => {} };
};
const bindings = () => ({ now: NOW, today: NOW.slice(0, 10), tz: 'UTC', params: {} });
const files = store();
const run = (input: Json, starter = hr()) => pipelines({ engine: t.engine, bindings, guest: runner, files }).handlers()['shifts.pipeline']!(input, { id: randomUUID(), starter });
const put = async (cells: Cell[][]) => (ok(await upload({ manifest, db: t.engine.db, files }, { id: randomUUID(), collection: 'shifts', field: '$import',
	name: 'roster.xlsx', mime: XLSX, bytes: xlsxOf(cells), authority: t.engine.authority(hr()), now: NOW })).output as { id: string }).id;
const sheet = async (cells: Cell[][], extra: { [k: string]: Json } = {}) => run({ mode: 'import', file: await put(cells), ...extra });
const seed = async (rows: { person: string; day: string; hours?: number; locked?: boolean }[]) => ok(await t.as(hr()).act('shifts.create', rows));
const shifts = async () => (await t.as(hr()).read('shifts', { all: true, orderBy: ['person', 'day'] })).rows
	.map((r) => [r['person'], (r['day'] as { $d: string }).$d, r['hours'] ?? null]);

describe('pipeline import: xlsx, template, scope, findings', () => {
	it('the template is the declared columns by label (the sheet row is its own) prefilled by the template query', async () => {
		await seed([{ person: 'ann', day: '2026-01-02', hours: 8 }]);
		const out = await run({ mode: 'template' }) as { file: { name: string; mime: string } };
		expect(out.file).toMatchObject({ name: 'shifts-template.xlsx', mime: XLSX });
		expect(xlsxCells([...files.stored.values()].at(-1)!)).toEqual([['Person', 'Day', 'hours', 'leave'], ['ann', '2026-01-02', 8]]);
	});

	it('an xlsx upload fills the list by header (any case, label or name); blank cells and rows are dropped, other columns ignored', async () => {
		const out = await sheet([['person', 'DAY', 'hours', 'Note'], ['ann', '2026-01-01', 8, 'x'], [null, '', null], ['bob', '2026-01-01', '', 'y']]);
		expect(out).toEqual({ applied: true, created: 2, updated: 0, deleted: 0, findings: [] });
		expect(await shifts()).toEqual([['ann', '2026-01-01', 8], ['bob', '2026-01-01', null]]);
	});

	it('a set over the scope: per person, the days from first to last the file leaves out are deleted, in one statement', async () => {
		await seed([{ person: 'ann', day: '2026-01-01', hours: 8 }, { person: 'ann', day: '2026-01-02', hours: 8 }, { person: 'ann', day: '2026-01-03', hours: 8 },
			{ person: 'ann', day: '2026-01-09', hours: 8 }, { person: 'bob', day: '2026-01-02', hours: 8 }]);
		const file = await put([['Person', 'Day', 'hours'], ['ann', '2026-01-01', 8], ['ann', '2026-01-03', 6]]);
		t.count.reset();
		const out = await run({ mode: 'import', file });
		expect(out).toEqual({ applied: true, created: 0, updated: 1, deleted: 1, findings: [] });
		expect(t.count.writes).toBe(1);
		expect(await shifts()).toEqual([['ann', '2026-01-01', 8], ['ann', '2026-01-03', 6], ['ann', '2026-01-09', 8], ['bob', '2026-01-02', 8]]);
	});

	it('a settled row restated unchanged passes; deleting or changing one refuses the whole file through the collection\'s guard', async () => {
		await seed([{ person: 'ann', day: '2026-01-01', hours: 8, locked: true }, { person: 'ann', day: '2026-01-02', hours: 8, locked: true }]);
		expect(await sheet([['Person', 'Day', 'hours'], ['ann', '2026-01-01', 8], ['ann', '2026-01-02', 8], ['ann', '2026-01-03', 4]]))
			.toMatchObject({ applied: true, created: 1 });
		const before = await shifts();
		const pruned = await sheet([['Person', 'Day', 'hours'], ['ann', '2026-01-01', 8], ['ann', '2026-01-03', 5]]);
		expect(pruned).toEqual({ applied: false, findings: [{ row: null, column: '', message: 'ann 2026-01-02 is settled', severity: 'refuse' }] });
		expect(await sheet([['Person', 'Day', 'hours'], ['ann', '2026-01-01', 9]])).toMatchObject({ applied: false, findings: [{ severity: 'refuse' }] });
		expect(await shifts()).toEqual(before);
	});

	it('a row in a state that locks it refuses an import that changes it, though the import names it by key', async () => {
		const [id] = ok(await t.as(hr()).act('shifts.create', { person: 'cy', day: '2026-01-01', hours: 8 })).records.map((r) => r.id);
		ok(await t.as(t.admin).act('shifts.update', { target: id!, set: { status: 'paid' } }));
		expect(await sheet([['Person', 'Day', 'hours'], ['cy', '2026-01-01', 7]])).toMatchObject({ applied: false, findings: [{ message: expect.stringContaining('locked'), severity: 'refuse' }] });
		expect(await sheet([['Person', 'Day', 'hours'], ['cy', '2026-01-01', 8]])).toMatchObject({ applied: true });
	});

	it('a warn finding waits for acceptance and writes nothing; accepted, the same file is written; a refuse blocks either way', async () => {
		const cells: Cell[][] = [['Person', 'Day', 'hours'], ['ann', '2026-01-01', 12]];
		expect(await sheet(cells)).toEqual({ applied: false, findings: [{ row: 2, column: 'hours', message: 'over ten hours', severity: 'warn' }] });
		expect(await shifts()).toEqual([]);
		expect(await sheet(cells, { accept: true })).toMatchObject({ applied: true, created: 1, findings: [{ severity: 'warn' }] });
		expect(await sheet([['Person', 'Day', 'hours'], ['bob', '2026-01-01', 30]], { accept: true })).toMatchObject({ applied: false, findings: [{ row: 2, severity: 'refuse' }] });
	});

	it('a bad cell or a missing column is a refuse finding on its sheet row and column header', async () => {
		expect(await sheet([['Person', 'Day', 'hours'], ['ann', '2026-01-01', 'lots']])).toEqual({ applied: false,
			findings: [{ row: 2, column: 'hours', message: 'expected an integer', severity: 'refuse' }] });
		expect(await sheet([['Person', 'hours'], ['ann', 3]])).toEqual({ applied: false, findings: [{ row: 1, column: 'Day', message: 'The sheet has no such column.', severity: 'refuse' }] });
	});

	it('known resolves once per upload; related rows and the set are written in one act; context narrows and defaults', async () => {
		const [annual] = ok(await t.as(t.admin).act('leave_codes.create', { code: 'AL' })).records.map((r) => r.id);
		await seed([{ person: 'hq/ann', day: '2026-01-01', hours: 8 }, { person: 'hq/ann', day: '2026-01-02', hours: 8 }, { person: 'ann', day: '2026-01-02', hours: 8 }]);
		const file = await put([['Person', 'Day', 'hours', 'leave'], ['ann', '2026-01-01', 8], ['ann', '2026-01-02', null, 'AL']]);
		t.count.reset();
		expect(await run({ mode: 'import', file, context: { site: 'hq' } })).toEqual({ applied: true, created: 0, updated: 1, deleted: 0, findings: [] });
		expect(t.count.writes).toBe(1);
		expect(await shifts()).toEqual([['ann', '2026-01-02', 8], ['hq/ann', '2026-01-01', 8], ['hq/ann', '2026-01-02', null]]);
		const off = (await t.as(hr()).read('days_off', { all: true })).rows.map((r) => [r['person'], (r['day'] as { $d: string }).$d, r['leave']]);
		expect(off).toEqual([['ann', '2026-01-02', annual]]);
		await run({ mode: 'template', context: { site: 'hq' } });
		expect(xlsxCells([...files.stored.values()].at(-1)!).map((r) => r[0])).toEqual(['Person', 'hq/ann', 'hq/ann']);
	});

	it('a related row the caller may not write refuses the whole file, the main rows and the set included', async () => {
		ok(await t.as(t.admin).act('leave_codes.create', { code: 'AL' }));
		const who2 = t.member(['shifts_only']);
		const o = ok(await upload({ manifest, db: t.engine.db, files }, { id: randomUUID(), collection: 'shifts', field: '$import', name: 'r.xlsx', mime: XLSX,
			bytes: xlsxOf([['Person', 'Day', 'hours', 'leave'], ['bo', '2026-01-01', 8], ['bo', '2026-01-02', null, 'AL']]), authority: t.engine.authority(who2), now: NOW }));
		expect(await run({ mode: 'import', file: (o.output as { id: string }).id }, who2)).toMatchObject({ applied: false, findings: [{ severity: 'refuse' }] });
		expect(await shifts()).toEqual([]);
	});

	it('a known-based check refuses an unknown key on its row; the context is decoded like any input', async () => {
		expect(await sheet([['Person', 'Day', 'leave'], ['ann', '2026-01-01', 'XX']])).toEqual({ applied: false,
			findings: [{ row: 2, column: 'leave', message: 'no such leave', severity: 'refuse' }] });
		await expect(run({ mode: 'template', context: { site: 7 } })).rejects.toMatchObject({ code: 'invalidInput' });
	});

	it('a blank row (mapped to nothing) is still in scope: its stored day is deleted, a person with only blanks too', async () => {
		await seed([{ person: 'ann', day: '2026-01-01', hours: 8 }, { person: 'ann', day: '2026-01-02', hours: 8 }, { person: 'bob', day: '2026-01-05', hours: 8 },
			{ person: 'bob', day: '2026-01-06', hours: 8 }]);
		expect(await sheet([['Person', 'Day', 'hours'], ['ann', '2026-01-01', 8], ['ann', '2026-01-02', 0], ['bob', '2026-01-05', 0]]))
			.toEqual({ applied: true, created: 0, updated: 0, deleted: 2, findings: [] });
		expect(await shifts()).toEqual([['ann', '2026-01-01', 8], ['bob', '2026-01-06', 8]]);
	});
});
