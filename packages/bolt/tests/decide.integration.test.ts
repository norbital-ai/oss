// `ctx.ai.sys_1.decide` (P36, P37; §11.2 G12 (11)) through the engine entry and a built guest: a scripted `ai.sys_1`
// (no vendor) answers the Desk's routing questions; the answers come back typed, a FileRef in the state is refused
// `invalid` before any call (text only, P37 (3)), every call is one `decision.made` (`use: 'author'`) and one meter report, and a
// crashed run replays the journalled answers with no second call. Failures are the facility's typed errors.
import { beforeEach, describe, expect, it } from 'vitest';
import type { AiPort, EngineManifest, MeteringPort, Outcome } from '../src/engine/contracts.ts';
import { ask, type System1Port, type System1Request } from '../src/engine/decisions/index.ts';
import { testWorkspace, type TestWorkspace } from '../src/test/index.ts';

const manifest = {
	workspace: { tz: 'UTC', locale: 'en' },
	models: {
		tickets: { description: 'A ticket', label: 'subject', fields: { subject: { kind: 'text' }, photo: { kind: 'file', accept: ['image/*'], max: '1MiB', optional: true },
			ref_id: { kind: 'text', optional: true }, queue: { kind: 'enum', values: ['billing', 'technical', 'accounts'], optional: true },
			urgent: { kind: 'bool', optional: true }, level: { kind: 'text', optional: true }, note: { kind: 'text', optional: true } } },
		secret_docs: { description: 'Not for the desk', label: 'title', fields: { title: { kind: 'text' }, doc: { kind: 'file', accept: ['image/*'], max: '1MiB', optional: true } } },
	},
	relationships: {},
	collections: {
		tickets: { read: { fields: 'all' }, create: { input: { columns: ['subject', 'photo', 'ref_id'] } }, update: { input: { columns: ['queue', 'urgent', 'level', 'note'] } } },
		secret_docs: { read: { fields: 'all' }, create: { input: { columns: ['title', 'doc'] } } },
	},
	policies: { desk: { description: 'Desk', grants: { tickets: { read: true, create: true, update: true } } } },
	automations: { route: { description: 'Route a new ticket', on: { created: 'tickets' }, runAs: ['desk'] } },
	integrations: {}, pipelines: {}, teams: {}, channels: {}, connections: {}, envoys: {}, mcp: {}, apps: {}, customFields: {}, agent: { skills: {} },
} as unknown as EngineManifest;
const guest = { source: `const questions = {
	queue: { type: 'choice', instructions: 'Which queue?', criteria: { billing: 'money', technical: 'broken', accounts: 'login' } },
	blocked: { type: 'noul', instructions: 'Is the customer blocked?', criteria: { true: 'cannot work', false: 'can work' } },
	urgency: { type: 'score', instructions: 'How urgent?', criteria: ['low', 'medium', 'high'] } };
export default { automation: { route: { body: async (input, ctx) => {
	for (const id of input.ids) {
		const t = await ctx.get('tickets', id, { select: { subject: true, photo: true, ref_id: true } });
		const photo = t.ref_id ? { id: t.ref_id, name: 'x.png', mime: 'image/png' } : t.photo;
		const r = await ctx.ai.sys_1.decide.try({ state: { subject: t.subject, ...(photo ? { photo } : {}) }, questions });
		if ('kind' in r) { await ctx.act('tickets.update', { target: id, set: { note: r.kind } }); continue; }
		await ctx.act('tickets.update', { target: id, set: { queue: r.answers.queue.choice, urgent: r.answers.blocked.noul > 0.5,
			level: r.answers.urgency.level, note: 'cost ' + r.costUsd } });
	}
} } } };` };

type Mode = 'ok' | 'tooLarge' | 'unsupported' | 'offlist' | 'down';
const fake: System1Port & { mode: Mode; calls: System1Request[] } = { mode: 'ok', calls: [],
	async ask(r) {
		fake.calls.push(r);
		if (fake.mode === 'tooLarge' || fake.mode === 'unsupported') throw { kind: fake.mode, message: 'refused by the provider' };
		if (fake.mode === 'down') throw new Error('provider down');
		return { costUsd: 0.0004, provider: 'scripted', answers: {
			queue: { type: 'choice', choice: fake.mode === 'offlist' ? 'sales' : 'billing', confidence: 0.1, probabilities: { billing: 0.1, technical: 0.05, accounts: 0.05 } },
			blocked: { type: 'noul', noul: 0.8 },
			urgency: { type: 'score', score: 1.99, level: 2, confidence: 0.9, probabilities: { 0: 0.01, 1: 0, 2: 0.99 }, legend: { 0: 'low', 1: 'medium', 2: 'high' } } } };
	} };
