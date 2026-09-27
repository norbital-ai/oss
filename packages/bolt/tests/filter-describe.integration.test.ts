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
const BOB: { readonly [id: string]: string | boolean } = {
	'c0.yes': true, 'c0.field': 'Assignee', 'c0.op': 'Assignee · is', 'c0.value': 'Assignee · Bob Tan',
	'c1.yes': true, 'c1.field': 'Scheduled on', 'c1.op': 'Scheduled on · within', 'c1.value': 'Scheduled on · this week',
	'c2.yes': true, 'c2.field': 'Status', 'c2.op': 'Status · is not', 'c2.value': 'Status · a final state',
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
	beforeEach(async () => { port = system1(() => BOB); await open(port); });

	it("Bob's jobs this week that aren't done: three conditions through System 1 alone, every answer an offered option", async () => {
		const r = await describeAs("Bob's jobs this week that aren't done");
		expect(r).toEqual({ ok: true, where: { and: [
			{ assignee: { eq: bob } },
			{ scheduled_on: { gte: { startOf: 'week' }, lt: { startOf: 'week', shift: 1 } } },
			{ status: { nin: ['done'] } },
		] } });
		expect(port.requests).toHaveLength(1);
		const q = Object.fromEntries(Object.entries(port.requests[0]!.questions).map(([id, x]) => [id, options(x)]));
		expect(q['c0.value']).toContain('Assignee · Bob Tan');
		expect(q['c0.value']).toContain('Scheduled on · this week');
		expect(q['c0.field']).not.toContain('Notes'); // masked to the caller: never offered
		expect(await events()).toMatchObject([{ use: 'filter', system: 1 }]);
		expect(metered).toEqual(['ai:decision']);
	});

	it('newest first sets one sort key; the sort slot answers only when asked', async () => {
		await open(port = system1(() => ({ ...BOB, 'c1.yes': false, 'c2.yes': false, 'sort.yes': true, 'sort.field': 'Created',
			'sort.dir': 'descending (newest, highest, Z→A first)' })));
		expect(await describeAs("Bob's open jobs, newest first")).toEqual({ ok: true, where: { assignee: { eq: bob } }, orderBy: { created_at: 'desc' } });
	});

	it('an operator of another field is re-asked with only its field\'s options; never a third request', async () => {
		await open(port = system1((_r, call) => call === 1 ? { ...BOB, 'c0.op': 'Status · is not' } : { 'c0.op': 'Assignee · is', 'c0.value': 'Assignee · Bob Tan' }));
		const r = await describeAs("Bob's jobs this week that aren't done");
		expect(r.ok && r.where).toMatchObject({ and: [{ assignee: { eq: bob } }, {}, {}] });
		expect(port.requests).toHaveLength(2);
		expect(Object.keys(port.requests[1]!.questions)).toEqual(['c0.op', 'c0.value']);
		expect(options(port.requests[1]!.questions['c0.op']).every((o) => o.startsWith('Assignee · '))).toBe(true);
	});

	it('options past the provider\'s cap: fields first, then each chosen field\'s own operators and values', async () => {
		await open(port = Object.assign(system1(() => BOB), { maxChoices: 12 }));
		const r = await describeAs("Bob's jobs this week that aren't done");
		expect(r.ok && r.where).toMatchObject({ and: [{ assignee: { eq: bob } }, {}, {}] });
		expect(port.requests).toHaveLength(2);
		expect(Object.keys(port.requests[0]!.questions).some((id) => id.endsWith('.op') || id.endsWith('.value'))).toBe(false);
		for (const q of [...Object.values(port.requests[0]!.questions), ...Object.values(port.requests[1]!.questions)])
			expect(q.type !== 'choice' || options(q).length <= 12).toBe(true);
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
		expect(options(seen[0]!.questions['c0.value']).filter((o) => o.startsWith('Code · '))).toHaveLength(200);
		// every question is in P37's shape over a structured state
		expect(Object.values(seen[0]!.questions).every((q) => typeof q.instructions === 'string' && q.criteria !== undefined)).toBe(true);
		expect(seen[0]!.state).toMatchObject({ description: 'code c7', collection: 'Jobs', timezone: 'Asia/Singapore' });
	});

	it('without an AI facility the feature is absent', async () => {
		await open();
		expect(t.engine.filters).toBeUndefined();
	});
});

it('literals: quoted strings, numbers and dates from the text', () => {
	expect(literals('jobs over 3 hours named "pump room" before 2026-10-01 or 5/10/2026', 'en')).toEqual({
		strings: ['pump room'], numbers: [3], dates: ['2026-10-01', '2026-10-05'] });
});
