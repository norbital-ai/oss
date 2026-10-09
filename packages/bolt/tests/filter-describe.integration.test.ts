// AI filtering (rule 16a, P33, P34; §11.2 G5) through the engine entry: a scripted `ai.system1` (no vendor) chooses
// among the options the engine builds; the chosen options map 1:1 onto a decoded `Where` and `OrderBy`. There is no
// System 2 path (owner ruling): a System 1 failure applies nothing, and with no AI facility the feature is absent.
import { beforeEach, describe, expect, it } from 'vitest';
import type { AiPort, Authority, EngineManifest, MeteringPort } from '../src/engine/contracts.ts';
import type { Json } from '../src/decl/values.ts';
import type { DecisionAnswer, DecisionQuestion, System1Port, System1Request } from '../src/engine/decisions/index.ts';
import { literals } from '../src/engine/filter-describe/index.ts';
import { testWorkspace, type TestWorkspace } from '../src/test/index.ts';

const manifest = {
	workspace: { tz: 'Asia/Singapore', locale: 'en' },
	models: {
		members: { description: 'A member of staff', label: 'name', fields: { name: { kind: 'text' } } },
		jobs: { description: 'A job', label: 'title', fields: {
			title: { kind: 'text' }, scheduled_on: { kind: 'date' }, hours: { kind: 'decimal', scale: 1, optional: true }, notes: { kind: 'text', optional: true },
			status: { kind: 'state', initial: 'scheduled', states: { scheduled: { to: ['in_progress'] }, in_progress: { to: ['done'] }, done: {} } } } },
	},
	relationships: { 'jobs.assignee': { to: 'members', inverse: 'assigned_jobs' } },
	collections: {
		members: { read: { fields: 'all' }, create: { input: { columns: ['name'] } } },
		jobs: { read: { fields: 'all' }, create: { input: { columns: ['title', 'scheduled_on', 'status', 'assignee'] } } },
	},
	integrations: {}, pipelines: {},
	// `notes` is masked to the dispatcher: its one read arm lists the fields it reads
	policies: { dispatch: { description: 'Dispatch', grants: { members: { read: true },
		jobs: { read: { fields: ['id', 'title', 'scheduled_on', 'hours', 'status', 'assignee', 'created_at', 'updated_at'] } } } } },
	teams: {}, automations: {}, channels: {}, connections: {}, envoys: {}, mcp: {}, apps: {}, customFields: {}, agent: { skills: {} },
} as unknown as EngineManifest;

/** A scripted System 1: `pick` maps question ids to a choice or a noul; any other question gets its first option or 0. */
function system1(pick: (r: System1Request, call: number) => { readonly [id: string]: string | boolean }) {
	const answer = (q: DecisionQuestion, v: string | boolean | undefined): DecisionAnswer => {
		if (q.type === 'noul') return { type: 'noul', noul: v === true ? 0.9 : 0.1 };
		const choice = q.type === 'choice' ? typeof v === 'string' ? v : Object.keys(q.criteria)[0]! : '';
		return q.type === 'choice' ? { type: 'choice', choice, confidence: 0.9, probabilities: { [choice]: 0.9 } }
			: { type: 'score', score: 0, level: 0, confidence: 0.9, probabilities: {}, legend: {} };
	};
	const port: System1Port & { requests: System1Request[]; throws: boolean } = { requests: [], throws: false,
		async ask(r) {
			port.requests.push(r);
			if (port.throws) throw new Error('provider down');
			const chosen = pick(r, port.requests.length);
			return { costUsd: 0.00003, provider: 'scripted', answers: Object.fromEntries(Object.entries(r.questions).map(([id, q]) => [id, answer(q, chosen[id])])) };
		} };
	return port;
}
const options = (q: DecisionQuestion | undefined) => q?.type === 'choice' ? Object.keys(q.criteria) : [];
const ai = (s: System1Port): AiPort => ({ sys_1: s, sys_2: { models: ['fast'], async infer() { throw new Error('System 2 is never asked') } } });
/**
 * A scripted answer in the request's own shape: per field the whole condition the description states ("Title contains
 * “pump”"), or none when the plan omits the field. The engine numbers the fields it asked about in the state's order, so
 * the script names them by label. A list operator names its values, each its own yes / no.
 */
