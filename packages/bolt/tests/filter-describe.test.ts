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
			scheduled_on: { kind: 'date' }, spot: { kind: 'point', optional: true }, window: { kind: 'period', of: 'date', optional: true }, tags: { kind: 'text', many: true },
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
		jobs: { read: { fields: ['title', 'hours', 'notes', 'scheduled_on', 'spot', 'window', 'status', 'tags', 'assignee'], relations: ['assignee', 'lines'] } },
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
	const answer = (q: DecisionQuestion, v: string | boolean | undefined): DecisionAnswer => {
		if (q.type === 'noul') return { type: 'noul', noul: v === true ? 0.9 : 0.1 };
		const choice = q.type === 'choice' ? typeof v === 'string' ? v : Object.keys(q.criteria)[0]! : '';
		return q.type === 'choice' ? { type: 'choice', choice, confidence: 0.9, probabilities: { [choice]: 0.9 } }
			: { type: 'score', score: 0, level: 0, confidence: 0.9, probabilities: {}, legend: {} };
	};
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
/** The field a `f1`-shaped question is about: the state's Nth field. */
const labelOf = (r: System1Request, id: string) => (r.state['fields'] as { label: string }[])[Number(id.slice(1)) - 1]!.label;
/** Every field label the one request asked about, in the order it asked. */
const askedFields = (r: System1Request) => Object.keys(r.questions).filter((id) => /^f\d+$/.test(id)).map((id) => labelOf(r, id));
/**
 * A scripted answer in the request's own shape: per field the whole condition the description states ("Title contains
 * “pump”"), or none when the plan omits the field. A list operator names its values, each its own yes / no.
 */
type Plan = { readonly [label: string]: { op: string; value?: string; values?: readonly string[] } | false };
const byField = (plan: Plan, extra: { [id: string]: string | boolean } = {}) => (r: System1Request) => {
	const pick: { [id: string]: string | boolean } = { ...extra };
	for (const [id, q] of Object.entries(r.questions)) {
		if (q.type !== 'choice' || !/^f\d+$/.test(id)) continue;
		const label = labelOf(r, id), a = plan[label];
		if (a === undefined || a === false) continue; // its first option: no condition
		const want = a.values !== undefined ? [`${label} ${a.op} the ones named`] : [`${label} ${a.op}${a.value === undefined ? '' : ` ${a.value}`}`, `${label} ${a.op} \u201c${a.value}\u201d`];
		const hit = Object.keys(q.criteria).find((k) => want.includes(k));
		if (hit === undefined) throw new Error(`no option "${want[0]}" among: ${Object.keys(q.criteria).join(' | ')}`);
		pick[id] = hit;
		for (const [v, nq] of Object.entries(r.questions)) if (v.startsWith(`${id}.`) && a.values?.some((x) => nq.instructions.startsWith(`Is ${x} one of`))) pick[v] = true;
	}
	return pick;
};

