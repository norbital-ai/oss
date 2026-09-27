// AI filtering's schema and strict decode (rule 16a, P34, P35) without a database: the options System 1 chooses among
// are the caller's exposure (own fields, one hop through exposed relations: `is`, has any / all / none, count, child
// aggregates) and nothing else, and `decodeDescribed` refuses any field, relation or sort key outside it.
import { describe, expect, it } from 'vitest';
import type { AiPort, Arm, Authority, CollectionAuthority, EngineManifest, Pred, ReadEngine, TenantDb } from '../src/engine/contracts.ts';
import type { DecisionAnswer, DecisionQuestion, System1Port, System1Request } from '../src/engine/decisions/index.ts';
import { decodeDescribed, filterDescribe } from '../src/engine/filter-describe/index.ts';
import { catalog } from '../src/protocol/catalog.ts';

const manifest = {
	workspace: { tz: 'Asia/Singapore', locale: 'en' },
	models: {
		members: { description: 'm', label: 'name', fields: { name: { kind: 'text' }, rate: { kind: 'money' } } },
		audits: { description: 'a', label: 'note', fields: { note: { kind: 'text' } } },
		jobs: { description: 'j', label: 'title', fields: {
			title: { kind: 'text' }, hours: { kind: 'decimal', scale: 1 }, notes: { kind: 'text', optional: true }, internal_code: { kind: 'text' },
			scheduled_on: { kind: 'date' }, window: { kind: 'period', of: 'date', optional: true },
			status: { kind: 'state', initial: 'open', states: { open: { to: ['done'] }, done: {} } } } },
		job_lines: { description: 'l', label: 'item', fields: { item: { kind: 'text' }, qty: { kind: 'int' }, amount: { kind: 'money' } } },
	},
	relationships: {
		'jobs.assignee': { to: 'members', inverse: 'assigned_jobs' },
		'jobs.audit': { to: 'audits', optional: true },
		'job_lines.job': { to: 'jobs', inverse: 'lines' },
	},
	collections: {
		members: { read: { fields: 'all' } },
		job_lines: { read: { fields: 'all' } },
		// `internal_code` and the `audit` relation are not exposed; `audits` is no collection at all
		jobs: { read: { fields: ['title', 'hours', 'notes', 'scheduled_on', 'window', 'status', 'assignee'], relations: ['assignee', 'lines'] } },
	},
	integrations: {}, pipelines: {}, policies: {}, teams: {}, automations: {}, channels: {}, connections: {}, envoys: {}, mcp: {}, apps: {},
	customFields: {}, agent: { skills: {} },
} as unknown as EngineManifest;
const cat = catalog(manifest);

const TRUE: Pred = { t: 'const', value: true };
const arm: Arm = { policy: 'dispatch', where: TRUE, fields: 'all' };
const grant = (masks: { [f: string]: Pred } = {}): CollectionAuthority =>
	({ read: [arm], history: [], create: [], update: [], delete: [], queries: [], actions: [], moves: {}, masks });
/** A dispatcher: reads jobs (notes masked), members (rate masked) and job lines. */
const caller = (collections: { [c: string]: CollectionAuthority } = { jobs: grant({ notes: { t: 'const', value: false } }), members: grant({ rate: { t: 'const', value: false } }), job_lines: grant() }): Authority => ({
	key: 'k', admin: false, policies: ['dispatch'], collections, automations: [], limits: [], teamTree: [], scopes: {},
	capabilities: { apps: [], tools: [], mcp: [], skills: [] },
	actor: { kind: 'member', id: 'u1', email: null, external: false, teams: [], teamPath: [], admin: false, party: null },
});
const decode = (where: object, orderBy?: object | string, a = caller()) =>
	() => decodeDescribed(cat, a, 'jobs', { where: where as never, ...(orderBy === undefined ? {} : { orderBy: orderBy as never }) });

