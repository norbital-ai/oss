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
			scheduled_on: { kind: 'date' }, window: { kind: 'period', of: 'date', optional: true }, tags: { kind: 'text', many: true },
			status: { kind: 'state', initial: 'open', states: { open: { to: ['done'] }, done: {} } } } },
		job_lines: { description: 'l', label: 'item', fields: { item: { kind: 'text' }, qty: { kind: 'int' }, amount: { kind: 'money' } } },
	},
	relationships: {
		'jobs.assignee': { to: 'members', inverse: 'assigned_jobs' },
		'jobs.audit': { to: 'audits', optional: true },
		'members.manager': { to: 'members', optional: true },
		'job_lines.job': { to: 'jobs', inverse: 'lines' },
	},
	collections: {
		members: { read: { fields: 'all' } },
		job_lines: { read: { fields: 'all' } },
		// `internal_code` and the `audit` relation are not exposed; `audits` is no collection at all
		jobs: { read: { fields: ['title', 'hours', 'notes', 'scheduled_on', 'window', 'status', 'tags', 'assignee'], relations: ['assignee', 'lines'] } },
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
	actor: { kind: 'member', id: 'u1', email: null, phone: null, external: false, teams: [], teamPath: [], admin: false, party: null },
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
function system1(pick: (r: System1Request) => { readonly [id: string]: string | boolean }) {
	const answer = (q: DecisionQuestion, v: string | boolean | undefined): DecisionAnswer => q.type === 'noul' ? { type: 'noul', noul: v === true ? 0.9 : 0.1 }
		: q.type === 'choice' ? { type: 'choice', choice: typeof v === 'string' ? v : Object.keys(q.criteria)[0]!, confidence: 0.9, probabilities: {} }
			: { type: 'score', score: 0, level: 0, confidence: 0.9, probabilities: {}, legend: {} };
	const port: System1Port & { requests: System1Request[] } = { requests: [], async ask(r) {
		port.requests.push(r);
		const chosen = pick(r);
		return { costUsd: 0, provider: 'scripted', answers: Object.fromEntries(Object.entries(r.questions).map(([id, q]) => [id, answer(q, chosen[id])])) };
	} };
	return port;
}
const describer = (port: System1Port) => filterDescribe({ manifest, clock: () => '2026-09-26T00:00:00.000Z',
	db: { async write() { return []; } } as unknown as TenantDb, read: (async (qs: readonly unknown[]) => qs.map(() => ({ rows: [] }))) as unknown as ReadEngine['run'],
	ai: { sys_1: port, sys_2: { models: ['x'], async infer() { throw new Error('System 2 is never asked (P35)'); } } } as unknown as AiPort });
const bindings = { now: '2026-09-26T00:00:00.000Z', today: '2026-09-26', tz: 'Asia/Singapore', params: {} };
const choices = (q: DecisionQuestion | undefined) => q?.type === 'choice' ? Object.keys(q.criteria) : [];
/** The field a `f1`-shaped question is about, read back from that question's own operator options. */
const labelOf = (r: System1Request, id: string) => choices(r.questions[`${id}.op`])[0]!.split(' \u00b7 ')[0]!;
/** Every field label the one request asked about, in the order it asked. */
const askedFields = (r: System1Request) => Object.keys(r.questions).filter((id) => /^f\d+$/.test(id)).map((id) => labelOf(r, id));
/**
 * A scripted answer in the request's own shape: which fields the description restricts, and for each of those the
 * operator and the value. A field the plan omits is one the description did not restrict.
 */
type Plan = { readonly [label: string]: { op: string; value: string } | false };
const byField = (plan: Plan, sort: { [id: string]: string | boolean } = {}) => (r: System1Request) => {
	const pick: { [id: string]: string | boolean } = { ...sort };
	for (const [id, q] of Object.entries(r.questions)) {
		if (q.type !== 'noul' || !/^f\d+$/.test(id)) continue;
		const label = labelOf(r, id);
		const a = plan[label];
		if (a === undefined || a === false) { pick[id] = false; continue; }
		pick[id] = true;
		pick[`${id}.op`] = `${label} \u00b7 ${a.op}`;
		pick[`${id}.value`] = `${label} \u00b7 ${a.value}`;
	}
	return pick;
};

describe('filter.describe offers System 1 the exposure and maps its choices onto the grammar', () => {
	it('describes a local roster from its supplied fields without a collection read', async () => {
		const port = system1(byField({ Number: { op: 'more than', value: '20' } },
			{ 'sort.yes': true, 'sort.field': 'Name', 'sort.dir': 'ascending (oldest, lowest, A→Z first)' }));
		const fields = [{ name: 'number', label: 'Number', kind: 'number' as const }, { name: 'name', label: 'Name', kind: 'text' as const }];
		const r = await describer(port).describe({ collection: '$local', text: 'people numbered above 20, by name', localFields: fields, authority: caller({}), bindings });
		expect(r).toEqual({ ok: true, where: { number: { gt: 20 } }, orderBy: { name: 'asc' } });
		expect(askedFields(port.requests[0]!)).toEqual(['Number', 'Name']);
	});
	it('the field options are the caller\'s exposure: own fields, one hop through an exposed relation, nothing else', async () => {
		// no job_lines grant, so nothing many-relation is offered and every readable field fits the bound
		const port = system1(byField({}));
		await describer(port).describe({ collection: 'jobs', text: 'jobs with more than 2 pumps', authority: caller({ jobs: grant({ notes: { t: 'const', value: false } }), members: grant({ rate: { t: 'const', value: false } }) }), bindings });
		const fields = askedFields(port.requests[0]!);
		expect(fields).toEqual(expect.arrayContaining(['Title', 'Status', 'Assignee', 'Assignee › Name', 'Hours', 'Scheduled on', 'Window']));
		for (const hidden of ['Notes', 'Internal code', 'Assignee › Rate']) expect(fields).not.toContain(hidden);
		expect(fields.some((f) => f.startsWith('Audit'))).toBe(false);
		expect(fields.some((f) => f.startsWith('Lines'))).toBe(false);
		// sorting: own fields and, one hop through a one-relation, readable unmasked target fields; never a many-relation
		const sorts = choices(port.requests[0]!.questions['sort.field']);
		expect(sorts).toEqual(expect.arrayContaining(['Title', 'Scheduled on', 'Assignee › Name']));
		for (const no of ['Notes', 'Assignee › Rate', 'Lines (any) › Qty', 'Lines › count']) expect(sorts).not.toContain(no);
	});

	it('a wide collection is bounded, and what the caller cannot read is never offered', async () => {
		const port = system1(byField({}));
		await describer(port).describe({ collection: 'jobs', text: 'jobs with more than 2 pumps', authority: caller(), bindings });
		const asked = port.requests[0]!;
		// job_lines granted opens a many-relation: three quantifiers over its fields, its count and eight aggregates
		expect(askedFields(asked).length).toBe(16);
		for (const hidden of ['Notes', 'Internal code', 'Assignee › Rate', 'Audit']) {
			expect(Object.values(asked.questions).flatMap((q) => choices(q)).some((o) => o.startsWith(`${hidden} \u00b7 `))).toBe(false);
		}
	});

	it('a related condition and an own sort decode to a relation Where and an OrderBy', async () => {
		const port = system1(byField({ 'Lines (any) › Qty': { op: 'more than', value: '2' } },
			{ 'sort.yes': true, 'sort.field': 'Scheduled on', 'sort.dir': 'descending (newest, highest, Z→A first)' }));
		const r = await describer(port).describe({ collection: 'jobs', text: 'jobs with more than 2 of any line, latest first', authority: caller(), bindings });
		expect(r).toEqual({ ok: true, where: { lines: { some: { qty: { gt: 2 } } } }, orderBy: { scheduled_on: 'desc' } });
	});

	it('a related sort decodes to a nested OrderBy key', async () => {
		const port = system1(byField({ Title: { op: 'contains', value: 'pump' } },
			{ 'sort.yes': true, 'sort.field': 'Assignee › Name', 'sort.dir': 'ascending (oldest, lowest, A→Z first)' }));
		const r = await describer(port).describe({ collection: 'jobs', text: 'pump jobs by assignee name', authority: caller(), bindings });
		expect(r).toEqual({ ok: true, where: { title: { like: '%pump%' } }, orderBy: { assignee: { name: 'asc' } } });
	});

	it('the sort\'s own words are never offered as a text value', async () => {
		const port = system1(byField({}));
		await describer(port).describe({ collection: 'jobs', text: 'pump jobs, sorted by title descending', authority: caller(), bindings });
		const values = Object.values(port.requests[0]!.questions).flatMap((q) => choices(q));
		expect(values.some((v) => v.endsWith('· pump'))).toBe(true);
		for (const w of ['sorted', 'descending']) expect(values.some((v) => v.endsWith(`· ${w}`))).toBe(false);
	});

	it('a date period is offered: in force today, or overlapping a span (staging: "started in 2024" fell to created_at)', async () => {
		const today = system1(byField({ Window: { op: 'in force on', value: 'today' } }));
		expect(await describer(today).describe({ collection: 'jobs', text: 'jobs in force today', authority: caller(), bindings }))
			.toEqual({ ok: true, where: { window: { contains: { today: '' } } } });
		const year = system1(byField({ Window: { op: 'overlaps', value: 'this year' } }));
		expect(await describer(year).describe({ collection: 'jobs', text: 'jobs running at any time this year', authority: caller(), bindings }))
			.toEqual({ ok: true, where: { window: { overlaps: { from: { startOf: 'year' }, to: { startOf: 'year', shift: 1 } } } } });
	});

	it('a child aggregate condition decodes to the aggregate grammar', async () => {
		const port = system1(byField({ 'Lines › total amount': { op: 'at least', value: '500' } }));
		const r = await describer(port).describe({ collection: 'jobs', text: 'jobs whose lines total at least 500', authority: caller(), bindings });
		expect(r).toEqual({ ok: true, where: { lines: { sum: { of: 'amount', gte: 500 } } } });
	});

	it('the builder\'s grammar is the catalogue: many-valued fields, in/nin, null tests, two hops', async () => {
		const r = await describer(system1(byField({}))).options({ collection: 'jobs', authority: caller(), bindings });
		if (!r.ok) throw new Error(r.message);
		const ops = (label: string) => r.fields.filter((f) => f.label === label).map((f) => f.op);
		const path = (label: string) => r.fields.find((f) => f.label === label)?.path;
		// a many-valued field offers the builder's list operators (ir's grammar), never a comparison on the list itself
		expect(ops('Tags')).toEqual(['has', 'hasAny', 'hasAll', 'isEmpty', 'notEmpty']);
		expect(path('Tags')).toEqual([{ k: 'field', name: 'tags' }]);
		// `in`/`nin` and the null tests are offered; a masked field never is
		expect(ops('Hours')).toEqual(expect.arrayContaining(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'nin']));
		expect(ops('Window')).toEqual(['contains', 'overlaps', 'within', 'isNull', 'notNull']);
		expect(ops('Notes')).toEqual([]); // masked to this caller
		expect(r.fields.some((f) => f.label === 'Internal code')).toBe(false);
		// two relation hops: `jobs.assignee.manager.name`, with its own sort key
		expect(path('Assignee › Manager › Name')).toEqual([{ k: 'is', rel: 'assignee' }, { k: 'is', rel: 'manager' }, { k: 'field', name: 'name' }]);
		expect(r.fields.find((f) => f.label === 'Assignee › Name')?.sort).toBe('assignee.name');
		// a many-relation's quantifiers, count and child aggregates, and a date period's own operators
		expect(ops('Lines (any) › Qty')).toEqual(expect.arrayContaining(['eq', 'gt']));
		expect(ops('Lines › count')).toEqual(['eq', 'ne', 'gt', 'gte', 'lt', 'lte']);
		expect(path('Lines › total amount')).toEqual([{ k: 'agg', rel: 'lines', fn: 'sum', of: 'amount' }]);
		expect(ops('Window')).toEqual(['contains', 'overlaps', 'within', 'isNull', 'notNull']);
	});

	it('a two-hop relation choice folds to the nested `is` grammar in one call', async () => {
		const port = system1(byField({ 'Assignee › Manager › Name': { op: 'contains', value: 'pump' } }));
		const r = await describer(port).describe({ collection: 'jobs', text: 'manager name contains pump', authority: caller(), bindings });
		expect(r).toEqual({ ok: true, where: { assignee: { is: { manager: { is: { name: { like: '%pump%' } } } } } } });
		expect(port.requests).toHaveLength(1);
	});
});