const ai: AiPort = { sys_1: fake, sys_2: { models: ['default'], async infer() { throw new Error('System 2 is never asked'); } } };
const metered: string[] = [];
const metering: MeteringPort = { async record(meter, q, key) { metered.push(`${meter}:${q}:${key.split(':')[0]}`); } };

let t: TestWorkspace;
const ok = (o: Outcome) => { if (o.kind !== 'committed') throw new Error(JSON.stringify(o)); return o; };
const open = async (o: { ai?: boolean } = {}) => {
	fake.mode = 'ok'; fake.calls = []; metered.length = 0;
	t = await testWorkspace({ manifest, guest, metering, ...(o.ai === false ? {} : { ai }) });
};
const desk = () => t.as(t.member(['desk']));
const ticket = async (set: { [k: string]: unknown }) => ok(await desk().act('tickets.create', { subject: 'Charged twice', ...set } as never)).records[0]!.id;
const events = async () => (await t.db.read([{ text: `SELECT attributes FROM sys_event WHERE event = 'decision.made'`, params: [] }]))[0]!.rows.map((r) => r['attributes']);

describe('ctx.ai.sys_1.decide (P36, P37)', () => {
	beforeEach(() => open());

	it('answers typed from the literals; one event and one meter report', async () => {
		const id = await ticket({});
		await t.runDue();
		// a choice at confidence 0.1 is used as given; a score's level comes back as the level itself
		expect(await desk().get('tickets', id)).toMatchObject({ queue: 'billing', urgent: true, level: 'high', note: 'cost 0.0004' });
		const sent = fake.calls[0]!;
		expect(Object.values(sent.questions).map((q) => q.type)).toEqual(['choice', 'noul', 'score']);
		expect(sent.state).toEqual({ subject: 'Charged twice' });
		expect(await events()).toMatchObject([{ use: 'author', system: 1, automation: 'route', costUsd: 0.0004 }]);
		expect(metered).toEqual(['ai:0.0004:decision']);
	});

	it('a crashed run replays the journalled answers: no second call, no second report', async () => {
		const id = await ticket({});
		const [runs] = await t.db.read([{ text: `SELECT id FROM sys_run WHERE automation = 'route'`, params: [] }]);
		await t.crash(String(runs!.rows[0]!['id']));
		await t.runDue();
		expect(fake.calls).toHaveLength(1);
		expect(metered).toHaveLength(1);
		expect(await desk().get('tickets', id)).toMatchObject({ queue: 'billing' });
	});

	it('refusals and failures are the typed error `.try` returns; no system2 call', async () => {
		for (const [mode, kind] of [['tooLarge', 'tooLarge'], ['unsupported', 'unsupported'], ['offlist', 'invalid'], ['down', 'upstream']] as const) {
			fake.mode = mode;
			const id = await ticket({});
			await t.runDue();
			expect(await desk().get('tickets', id)).toMatchObject({ note: kind });
		}
		expect(metered).toEqual([]); // a failed call has no cost to report
	});

	it('a FileRef in the state is refused invalid before the call, readable or not (P37 (3))', async () => {
		const photo = ok(await desk().upload('tickets.photo', { name: 'p.png', mime: 'image/png', bytes: new Uint8Array([7, 7, 7]) })).output;
		const mine = await ticket({ photo });
		await t.runDue();
		expect(await desk().get('tickets', mine)).toMatchObject({ note: 'invalid' });
		const doc = ok(await t.as(t.admin).upload('secret_docs.doc', { name: 's.png', mime: 'image/png', bytes: new Uint8Array([1]) })).output as { id: string };
		ok(await t.as(t.admin).act('secret_docs.create', { title: 'Payroll', doc } as never));
		const id = await ticket({ ref_id: doc.id });
		await t.runDue();
		expect(await desk().get('tickets', id)).toMatchObject({ note: 'invalid' });
		expect(fake.calls).toHaveLength(0);
	});

	it('with no AI facility decide is Unavailable', async () => {
		await open({ ai: false });
		const id = await ticket({});
		await t.runDue();
		expect(await desk().get('tickets', id)).toMatchObject({ note: 'unavailable' });
	});
});

it('Bolt caps no question or option: a 40-question decide with a 100-option choice reaches sys_1 whole', async () => {
	const seen: System1Request[] = [];
	const port: System1Port = { async ask(r) { seen.push(r); throw { kind: 'tooLarge', message: 'context limit' }; } };
	const criteria = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`o${i}`, `option ${i}`]));
	const questions = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`q${i}`, { type: 'choice' as const, instructions: 'Which?', criteria }]));
	expect(await ask({ sys_1: port, sys_2: { models: [], async infer() { throw new Error('never'); } } }, { state: { text: 'x' }, questions })).toMatchObject({ kind: 'tooLarge' });
	expect(Object.keys(seen[0]!.questions)).toHaveLength(40);
	expect(Object.keys((seen[0]!.questions['q39'] as { criteria: object }).criteria)).toHaveLength(100);
});