type Plan = { readonly [label: string]: { op: string; value?: string; values?: readonly string[] } | false };
const byField = (plan: Plan, extra: { [id: string]: string | boolean } = {}) => (r: System1Request): { readonly [id: string]: string | boolean } => {
	const pick: { [id: string]: string | boolean } = { ...extra };
	for (const [id, q] of Object.entries(r.questions)) {
		if (q.type !== 'choice' || !/^f\d+$/.test(id)) continue;
		const label = (r.state['fields'] as { label: string }[])[Number(id.slice(1)) - 1]!.label, a = plan[label];
		if (a === undefined || a === false) continue; // its first option: no condition
		const want = a.values !== undefined ? [`${label} ${a.op} the ones named`] : [`${label} ${a.op}${a.value === undefined ? '' : ` ${a.value}`}`, `${label} ${a.op} \u201c${a.value}\u201d`];
		const hit = Object.keys(q.criteria).find((k) => want.includes(k));
		if (hit === undefined) throw new Error(`no option "${want[0]}" among: ${Object.keys(q.criteria).join(' | ')}`);
		pick[id] = hit;
		for (const [v, nq] of Object.entries(r.questions)) if (v.startsWith(`${id}.`) && a.values?.some((x) => nq.instructions.startsWith(`Is ${x} one of`))) pick[v] = true;
	}
	return pick;
};
const BOB: Plan = {
	Assignee: { op: 'is', value: 'Bob Tan' },
	'Scheduled on': { op: 'is within', value: 'this week' },
	Status: { op: 'is none of', value: 'a final state' }
};

let t: TestWorkspace, caller: Authority, bob = '';
const metered: string[] = [];
const metering: MeteringPort = { async record(meter, _q, key) { metered.push(`${meter}:${key.split(':')[0]}`); } };
const open = async (port?: System1Port) => {
	metered.length = 0;
	t = await testWorkspace({ manifest, metering, ...(port === undefined ? {} : { ai: ai(port) }) });
	const o = await t.as(t.admin).act('members.create', { name: 'Bob Tan' });
	if (o.kind !== 'committed') throw new Error(o.kind);
	bob = o.records[0]!.id;
	await t.as(t.admin).act('members.create', { name: 'Alice Ng' });
	caller = t.as(t.member(['dispatch'])).authority;
};
const describeAs = (text: string) => t.engine.filters!.describe({ collection: 'jobs', text, authority: caller,
	bindings: { now: t.clock.now(), today: t.clock.now().slice(0, 10), tz: 'Asia/Singapore', params: {} } });
const events = async () => (await t.db.read([{ text: `SELECT attributes FROM sys_event WHERE event = 'decision.made'`, params: [] }]))[0]!.rows
	.map((r) => r['attributes'] as { use: string; system: number });