describe('filter.describe offers System 1 the exposure and maps its choices onto the grammar', () => {
	it('a phrase a found record holds is read once, loosely, through its relation; "not" before it negates it; its words echo nowhere else', async () => {
		// members declare a search: the lookup reads their search document and every searched text field
		const searchable = { ...manifest, models: { ...manifest.models, members: { ...manifest.models.members, search: { text: ['name'] } } } } as unknown as EngineManifest;
		const found = (port: System1Port) => filterDescribe({ manifest: searchable, clock: () => '2026-09-26T00:00:00.000Z',
			db: { async write() { return []; } } as unknown as TenantDb,
			read: (async (qs: readonly { collection?: string }[]) => qs.map((q) => ({ rows: q.collection === 'members' ? [{ id: 'm1', name: 'Bob Tan' }] : [] }))) as unknown as ReadEngine['run'],
			ai: { sys_1: port, sys_2: { models: ['x'], async infer() { throw new Error('never'); } } } as unknown as AiPort });
		const reading = 'one whose Name contains \u201cbob tan\u201d';
		for (const [text, op, where] of [['jobs for bob tan', 'is', { assignee: { is: { name: { like: '%bob%tan%' } } } }], ['jobs not for bob tan', 'is not', { not: { assignee: { is: { name: { like: '%bob%tan%' } } } } }]] as const) {
			// System 1 also says Title contains the echoed "bob": a word the found phrase already reads is no second condition
			const port = system1(byField({ Assignee: { op, value: reading }, Title: { op: 'contains', value: 'bob' } }));
			expect(await found(port).describe({ collection: 'jobs', text, authority: caller(), bindings })).toEqual({ ok: true, where });
		}
	});

	it('a description that states nothing is a refusal, never an empty filter reported as applied (staging: "dsajdasomda")', async () => {
		const r = await describer(system1(byField({}))).describe({ collection: 'jobs', text: 'dsajdasomda', authority: caller(), bindings });
		expect(r).toMatchObject({ ok: false, message: expect.stringMatching(/No field here matches/) });
	});

	it('one condition is never negated by the composition: its own operator says "is not" (staging: "jobs at 1F Pine Grove" → not)', async () => {
		const plan = byField({ Title: { op: 'contains', value: 'pump' } }, { combine: 'none of them hold' });
		expect(await describer(system1(plan)).describe({ collection: 'jobs', text: 'title contains pump', authority: caller(), bindings }))
			.toEqual({ ok: true, where: { title: { like: '%pump%' } } });
		const two = byField({ Title: { op: 'contains', value: 'pump' }, Status: { op: 'is', value: 'done' } }, { combine: 'none of them hold' });
		expect(await describer(system1(two)).describe({ collection: 'jobs', text: 'neither pump titles nor done', authority: caller(), bindings }))
			.toMatchObject({ ok: true, where: { not: { or: expect.any(Array) } } });
	});

	it('a presence-only field offers presence alone (staging: "site location contains …" → location is not empty)', async () => {
		const port = system1(byField({ Title: { op: 'contains', value: 'pump' } }));
		const r = await describer(port).describe({ collection: 'jobs', text: 'spot title contains pump', authority: caller(), bindings });
		expect(r).toEqual({ ok: true, where: { title: { like: '%pump%' } } });
		const q = port.requests[0]!.questions;
		const spot = Object.keys(q).find((id) => /^f\d+$/.test(id) && labelOf(port.requests[0]!, id) === 'Spot')!;
		expect(choices(q[spot])).toEqual(['no condition', 'Spot is empty', 'Spot is not empty']);
	});

	it('describes a local roster from its supplied fields without a collection read', async () => {
		const port = system1(byField({ Number: { op: 'more than', value: '20' } },
			{ sort: 'Name, A to Z' }));
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
		// a field with no condition to offer is not asked (no Assignee record was found, so `Assignee` itself has none)
		expect(fields).toEqual(expect.arrayContaining(['Title', 'Status', 'Assignee › Name', 'Hours', 'Scheduled on', 'Window']));
		for (const hidden of ['Notes', 'Internal code', 'Assignee › Rate']) expect(fields).not.toContain(hidden);
		expect(fields.some((f) => f.startsWith('Audit'))).toBe(false);
		expect(fields.some((f) => f.startsWith('Lines'))).toBe(false);
		// sorting: own fields and, one hop through a one-relation, readable unmasked target fields; never a many-relation
		const sorts = choices(port.requests[0]!.questions['sort']);
		expect(sorts).toEqual(expect.arrayContaining(['Title, A to Z', 'Scheduled on, latest first', 'Assignee › Name, Z to A']));
		for (const no of ['Notes', 'Assignee › Rate', 'Lines (any) › Qty', 'Number of lines']) expect(sorts.some((x) => x.startsWith(`${no}, `))).toBe(false);
	});

	it('a wide collection is bounded, and what the caller cannot read is never offered', async () => {
		const port = system1(byField({}));
		await describer(port).describe({ collection: 'jobs', text: 'jobs with more than 2 pumps', authority: caller(), bindings });
		const asked = port.requests[0]!;
		// job_lines granted opens a many-relation: three quantifiers over its fields, its count and eight aggregates
		expect(askedFields(asked).length).toBe(16);
		for (const hidden of ['Notes', 'Internal code', 'Assignee › Rate', 'Audit']) {
			expect(Object.values(asked.questions).flatMap((q) => choices(q)).some((o) => o.startsWith(`${hidden} `))).toBe(false);
		}
	});

	it('a related condition and an own sort decode to a relation Where and an OrderBy', async () => {
		const port = system1(byField({ 'Lines (any) › Qty': { op: 'more than', value: '2' } },
			{ sort: 'Scheduled on, latest first' }));
		const r = await describer(port).describe({ collection: 'jobs', text: 'jobs with more than 2 of any line, latest first', authority: caller(), bindings });
		expect(r).toEqual({ ok: true, where: { lines: { some: { qty: { gt: 2 } } } }, orderBy: { scheduled_on: 'desc' } });
	});

	it('a related sort decodes to a nested OrderBy key', async () => {
		const port = system1(byField({ Title: { op: 'contains', value: 'pump' } },
			{ sort: 'Assignee › Name, A to Z' }));
		const r = await describer(port).describe({ collection: 'jobs', text: 'pump jobs by assignee name', authority: caller(), bindings });
		expect(r).toEqual({ ok: true, where: { title: { like: '%pump%' } }, orderBy: { assignee: { name: 'asc' } } });
	});

	it('the sort\'s own words are never offered as a text value', async () => {
		const port = system1(byField({}));
		await describer(port).describe({ collection: 'jobs', text: 'pump jobs, sorted by title descending', authority: caller(), bindings });
		const values = Object.values(port.requests[0]!.questions).flatMap((q) => choices(q));
		expect(values.some((v) => v.endsWith('\u201cpump\u201d'))).toBe(true);
		for (const w of ['sorted', 'descending']) expect(values.some((v) => v.endsWith(`\u201c${w}\u201d`))).toBe(false);
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
		expect(ops('Number of lines')).toEqual(['eq', 'ne', 'gt', 'gte', 'lt', 'lte']);
		expect(path('Lines › total amount')).toEqual([{ k: 'agg', rel: 'lines', fn: 'sum', of: 'amount' }]);
		expect(ops('Window')).toEqual(['contains', 'overlaps', 'within', 'isNull', 'notNull']);
	});

	it('a two-hop relation choice folds to the nested `is` grammar in one call', async () => {
		const port = system1(byField({ 'Assignee › Manager › Name': { op: 'contains', value: 'pump' } }));
		const r = await describer(port).describe({ collection: 'jobs', text: 'manager name contains pump', authority: caller(), bindings });
		expect(r).toEqual({ ok: true, where: { assignee: { is: { manager: { is: { name: { like: '%pump%' } } } } } } });
		expect(port.requests).toHaveLength(1);
	});

	it('any-of composition is OR when the text names a disjunction', async () => {
		const plan = byField({ Title: { op: 'contains', value: 'pump' }, Status: { op: 'is', value: 'done' } }, { combine: 'any of them hold' });
		const r = await describer(system1(plan)).describe({ collection: 'jobs', text: 'pump jobs or done jobs', authority: caller(), bindings });
		expect(r).toMatchObject({ ok: true, where: { or: expect.arrayContaining([{ title: { like: '%pump%' } }, { status: { eq: 'done' } }]) } });
		if (!r.ok) throw new Error(r.message);
		expect((r.where as { or: unknown[] }).or).toHaveLength(2);
	});

	it('any-of without a disjunction word stays AND (System 1 misreading the text)', async () => {
		const plan = byField({ Title: { op: 'contains', value: 'pump' }, Status: { op: 'is', value: 'done' } }, { combine: 'any of them hold' });
		const r = await describer(system1(plan)).describe({ collection: 'jobs', text: 'pump titles that are done', authority: caller(), bindings });
		expect(r).toMatchObject({ ok: true, where: { and: expect.arrayContaining([{ title: { like: '%pump%' } }, { status: { eq: 'done' } }]) } });
	});
});

