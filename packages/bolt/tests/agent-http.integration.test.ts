// The agent's conversation controls over `/__bolt/act` (§5.9's generated actions; parity 2.17, 3.2–3.6, 3.13): the
// author alone revises, reorders and removes queued input; stop, resume, the model class, plan execution and discard;
// an envoy conversation is read-only here (rule 61) and visible only to its own DM sender, a group's participants, or
// any internal member on a `public` envoy — never to an admin as such.
import { describe, expect, it } from 'vitest';
import type { Json } from '../src/decl/values.ts';
import type { AiPort, AiResponse, EngineManifest, Outcome } from '../src/engine/contracts.ts';
import { conversationId } from '../src/engine/channels/store.ts';
import { Authorities } from '../src/engine/identity/actor.ts';
import { boltHandler } from '../src/protocol/http.ts';
import { respondSystem1, testWorkspace } from '../src/test/index.ts'; // hook:decisions

const manifest = {
	workspace: { tz: 'UTC', locale: 'en', agent: { triage: false } },
	models: { quotes: { description: 'A quote', label: 'title', fields: { title: { kind: 'text' } } } },
	relationships: {},
	collections: { quotes: { read: { fields: 'all' }, create: { input: { columns: ['title'] } } } },
	policies: { rep: { description: 'Rep', grants: { quotes: { read: true } } } },
	envoys: { field: { channel: 'field', audience: 'authenticated', name: 'Norbius', policies: ['rep'], triage: false, groupMessages: 'mention_or_reply', delegation: 'disabled', task: 'Help.' },
		desk: { channel: 'desk', audience: 'public', name: 'Norbius', policies: ['rep'], triage: false, groupMessages: 'disabled', delegation: 'disabled', task: 'Help.' } },
	channels: { field: { transport: 'whatsapp' }, desk: { transport: 'whatsapp' } },
	agent: { internal: 'Staff brief.', external: 'Customer brief.', skills: {} },
	integrations: {}, pipelines: {}, teams: {}, automations: {}, connections: {}, mcp: {}, apps: {}, customFields: {},
} as unknown as EngineManifest;

const reply = (text: string): AiResponse => ({ content: text, toolCalls: [], finish: 'stop', usage: { input: 1, output: 1 } });