describe('filter.describe (rule 16a)', () => {
	let port: ReturnType<typeof system1>;
	beforeEach(async () => { port = system1(byField(BOB)); await open(port); });

	it("Bob's jobs this week that aren't done: three conditions from ONE System 1 call, every answer an offered option", async () => {
		const r = await describeAs("Bob's jobs this week that aren't done");
		expect(r).toMatchObject({ ok: true, where: { and: expect.arrayContaining([
			{ scheduled_on: { gte: { startOf: 'week' }, lt: { startOf: 'week', shift: 1 } } },
			{ status: { nin: ['done'] } },
			{ assignee: { eq: bob } },
		]) } });
		expect(r.ok && (r.where as { and: unknown[] }).and).toHaveLength(3);
		expect(port.requests).toHaveLength(1);
		const q = port.requests[0]!.questions;
		// each field is asked about on its own, as whole conditions, so a value can only ever name its own field
		const values = Object.values(q).flatMap((x) => options(x));
		expect(values).toContain('Assignee is Bob Tan');
		expect(values).toContain('Scheduled on is within this week');
		expect(values).not.toContain('Notes'); // masked to the caller: never offered
		expect(await events()).toMatchObject([{ use: 'filter', system: 1 }]);
		expect(metered).toEqual(['ai:decision']);
	});

	it('newest first sets one sort key; the sort questions ride the same call', async () => {
		// only the assignee is named: a field the plan omits is one the description did not restrict
		await open(port = system1(byField({ Assignee: BOB.Assignee! }, { sort: 'Created, latest first' })));
		expect(await describeAs("Bob's open jobs, newest first")).toEqual({ ok: true, where: { assignee: { eq: bob } }, orderBy: { created_at: 'desc' } });
		expect(port.requests).toHaveLength(1);
	});

	it('one call answers every field: each question offers only its own field\'s whole conditions', async () => {
		// an operator and a value asked apart could disagree (a day for "is within", one value for "is any of"); a field's
		// whole conditions, each decoded before it is offered, make a mismatch impossible by construction
		const r = await describeAs("Bob's jobs this week that aren't done");
		expect(r.ok).toBe(true);
		expect(port.requests).toHaveLength(1);
		const req = port.requests[0]!;
		for (const [id, q] of Object.entries(req.questions)) {
			if (!/^f\d+$/.test(id)) continue;
			const label = (req.state['fields'] as { label: string }[])[Number(id.slice(1)) - 1]!.label;
			expect(options(q).every((o) => o === 'no condition' || o.startsWith(`${label} `))).toBe(true);
		}
	});

	it('a wide collection is asked about the fields the description names, still in one call', async () => {
		const jobs = (manifest.models as unknown as { jobs: { fields: object } }).jobs;
		const wide = { ...manifest, models: { ...manifest.models, jobs: { ...jobs, fields: { ...jobs.fields,
			...Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`filler_${i}`, { kind: 'text' as const }])) } } } } as unknown as EngineManifest;
		const seen: System1Request[] = [];
		const t2 = await testWorkspace({ manifest: wide, metering, ai: ai({ async ask(r) {
			seen.push(r);
			return { costUsd: 0, provider: 'scripted', answers: Object.fromEntries(Object.entries(r.questions).map(([id, q]) => [id,
				q.type === 'noul' ? { type: 'noul', noul: 0.1 } : { type: 'choice', choice: Object.keys(q.criteria)[0]!, confidence: 1, probabilities: {} }])) };
		} }) });
		await t2.engine.filters!.describe({ collection: 'jobs', text: "Bob's jobs this week", authority: t2.as(t2.admin).authority,
			bindings: { now: t2.clock.now(), today: t2.clock.now().slice(0, 10), tz: 'Asia/Singapore', params: {} } });
		expect(seen).toHaveLength(1);
		const asked = Object.keys(seen[0]!.questions).filter((id) => id.startsWith('f') && !id.includes('.'));
		expect(asked.length).toBe(16);
		// the field the description names is asked first, and the fillers that name nothing come after everything real
		const labels = (seen[0]!.state.fields as { label: string }[]).map((f) => f.label);
		expect(labels.indexOf('Assignee')).toBeLessThan(labels.findIndex((l: string) => l.startsWith('Filler')));
	});

	it('a wide parent reaches a child count the description names in another inflection ("those with 1 suspicion log")', async () => {
		// the field-operations shape: a wide parent of numeric fields (a number in the text makes each of them a candidate),
		// its child relation named in the plural and in another word form, each child field also offered under any / all /
		// none. The count the description names must still be one of the sixteen fields asked about.
		const wide = { ...manifest,
			models: { ...manifest.models,
				members: { description: 'A member of staff', label: 'name', fields: { name: { kind: 'text' }, suspicion_checked_at: { kind: 'instant', optional: true },
					grade: { kind: 'state', initial: 'junior', states: { junior: { to: ['senior'] }, senior: {} } },
					...Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`tally_${i}`, { kind: 'int' as const }])) } },
				suspicious_activity_logs: { description: 'A finding', label: 'summary', fields: { summary: { kind: 'text' }, severity: { kind: 'int' },
					note: { kind: 'text', optional: true }, raised_on: { kind: 'date' } } } },
			relationships: { ...manifest.relationships, 'suspicious_activity_logs.member': { to: 'members', inverse: 'suspicious_activity_logs' } },
			collections: { ...manifest.collections, suspicious_activity_logs: { read: { fields: 'all' }, create: { input: { columns: ['summary', 'severity', 'raised_on', 'member'] } } } },
		} as unknown as EngineManifest;
		const count = 'Number of suspicious activity logs';
		const t2 = await testWorkspace({ manifest: wide, metering, ai: ai(system1(byField({ [count]: { op: 'at least', value: '1' } }))) });
		const r = await t2.engine.filters!.describe({ collection: 'members', text: 'those with 1 suspicion log', authority: t2.as(t2.admin).authority,
			bindings: { now: t2.clock.now(), today: t2.clock.now().slice(0, 10), tz: 'Asia/Singapore', params: {} } });
		expect(r).toEqual({ ok: true, where: { suspicious_activity_logs: { count: { gte: 1 } } } });
		// a second condition the description names still has a place beside the child relation's many options
		const seen: System1Request[] = [];
		const t3 = await testWorkspace({ manifest: wide, metering, ai: ai({ async ask(q) { seen.push(q); return { costUsd: 0, provider: 's', answers: Object.fromEntries(Object.entries(q.questions)
			.map(([id, x]) => [id, x.type === 'noul' ? { type: 'noul', noul: 0.1 } : { type: 'choice', choice: Object.keys(x.criteria)[0]!, confidence: 1, probabilities: {} }])) }; } }) });
		await t3.engine.filters!.describe({ collection: 'members', text: 'seniors with 1 suspicion log', authority: t3.as(t3.admin).authority,
			bindings: { now: t3.clock.now(), today: t3.clock.now().slice(0, 10), tz: 'Asia/Singapore', params: {} } });
		expect((seen[0]!.state.fields as { label: string }[]).map((f) => f.label)).toEqual(expect.arrayContaining([count, 'Grade']));
	});

	it('a failed System 1 call applies nothing and is recorded', async () => {
		port.throws = true;
		expect(await describeAs('jobs over 3 hours')).toMatchObject({ ok: false, code: 'upstream' });
		expect(await events()).toMatchObject([{ use: 'filter', system: 1, error: 'upstream' }]);
		expect(metered).toEqual([]);
	});

	it('Bolt caps no option set: 200 values are offered whole; a TooLarge refusal applies nothing', async () => {
		const jobs = (manifest.models as unknown as { jobs: { fields: object } }).jobs;
		const wide = { ...manifest, models: { ...manifest.models, jobs: { ...jobs, fields: { ...jobs.fields,
			code: { kind: 'enum', values: Array.from({ length: 200 }, (_, i) => `c${i}`) } } } } } as unknown as EngineManifest;
		const seen: System1Request[] = [];
		const refusing: System1Port = { async ask(r) { seen.push(r); throw { kind: 'tooLarge', message: 'context limit' }; } };
		t = await testWorkspace({ manifest: wide, metering, ai: ai(refusing) });
		const r = await t.engine.filters!.describe({ collection: 'jobs', text: 'code c7', authority: t.as(t.admin).authority,
			bindings: { now: t.clock.now(), today: t.clock.now().slice(0, 10), tz: 'Asia/Singapore', params: {} } });
		expect(r).toMatchObject({ ok: false, code: 'tooLarge' });
		const code = Object.values(seen[0]!.questions).find((q) => options(q).some((o) => o.startsWith('Code is c')));
		expect(options(code).filter((o) => /^Code is c\d+$/.test(o))).toHaveLength(200);
		// every question is in P37's shape over a structured state
		expect(Object.values(seen[0]!.questions).every((q) => typeof q.instructions === 'string' && q.criteria !== undefined)).toBe(true);
		expect(seen[0]!.state).toMatchObject({ description: 'code c7', collection: 'Jobs', timezone: 'Asia/Singapore' });
	});

	it('without an AI facility options still serve the builder and describing refuses', async () => {
		await open();
		expect(t.engine.filters).toBeDefined();
		const opts = await t.engine.filters!.options({ collection: 'jobs', authority: caller, bindings: { now: t.clock.now(), today: t.clock.now().slice(0, 10), tz: 'Asia/Singapore', params: {} } });
		expect(opts.ok).toBe(true);
		const r = await describeAs('jobs over 3 hours');
		expect(r).toMatchObject({ ok: false, code: 'notFound' });
	});

	const commit = async (input: { title: string; assignee?: string }) => {
		const o = await t.as(t.admin).act('jobs.create', { title: input.title, scheduled_on: '2026-09-28', ...(input.assignee === undefined ? {} : { assignee: input.assignee }) });
		if (o.kind !== 'committed') throw new Error(o.kind);
		return o.records[0]!.id;
	};
	const titles = async (where?: object, orderBy?: object) =>
		(await t.as(caller).read('jobs', { all: true, ...(where !== undefined && Object.keys(where).length > 0 ? { where } : {}), ...(orderBy === undefined ? {} : { orderBy }), select: { title: true } })).rows.map((r) => r['title']);

	it('OR from a description selects the union of matching rows', async () => {
		await open(port = system1(byField({ Title: { op: 'contains', value: 'pump' }, Assignee: { op: 'is', value: 'Bob Tan' } }, { combine: 'any of them hold' })));
		const alice = (await t.as(t.admin).read('members', { where: { name: { eq: 'Alice Ng' } }, all: true })).rows[0]!['id'] as string;
		await commit({ title: 'pump room', assignee: alice });
		await commit({ title: 'install', assignee: bob });
		await commit({ title: 'other', assignee: alice });
		const r = await describeAs("pump jobs or Bob's jobs");
		expect(r).toMatchObject({ ok: true, where: { or: expect.arrayContaining([{ title: { like: '%pump%' } }, { assignee: { eq: bob } }]) } });
		expect((await titles((r as { where: object }).where)).sort()).toEqual(['install', 'pump room']);
	});

	it('a related-field condition from a description selects those rows', async () => {
		await open(port = system1(byField({ 'Assignee › Name': { op: 'contains', value: 'bob' } })));
		const alice = (await t.as(t.admin).read('members', { where: { name: { eq: 'Alice Ng' } }, all: true })).rows[0]!['id'] as string;
		await commit({ title: 'bob job', assignee: bob });
		await commit({ title: 'alice job', assignee: alice });
		const r = await describeAs('jobs whose assignee name contains bob');
		expect(r).toEqual({ ok: true, where: { assignee: { is: { name: { like: '%bob%' } } } } });
		expect(await titles((r as { where: object }).where)).toEqual(['bob job']);
	});

	it('a related sort from a description orders the matching rows', async () => {
		await open(port = system1(byField({},
			{ sort: 'Assignee › Name, A to Z' })));
		const alice = (await t.as(t.admin).read('members', { where: { name: { eq: 'Alice Ng' } }, all: true })).rows[0]!['id'] as string;
		await commit({ title: 'zzz job', assignee: bob });
		await commit({ title: 'aaa job', assignee: alice });
		const r = await describeAs('sorted by assignee name');
		expect(r).toEqual({ ok: true, orderBy: { assignee: { name: 'asc' } } });
		expect(await titles(undefined, (r as { orderBy: object }).orderBy)).toEqual(['aaa job', 'zzz job']);
	});
});

