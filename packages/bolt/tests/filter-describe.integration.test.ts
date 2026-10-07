// AI filtering (rule 16a, P33, P34; §11.2 G5) through the engine entry: a scripted `ai.system1` (no vendor) chooses
// among the options the engine builds; the chosen options map 1:1 onto a decoded `Where` and `OrderBy`. There is no
// System 2 path (owner ruling): a System 1 failure applies nothing, and with no AI facility the feature is absent.
import { beforeEach, describe, expect, it } from 'vitest';
import type { AiPort, Authority, EngineManifest, MeteringPort } from '../src/engine/contracts.ts';
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
	const answer = (q: DecisionQuestion, v: string | boolean | undefined): DecisionAnswer => q.type === 'noul' ? { type: 'noul', noul: v === true ? 0.9 : 0.1 }
		: q.type === 'choice' ? { type: 'choice', choice: typeof v === 'string' ? v : Object.keys(q.criteria)[0]!, confidence: 0.9, probabilities: {} }
			: { type: 'score', score: 0, level: 0, confidence: 0.9, probabilities: {}, legend: {} };
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
 * A scripted answer in the request's own shape: which fields the description restricts, and for each of those the
 * operator and the value. The engine numbers the fields it asked about, so the script names them by label; the
 * operator question's own options are how this reads back which number belongs to which field.
 */
type Plan = { readonly [label: string]: { op: string; value: string } | false };
const byField = (plan: Plan, sort: { [id: string]: string | boolean } = {}) => (r: System1Request): { readonly [id: string]: string | boolean } => {
	const answers: { [id: string]: string | boolean } = { ...sort };
	for (const [id, q] of Object.entries(r.questions)) {
		if (q.type !== 'noul' || !id.startsWith('f')) continue;
		const label = options(r.questions[`${id}.op`])[0]!.split(' \u00b7 ')[0]!;
		const a = plan[label];
		if (a === undefined || a === false) { answers[id] = false; continue; }
		answers[id] = true;
		answers[`${id}.op`] = `${label} \u00b7 ${a.op}`;
		answers[`${id}.value`] = `${label} \u00b7 ${a.value}`;
	}
	return answers;
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
		// the conditions follow the order the fields were asked about: the ones the description names, in schema order
		expect(r).toEqual({ ok: true, where: { and: [
			{ scheduled_on: { gte: { startOf: 'week' }, lt: { startOf: 'week', shift: 1 } } },
			{ status: { nin: ['done'] } },
			{ assignee: { eq: bob } },
		] } });
		expect(port.requests).toHaveLength(1);
		const q = port.requests[0]!.questions;
		// each field is asked about on its own, so a value can only ever name its own field
		const values = Object.values(q).flatMap((x) => options(x));
		expect(values).toContain('Assignee \u00b7 Bob Tan');
		expect(values).toContain('Scheduled on \u00b7 this week');
		expect(values).not.toContain('Notes'); // masked to the caller: never offered
		expect(await events()).toMatchObject([{ use: 'filter', system: 1 }]);
		expect(metered).toEqual(['ai:decision']);
	});

	it('newest first sets one sort key; the sort questions ride the same call', async () => {
		// only the assignee is named: a field the plan omits is one the description did not restrict
		await open(port = system1(byField({ Assignee: BOB.Assignee! }, { 'sort.yes': true, 'sort.field': 'Created',
			'sort.dir': 'descending (newest, highest, Z\u2192A first)' })));
		expect(await describeAs("Bob's open jobs, newest first")).toEqual({ ok: true, where: { assignee: { eq: bob } }, orderBy: { created_at: 'desc' } });
		expect(port.requests).toHaveLength(1);
	});

	it('one call answers every field: no operator can name another field, so nothing is ever re-asked', async () => {
		// the old shape offered every field's operators in one question, so an answer could pair one field's operator with
		// another's value, and a second call had to re-ask it. A field's own options make that impossible by construction.
		const r = await describeAs("Bob's jobs this week that aren't done");
		expect(r.ok).toBe(true);
		expect(port.requests).toHaveLength(1);
		for (const [id, q] of Object.entries(port.requests[0]!.questions)) {
			if (q.type !== 'choice' || !id.endsWith('.op')) continue;
			const label = options(q)[0]!.split(' \u00b7 ')[0]!;
			// every option of this question belongs to the one field it asks about
			expect(options(q).every((o) => o.startsWith(`${label} \u00b7 `))).toBe(true);
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
		const count = 'Suspicious activity logs \u203a count';
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
		const codeValue = Object.keys(seen[0]!.questions).find((id) => id.endsWith('.value') && options(seen[0]!.questions[id]).some((o) => o.startsWith('Code \u00b7 ')));
		expect(options(seen[0]!.questions[codeValue!]).filter((o) => o.startsWith('Code \u00b7 '))).toHaveLength(200);
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
			{ 'sort.yes': true, 'sort.field': 'Assignee › Name', 'sort.dir': 'ascending (oldest, lowest, A→Z first)' })));
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
});