async function setup() {
	const answers: string[] = [];
	const ai: AiPort = { sys_1: respondSystem1, sys_2: { models: ['default'], async infer(req) {
		answers.push(req.system?.includes('independent verification') === true ? 'verdict' : 'turn');
		return reply(req.system?.includes('independent verification') === true ? JSON.stringify({ complete: true, gaps: [], summary: 'ok' }) : 'ok');
	} } };
	const t = await testWorkspace({ manifest, ai });
	for (const [id, kind, admin, phone] of [['ann', 'staff', false, null], ['bob', 'staff', false, '6590000002'], ['cus', 'external', false, null],
		['kim', 'staff', false, '6590000001'], ['adm', 'staff', true, null]] as const)
		await t.db.write({ text: `INSERT INTO sys_user (id, email, name, kind, admin, phone) VALUES ($1, $2, $1, $3, $4, $5)`, params: [id, `${id}@x.test`, kind, admin, phone] });
	const authorities = new Authorities(manifest, 'test');
	const bolt = boltHandler({ engine: t.engine, uuid: () => crypto.randomUUID(), bindings: () => ({ now: t.clock.now(), today: t.clock.now().slice(0, 10), tz: 'UTC', params: {} }),
		session: async (r) => authorities.member(t.db, r.headers.get('x-user') ?? '') });
	const call = (as: string, method: string, path: string, body?: unknown) => bolt(new Request(`http://cell${path}`, { method,
		headers: { 'x-user': as, 'content-type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
	const act = async (as: string, callable: string, input: Json) =>
		(await (await call(as, 'POST', '/__bolt/act', { callable, input, issuedAt: t.clock.now() }))!.json() as { outcome: Outcome }).outcome;
	const rows = async (c: string) => (await t.db.read([{ text: `SELECT id, text, state FROM sys_message WHERE conversation = $1 ORDER BY seq`, params: [c] }]))[0]!.rows;
	return { t, bolt, call, act, rows, answers };
}

describe('conversation controls over /__bolt/act', () => {
	it('only the author revises, reorders and removes queued input; stop, resume, the model class, and a plan executed or discarded', async () => {
		const { t, bolt, act, rows, answers } = await setup();
		const agent = t.engine.agents, c = await agent.start({ owner: 'ann' });
		const [one, two, three] = [await agent.post({ conversation: c, as: { member: 'ann' }, text: 'one' }), await agent.post({ conversation: c, as: { member: 'ann' }, text: 'two' }),
			await agent.post({ conversation: c, as: { member: 'ann' }, text: 'three' })];
		expect(await act('bob', 'sys_message.revise', { message: one.id, text: 'hijack' })).toMatchObject({ kind: 'refused', code: 'notFound' });
		expect(await act('ann', 'sys_message.reorder', { conversation: c, messages: [three.id, one.id, two.id] })).toMatchObject({ kind: 'committed' });
		expect(await act('ann', 'sys_message.dequeue', { message: two.id })).toMatchObject({ kind: 'committed' });
		expect((await rows(c)).map((r) => [r['text'], r['state']])).toEqual([['three', 'queued'], ['one', 'queued'], ['two', 'cancelled']]);
		expect(await act('ann', 'sys_conversation.setModel', { conversation: c, model: 'vision' })).toMatchObject({ kind: 'refused' });
		expect(await act('ann', 'sys_message.revise', { message: one.id, text: 'one, revised' })).toMatchObject({ kind: 'committed' });
		await bolt.settled();
		expect((await rows(c)).find((r) => r['id'] === one.id)).toMatchObject({ text: 'one, revised', state: 'consumed' });
		expect(await act('ann', 'sys_conversation.stop', { conversation: c })).toMatchObject({ kind: 'committed' });
		expect((await agent.conversation(c)).status).toBe('stopped');
		await act('ann', 'sys_conversation.resume', { conversation: c });
		await bolt.settled();
		expect((await agent.conversation(c)).status).toBe('idle');
		await t.db.write({ text: `UPDATE sys_conversation SET plan = '{"revision":1,"body":"1. Say ok","status":"draft","checkpoint":0,"verdicts":0}' WHERE id = $1`, params: [c] });
		expect(await act('bob', 'sys_message.executePlan', { conversation: c })).toMatchObject({ kind: 'refused', code: 'notFound' });
		await act('ann', 'sys_message.executePlan', { conversation: c });
		await bolt.settled();
		expect((await agent.conversation(c)).plan).toMatchObject({ status: 'verified' });
		expect(answers.at(-1)).toBe('verdict');
		await act('ann', 'sys_message.discardPlan', { conversation: c });
		expect((await agent.conversation(c)).plan).toBeNull();
	});

	it('an envoy conversation is read-only: no reply, stop or resume; seen by its DM sender, group participants, or anyone internal on a public envoy', async () => {
		const { t, call, act } = await setup();
		const say = async (channel: string, id: string, thread: string, handle: string, extra: { group?: true; invocation?: 'mention' } = {}) => {
			await t.engine.channels.receive({ kind: 'inbound', channel, message: { id, thread, sentAt: t.clock.now(), from: { handle, name: id }, text: 'hello?', attachments: [], ...extra } });
			await t.engine.envoys.settled();
		};
		const sees = async (as: string, c: string) => (await call(as, 'GET', `/__bolt/agent?conversation=${c}`))!.status;
		// an authenticated envoy's DM: its linked sender alone; not other staff, not an admin, not an external member
		await say('field', 'w1', '6590000001@s.whatsapp.net', '6590000001@s.whatsapp.net');
		const dm = conversationId('field', '6590000001@s.whatsapp.net');
		expect(await sees('kim', dm)).toBe(200);
		for (const who of ['ann', 'adm', 'cus', 'bob']) expect(await sees(who, dm)).toBe(404);
		// nobody speaks into it or drives its agent from the chat UI
		expect((await call('kim', 'POST', '/__bolt/act', { callable: 'channels.reply', input: { conversation: dm, text: 'x' }, issuedAt: t.clock.now() }))!.status).toBe(404);
		expect(await act('kim', 'sys_conversation.stop', { conversation: dm })).toMatchObject({ kind: 'refused', code: 'notFound' });
		expect(await act('kim', 'sys_conversation.resume', { conversation: dm })).toMatchObject({ kind: 'refused', code: 'notFound' });
		expect(await act('kim', 'sys_message.post', { conversation: dm, text: 'x' })).toMatchObject({ kind: 'refused', code: 'notFound' });
		// a group: whoever posted in it
		await say('field', 'g1', '1203@g.us', '6590000002@s.whatsapp.net', { group: true, invocation: 'mention' });
		const group = conversationId('field', '1203@g.us');
		expect(await sees('bob', group)).toBe(200);
		for (const who of ['kim', 'ann', 'adm', 'cus']) expect(await sees(who, group)).toBe(404);
		// a public envoy: any internal member, never an external one
		await say('desk', 'p1', '6599999999@s.whatsapp.net', '6599999999@s.whatsapp.net');
		const pub = conversationId('desk', '6599999999@s.whatsapp.net');
		for (const who of ['ann', 'adm', 'kim']) expect(await sees(who, pub)).toBe(200);
		expect(await sees('cus', pub)).toBe(404);
	});
});