it('literals: quoted strings, numbers and dates from the text', () => {
	expect(literals('jobs over 3 hours named "pump room" before 2026-10-01 or 5/10/2026', 'en')).toEqual({
		strings: ['pump room'], numbers: [3], dates: ['2026-10-01', '2026-10-05'] });
	// a named month, its year today's unless stated; a day the month lacks is no date
	expect(literals('after 3rd October, before Oct 9th 2027, the 1st of jan or 31 June', 'en', '2026-10-08').dates.sort()).toEqual(['2026-01-01', '2026-10-03', '2027-10-09']);
	expect(literals('jobs with 3 decimal places in march', 'en', '2026-10-08')).toEqual({ strings: [], numbers: [3], dates: [] });
});

describe('dates and relations a description names (live Jev misreadings, 2026-10-08)', () => {
	const at = { now: '2026-10-08T03:00:00.000Z', today: '2026-10-08', tz: 'Asia/Singapore', params: {} };
	// members carry a search document: their candidates come from the indexed search, not a label scan
	const searchable = { ...manifest, models: { ...manifest.models, members: { ...manifest.models['members'], search: { text: ['name'] } } } } as unknown as EngineManifest;
	const run = async (text: string, plan: Plan, sort: { [id: string]: string | boolean } = {}) => {
		const p = system1(byField(plan, sort));
		const w = await testWorkspace({ manifest: searchable, ai: ai(p) });
		const o = await w.as(w.admin).act('members.create', { name: 'Bob Tan' });
		if (o.kind !== 'committed') throw new Error(o.kind);
		const r = await w.engine.filters!.describe({ collection: 'jobs', text, authority: w.as(w.admin).authority, bindings: at });
		return { r, bob: o.records[0]!.id, offered: Object.values(p.requests[0]!.questions).flatMap((q) => options(q)) };
	};

	it('"after 3rd October" offers that day: a date is after it, an instant from the next midnight in the workspace zone', async () => {
		const date = await run('jobs scheduled after 3rd October', { 'Scheduled on': { op: 'after', value: '2026-10-03' } });
		expect(date.r).toEqual({ ok: true, where: { scheduled_on: { gt: '2026-10-03' } } });
		const instant = await run('jobs created after 3rd October', { Created: { op: 'after', value: '2026-10-03' } });
		expect(instant.offered).toContain('Created after 2026-10-03');
		expect(instant.r).toEqual({ ok: true, where: { created_at: { gte: '2026-10-03T16:00:00.000Z' } } });
		expect((await run('jobs created on 3 Oct', { Created: { op: 'is within', value: '2026-10-03' } })).r)
			.toEqual({ ok: true, where: { created_at: { gte: '2026-10-02T16:00:00.000Z', lt: '2026-10-03T16:00:00.000Z' } } });
	});

	it('after a span is from its end, on or before it up to its end', async () => {
		expect((await run('jobs scheduled after last week', { 'Scheduled on': { op: 'after', value: 'last week' } })).r)
			.toEqual({ ok: true, where: { scheduled_on: { gte: { startOf: 'week' } } } });
		expect((await run('jobs scheduled on or before this month', { 'Scheduled on': { op: 'on or before', value: 'this month' } })).r)
			.toEqual({ ok: true, where: { scheduled_on: { lt: { startOf: 'month', shift: 1 } } } });
	});

	it("a possessive finds its owner through the search index (\"Bob's jobs\" offered no Bob Tan)", async () => {
		const { r, bob, offered } = await run("Bob's jobs", { Assignee: { op: 'is', value: 'Bob Tan' } });
		expect(offered).toContain('Assignee is Bob Tan');
		expect(r).toEqual({ ok: true, where: { assignee: { eq: bob } } });
	});

	it('a relation pinned to a found record takes no echoed word under it ("bbo tan" also read Name is "tan")', async () => {
		const { r, bob } = await run('jobs for bbo tan', { Assignee: { op: 'is', value: 'Bob Tan' }, 'Assignee \u203a Name': { op: 'is', value: 'tan' } });
		expect(r).toEqual({ ok: true, where: { assignee: { eq: bob } } });
	});
});