describe('every offered condition is one its field\'s kind admits', () => {
	it('each, chosen alone, decodes: no text operator on a number, no number against text, no day for "is within"', async () => {
		// every filterable kind on one collection, a description full of literals of every kind, and a found record
		const jobs = (manifest.models as unknown as { jobs: { fields: object } }).jobs;
		const kinds = { ...manifest,
			models: { ...manifest.models, jobs: { ...jobs, fields: { ...jobs.fields, urgent: { kind: 'bool' }, priority: { kind: 'enum', values: ['low', 'normal', 'high'] },
				budget: { kind: 'money', optional: true }, visits: { kind: 'int' }, started_at: { kind: 'instant', optional: true } } } },
			collections: { ...manifest.collections, jobs: { read: { fields: ['title', 'hours', 'notes', 'scheduled_on', 'spot', 'window', 'status', 'tags', 'assignee',
				'urgent', 'priority', 'budget', 'visits', 'started_at'], relations: ['assignee', 'lines'] } } },
		} as unknown as EngineManifest;
		const bob = '00000000-0000-4000-8000-0000000000b0';
		const d = (port: System1Port) => filterDescribe({ manifest: kinds, clock: () => '2026-09-26T00:00:00.000Z', db: { async write() { return []; } } as unknown as TenantDb,
			read: (async (qs: readonly { collection?: string }[]) => qs.map((q) => ({ rows: q.collection === 'members' ? [{ id: bob, name: 'Bob Tan' }] : [] }))) as unknown as ReadEngine['run'],
			ai: { sys_1: port, sys_2: { models: ['x'], async infer() { throw new Error('never'); } } } as unknown as AiPort });
		const ask = { collection: 'jobs', authority: caller(), bindings,
			text: 'urgent high priority jobs for bob tan between 2 and 5 hours with 3 visits after 3rd October, before 2026-10-09, this week, tagged "ac" or pump, not done' };
		const first = system1(() => ({}));
		await d(first).describe(ask);
		const req = first.requests[0]!;
		let offered = 0;
		for (const [id, q] of Object.entries(req.questions)) {
			if (!/^f\d+$/.test(id) || q.type !== 'choice') continue;
			for (const option of Object.keys(q.criteria).filter((k) => k !== 'no condition')) {
				const named = Object.fromEntries(Object.keys(req.questions).filter((k) => k.startsWith(`${id}.`)).map((k) => [k, true]));
				const r = await d(system1(() => ({ [id]: option, ...named }))).describe(ask);
				// chosen alone it builds a filter the strict decode admits; a word the text merely echoes may yield, never fail decode
				if (!r.ok) expect(r.message, option).toMatch(/No field here matches/);
				offered++;
			}
		}
		expect(offered).toBeGreaterThan(150);
	});
});