describe('decodeDescribed: the caller\'s exposed query shape, exactly', () => {
	it('refuses a field outside the exposure, a masked field and an unexposed relation', () => {
		expect(decode({ internal_code: { eq: 'X1' } })).toThrow(/not a field this caller reads/);
		expect(decode({ notes: { like: '%pump%' } })).toThrow(/not a field this caller reads/);
		expect(decode({ audit: { is: { note: { eq: 'x' } } } })).toThrow(/not a relation this caller reads/);
		expect(decode({ assignee: { is: { rate: { gt: 10 } } } })).toThrow(/members\.rate/); // masked on the target
		expect(decode({ bogus: { eq: 1 } })).toThrow(/unknown field/); // the grammar's own refusal
	});

	it('accepts relation filters: one-relation `is`, has any / all / none, count and a child aggregate', () => {
		expect(decode({ assignee: { is: { name: { like: '%bob%' } } } })).not.toThrow();
		expect(decode({ lines: { some: { qty: { gt: 2 } } } })).not.toThrow();
		expect(decode({ lines: { every: { amount: { gte: 10 } } } })).not.toThrow();
		expect(decode({ lines: { none: { item: { eq: 'pump' } } } })).not.toThrow();
		expect(decode({ and: [{ lines: { count: { gt: 1 } } }, { lines: { sum: { of: 'amount', gte: 100 } } }] })).not.toThrow();
	});

	it('refuses a relation into a collection the caller does not read', () => {
		const noMembers = caller({ jobs: grant(), job_lines: grant() });
		expect(decode({ assignee: { is: { name: { eq: 'Bob' } } } }, undefined, noMembers)).toThrow(/'members' is not read/);
		expect(decode({ assignee: { eq: '00000000-0000-4000-8000-000000000001' } }, undefined, noMembers)).not.toThrow(); // the key itself is jobs'
	});

	it('sorts where OrderBy allows: own sortable fields, a one-relation (by id), a related field the caller reads unmasked, at most 4 keys', () => {
		expect(decode({}, [{ scheduled_on: 'desc' }, { hours: 'asc' }])).not.toThrow();
		expect(decode({}, { assignee: 'asc' })).not.toThrow(); // the relation's key
		expect(decode({}, { assignee: { name: 'asc' } })).not.toThrow(); // through an exposed relation, a readable target field
		expect(decode({}, [{ assignee: { name: 'desc' } }, { title: 'asc' }])).not.toThrow();
		expect(decode({}, { assignee: { rate: 'asc' } })).toThrow(/members\.rate/); // masked on the target: no ordering by it either
		expect(decode({}, { audit: { note: 'asc' } })).toThrow(/not a relation this caller reads/); // unexposed relation
		expect(decode({}, { assignee: { name: 'asc' } }, caller({ jobs: grant(), job_lines: grant() }))).toThrow(/'members' is not read/);
		expect(decode({}, { assignee: { bogus: 'asc' } })).toThrow(/not sortable/); // the grammar's own refusal
		expect(decode({}, { 'assignee.name': 'asc' })).toThrow(/one \{ field/); // one grammar: nested keys, not a dotted string
		expect(decode({}, { assignee: 'asc' }, caller({ jobs: grant({ assignee: { t: 'const', value: false } }), members: grant() }))).toThrow(/not a field this caller reads/);
		expect(decode({}, { assignee: { name: 'asc' } }, caller({ jobs: grant({ assignee: { t: 'const', value: false } }), members: grant() }))).toThrow(/not a relation this caller reads/);
		expect(decode({}, { notes: 'asc' })).toThrow(/not a field this caller reads/);
		expect(decode({}, { internal_code: 'asc' })).toThrow(/not a field this caller reads/);
		expect(decode({}, ['title', 'hours', 'status', 'scheduled_on', 'created_at'])).toThrow(/at most 4 keys/);
	});
});

/** A scripted System 1: `pick` names the chosen option per question; others take their first option (or false). */
function system1(pick: { readonly [id: string]: string | boolean }) {
	const answer = (q: DecisionQuestion, v: string | boolean | undefined): DecisionAnswer => q.type === 'noul' ? { type: 'noul', noul: v === true ? 0.9 : 0.1 }
		: q.type === 'choice' ? { type: 'choice', choice: typeof v === 'string' ? v : Object.keys(q.criteria)[0]!, confidence: 0.9, probabilities: {} }
			: { type: 'score', score: 0, level: 0, confidence: 0.9, probabilities: {}, legend: {} };
	const port: System1Port & { requests: System1Request[] } = { requests: [], async ask(r) {
		port.requests.push(r);
		return { costUsd: 0, provider: 'scripted', answers: Object.fromEntries(Object.entries(r.questions).map(([id, q]) => [id, answer(q, pick[id])])) };
	} };
	return port;
}
const describer = (port: System1Port) => filterDescribe({ manifest, clock: () => '2026-09-26T00:00:00.000Z',
	db: { async write() { return []; } } as unknown as TenantDb, read: (async (qs: readonly unknown[]) => qs.map(() => ({ rows: [] }))) as unknown as ReadEngine['run'],
	ai: { sys_1: port, sys_2: { models: ['x'], async infer() { throw new Error('System 2 is never asked (P35)'); } } } as unknown as AiPort });
const bindings = { now: '2026-09-26T00:00:00.000Z', today: '2026-09-26', tz: 'Asia/Singapore', params: {} };
const choices = (q: DecisionQuestion | undefined) => q?.type === 'choice' ? Object.keys(q.criteria) : [];

describe('filter.describe offers System 1 the exposure and maps its choices onto the grammar', () => {
	it('the field options are the caller\'s exposure: relations one hop, nothing masked or unexposed', async () => {
		const port = system1({});
		await describer(port).describe({ collection: 'jobs', text: 'jobs with more than 2 pumps', authority: caller(), bindings });
		const fields = choices(port.requests[0]!.questions['c0.field']);
		expect(fields).toEqual(expect.arrayContaining(['Title', 'Status', 'Assignee', 'Assignee › Name', 'Lines (any) › Qty', 'Lines (all) › Amount',
			'Lines (none) › Item', 'Lines › count', 'Lines › total amount']));
		for (const hidden of ['Notes', 'Internal code', 'Assignee › Rate']) expect(fields).not.toContain(hidden);
		expect(fields.some((f) => f.startsWith('Audit'))).toBe(false);
		// sorting: own fields and, one hop through a one-relation, readable unmasked target fields; never a many-relation
		const sorts = choices(port.requests[0]!.questions['sort.field']);
		expect(sorts).toEqual(expect.arrayContaining(['Title', 'Scheduled on', 'Assignee › Name']));
		for (const no of ['Notes', 'Assignee › Rate', 'Lines (any) › Qty', 'Lines › count']) expect(sorts).not.toContain(no);
	});

	it('a related condition and an own sort decode to a relation Where and an OrderBy', async () => {
		const port = system1({ 'c0.yes': true, 'c0.field': 'Lines (any) › Qty', 'c0.op': 'Lines (any) › Qty · more than', 'c0.value': 'Lines (any) › Qty · 2',
			'sort.yes': true, 'sort.field': 'Scheduled on', 'sort.dir': 'descending (newest, highest, Z→A first)' });
		const r = await describer(port).describe({ collection: 'jobs', text: 'jobs with more than 2 of any line, latest first', authority: caller(), bindings });
		expect(r).toEqual({ ok: true, where: { lines: { some: { qty: { gt: 2 } } } }, orderBy: { scheduled_on: 'desc' } });
	});

	it('a related sort decodes to a nested OrderBy key', async () => {
		const port = system1({ 'sort.yes': true, 'sort.field': 'Assignee › Name', 'sort.dir': 'ascending (oldest, lowest, A→Z first)',
			'c0.yes': true, 'c0.field': 'Title', 'c0.op': 'Title · contains', 'c0.value': 'Title · pump' });
		const r = await describer(port).describe({ collection: 'jobs', text: 'pump jobs by assignee name', authority: caller(), bindings });
		expect(r).toEqual({ ok: true, where: { title: { like: '%pump%' } }, orderBy: { assignee: { name: 'asc' } } });
	});

	it('the sort\'s own words are never offered as a text value', async () => {
		const port = system1({});
		await describer(port).describe({ collection: 'jobs', text: 'pump jobs, sorted by title descending', authority: caller(), bindings });
		const values = choices(port.requests[0]!.questions['c0.value']);
		expect(values.some((v) => v.endsWith('· pump'))).toBe(true);
		for (const w of ['sorted', 'descending']) expect(values.some((v) => v.endsWith(`· ${w}`))).toBe(false);
	});

	it('a date period is offered: in force today, or overlapping a span (staging: "started in 2024" fell to created_at)', async () => {
		const today = system1({ 'c0.yes': true, 'c0.field': 'Window', 'c0.op': 'Window · in force on', 'c0.value': 'Window · today' });
		expect(await describer(today).describe({ collection: 'jobs', text: 'jobs in force today', authority: caller(), bindings }))
			.toEqual({ ok: true, where: { window: { contains: { today: '' } } } });
		const year = system1({ 'c0.yes': true, 'c0.field': 'Window', 'c0.op': 'Window · overlaps', 'c0.value': 'Window · this year' });
		expect(await describer(year).describe({ collection: 'jobs', text: 'jobs running at any time this year', authority: caller(), bindings }))
			.toEqual({ ok: true, where: { window: { overlaps: { from: { startOf: 'year' }, to: { startOf: 'year', shift: 1 } } } } });
	});

	it('a child aggregate condition decodes to the aggregate grammar', async () => {
		const port = system1({ 'c0.yes': true, 'c0.field': 'Lines › total amount', 'c0.op': 'Lines › total amount · at least', 'c0.value': 'Lines › total amount · 500' });
		const r = await describer(port).describe({ collection: 'jobs', text: 'jobs whose lines total at least 500', authority: caller(), bindings });
		expect(r).toEqual({ ok: true, where: { lines: { sum: { of: 'amount', gte: 500 } } } });
	});
});