describe('named days, lists, ranges and a related record\'s own related records (2026-10-09)', () => {
	const at = { now: '2026-10-08T03:00:00.000Z', today: '2026-10-08', tz: 'Asia/Singapore', params: {} };
	const shop = {
		workspace: { tz: 'Asia/Singapore', locale: 'en' },
		models: {
			customers: { description: 'A customer', label: 'name', search: { text: ['name'] }, fields: { name: { kind: 'text' } } },
			invoices: { description: 'An invoice', label: 'number', fields: { number: { kind: 'text' }, status: { kind: 'enum', values: ['paid', 'unpaid'] } } },
			holidays: { description: 'A holiday', label: 'name', fields: { name: { kind: 'text' }, date: { kind: 'date' } } },
			jobs: { description: 'A job', label: 'title', fields: { title: { kind: 'text' }, scheduled_on: { kind: 'date' }, hours: { kind: 'decimal', scale: 1 },
				status: { kind: 'enum', values: ['scheduled', 'in_progress', 'done'] } } },
		},
		relationships: { 'jobs.customer': { to: 'customers', inverse: 'jobs', optional: true }, 'invoices.customer': { to: 'customers', inverse: 'invoices' } },
		collections: {
			customers: { read: { fields: 'all' }, create: { input: { columns: ['name'] } } },
			invoices: { read: { fields: 'all' }, create: { input: { columns: ['number', 'status', 'customer'] } } },
			holidays: { read: { fields: 'all' }, create: { input: { columns: ['name', 'date'] } } },
			jobs: { read: { fields: 'all' }, create: { input: { columns: ['title', 'scheduled_on', 'hours', 'status', 'customer'] } } },
		},
		integrations: {}, pipelines: {}, policies: {}, teams: {}, automations: {}, channels: {}, connections: {}, envoys: {}, mcp: {}, apps: {}, customFields: {}, agent: { skills: {} },
	} as unknown as EngineManifest;
	const setup = async (plan: Plan, extra: { [id: string]: string | boolean } = {}) => {
		const p = system1(byField(plan, extra));
		const w = await testWorkspace({ manifest: shop, ai: ai(p) });
		const a = w.as(w.admin);
		const id = async (c: string, row: { [k: string]: Json }) => { const o = await a.act(`${c}.create`, row); if (o.kind !== 'committed') throw new Error(JSON.stringify(o)); return o.records[0]!.id; };
		const acme = await id('customers', { name: 'Acme' }), globex = await id('customers', { name: 'Globex' });
		await id('invoices', { number: 'INV-1', status: 'unpaid', customer: acme });
		await id('invoices', { number: 'INV-2', status: 'paid', customer: globex });
		for (const [name, date] of [['National Day', '2025-08-09'], ['National Day', '2026-08-09'], ['Company Day', '2026-10-01']]) await id('holidays', { name: name!, date: date! });
		for (const [title, scheduled_on, hours, status, customer] of [['pump room', '2026-10-06', 3, 'scheduled', acme], ['roof leak', '2026-09-20', 8, 'done', globex],
			['door hinge', '2026-10-02', 1, 'in_progress', null]] as const) await id('jobs', { title, scheduled_on, hours, status, ...(customer === null ? {} : { customer }) });
		const describe = async (collection: string, text: string) => {
			const r = await w.engine.filters!.describe({ collection, text, authority: a.authority, bindings: at });
			const label = collection === 'jobs' ? 'title' : 'name';
			const rows = r.ok ? (await a.read(collection, { all: true, ...(r.where === undefined ? {} : { where: r.where }), select: { [label]: true } } as never)).rows.map((x) => x[label]).sort() : [];
			return { r, rows, offered: Object.values(p.requests.at(-1)!.questions).flatMap((q) => options(q)) };
		};
		return describe;
	};

	it('a named day is a record the caller reads with a date, its nearest occurrence, applied once', async () => {
		const d = await setup({ 'Scheduled on': { op: 'after', value: 'National Day (2026-08-09)' }, Created: { op: 'after', value: 'National Day (2026-08-09)' } });
		const { r, offered } = await d('jobs', 'jobs scheduled after national day');
		expect(offered).toContain('Scheduled on after National Day (2026-08-09)');
		expect(offered).not.toContain('Scheduled on after National Day (2025-08-09)'); // the occurrence nearest today
		// the day reads once: one date condition, never both "scheduled after" and "created after"
		expect(r).toMatchObject({ ok: true });
		expect(JSON.stringify((r as { where: object }).where).match(/2026-08-09/g)).toHaveLength(1);
	});

	it('a related record\'s own related records: "jobs whose customer has an unpaid invoice"', async () => {
		const d = await setup({ 'Customer › Invoices (any) › Status': { op: 'is', value: 'unpaid' } });
		const { r, rows } = await d('jobs', 'jobs whose customer has an unpaid invoice');
		expect(r).toEqual({ ok: true, where: { customer: { is: { invoices: { some: { status: { eq: 'unpaid' } } } } } } });
		expect(rows).toEqual(['pump room']);
	});

	it('presence and absence of related records need no number in the text', async () => {
		expect((await (await setup({ Customer: { op: 'is not empty' } }))('jobs', 'jobs with a customer')).rows).toEqual(['pump room', 'roof leak']);
		const none = await (await setup({ 'Number of invoices': { op: 'is', value: '0' } }))('customers', 'customers with no invoices');
		expect(none.r).toEqual({ ok: true, where: { invoices: { count: { eq: 0 } } } });
		expect(none.rows).toEqual([]);
		const one = await (await setup({ 'Invoices (any) › Status': { op: 'is', value: 'unpaid' }, 'Number of invoices': { op: 'at least', value: '1' } }))('customers', 'customers with at least 1 unpaid invoice');
		expect(one.r).toEqual({ ok: true, where: { invoices: { some: { status: { eq: 'unpaid' } } } } }); // "at least one" is implied
	});

	it('"is any of" takes the values the description names, each its own yes / no; "between" takes two of its numbers', async () => {
		const any = await (await setup({ Status: { op: 'is any of', values: ['scheduled', 'done'] } }))('jobs', 'scheduled or done jobs');
		expect(any.r).toEqual({ ok: true, where: { status: { in: ['scheduled', 'done'] } } });
		expect(any.rows).toEqual(['pump room', 'roof leak']);
		const between = await (await setup({ Hours: { op: 'between 2 and 8' } }))('jobs', 'jobs between 2 and 8 hours');
		expect(between.r).toEqual({ ok: true, where: { hours: { gte: 2, lte: 8 } } });
		expect(between.rows).toEqual(['pump room', 'roof leak']);
	});
});