describe('described selection must fit the exposed grammar', () => {
	const fields = [
		{ name: 'kind', label: 'Kind', kind: 'text' as const },
		{ name: 'version', label: 'Version', kind: 'number' as const }
	];
	it('refuses per-group latest selection instead of silently using global max or descending sort', async () => {
		const records = [
			{ kind: 'nda', version: 2 },
			{ kind: 'nda', version: 3 },
			{ kind: 'msa', version: 5 },
			{ kind: 'sow', version: 2 }
		];
		expect(records.filter((r) => r.version === 5)).toEqual([{ kind: 'msa', version: 5 }]);
		expect(
			[...new Set(records.map((r) => r.kind))].map((kind) =>
				records.filter((r) => r.kind === kind).reduce((a, b) => (a.version > b.version ? a : b))
			)
		).toEqual([
			{ kind: 'nda', version: 3 },
			{ kind: 'msa', version: 5 },
			{ kind: 'sow', version: 2 }
		]);
		const port = system1(
			byField(
				{ Version: { op: 'is', value: '5' } },
				{
					'selection.unsupported': true,
					sort: 'Version, highest first'
				}
			)
		);
		const r = await describer(port).describe({
			collection: '$local',
			text: 'show latest version only for each kind, not merely the global version 5',
			localFields: fields,
			authority: caller({}),
			bindings
		});
		expect(r).toMatchObject({
			ok: false,
			code: 'invalid',
			message: expect.stringMatching(/comparing|ranking/)
		});
		expect(port.requests[0]!.questions['selection.unsupported']).toMatchObject({
			type: 'noul',
			instructions: expect.stringMatching(/top-level records/)
		});
	});
	it('a sort-only description on a collection has an OrderBy and no Where', async () => {
		const port = system1(byField({}, { sort: 'Scheduled on, latest first' }));
		expect(await describer(port).describe({ collection: 'jobs', text: 'latest first', authority: caller(), bindings }))
			.toEqual({ ok: true, orderBy: { scheduled_on: 'desc' } });
	});

	it('allows ordinary newest-first sorting because ordering does not exclude versions', async () => {
		const port = system1(
			byField(
				{},
				{
					'selection.unsupported': false,
					sort: 'Version, highest first'
				}
			)
		);
		expect(
			await describer(port).describe({
				collection: '$local',
				text: 'sort versions newest first',
				localFields: fields,
				authority: caller({}),
				bindings
			})
		).toMatchObject({ ok: true, orderBy: { version: 'desc' } });
	});
	it('admits an explicitly exposed current flag instead of refusing latest wording by keyword', async () => {
		const port = system1(
			byField({ 'Is current': { op: 'is', value: 'yes' } }, { 'selection.unsupported': false })
		);
		const r = await describer(port).describe({
			collection: '$local',
			text: 'latest versions only: current is true',
			localFields: [{ name: 'is_current', label: 'Is current', kind: 'bool' }],
			authority: caller({}),
			bindings
		});
		expect(r).toMatchObject({ ok: true, where: { is_current: { eq: true } } });
	});
});
