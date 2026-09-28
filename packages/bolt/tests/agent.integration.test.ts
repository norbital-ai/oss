// The agent engine on PGlite (§5.9, rules 57–63b) against provider cassettes and a local MCP server: turns over
// conversation rows, steers under their own senders, ambient history, delegation never wider, the policy-filtered
// catalogue, confirmation cards, receipts, compaction on reported usage, the 60 s wall's cut steps, plans and the
// verifier, budgets and fixed replies, envoy authority (P32), the static prompt and the `context` tool, turn takeover.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Json } from '../src/decl/values.ts';
import type { AiPort, AiRequest, AiResponse, Captured, EngineManifest } from '../src/engine/contracts.ts';
import { agents, FIXED, NUDGE, RECOVERY, type AgentConfig, type HostTool, type HostToolContext } from '../src/engine/agent/index.ts';
import { COMPACT_FORMAT, messages } from '../src/engine/agent/context.ts';
import { conversationId } from '../src/engine/channels/store.ts';
import { Authorities } from '../src/engine/identity/actor.ts';
import { testWorkspace, type TestWorkspace, respondSystem1 } from '../src/test/index.ts'; // hook:decisions

const manifest = {
	workspace: { tz: 'UTC', locale: 'en', agent: { triage: false } }, // hook:decisions — not a triage test (rule 60a opt-out)
	models: { quotes: { description: 'A quote', label: 'title', fields: { title: { kind: 'text' }, region: { kind: 'enum', values: ['north', 'south'], default: 'north' } } } },
	relationships: {},
	collections: { quotes: { read: { fields: 'all' }, create: { input: { columns: ['title', 'region'] } }, update: { input: { columns: ['title', 'region'] } }, delete: {},
		actions: { mark: { description: 'Mark a quote', input: { title: { kind: 'text' } }, output: { kind: 'text' }, agent: 'confirm' } } } },
	policies: {
		narrow: { description: 'Titles only', grants: { quotes: { read: { fields: ['title'] } } } },
		rep: { description: 'Rep', grants: { quotes: { read: true, create: true, update: true, actions: ['mark'] } }, capabilities: { mcp: ['hq'], skills: ['pricing'] } },
		reader: { description: 'Reads quotes', grants: { quotes: { read: true } } },
	},
	envoys: {
		sales_desk: { channel: 'desk', audience: 'public', policies: ['reader'], triage: false, groupMessages: 'disabled', delegation: 'enabled', task: 'Answer questions about quotes.' },
		field: { channel: 'field', audience: 'authenticated', policies: ['reader'], triage: false, groupMessages: 'mention_or_reply', delegation: 'disabled', task: 'Keep quotes up to date.' },
	},
	mcp: { hq: { description: 'HQ tools', url: 'HQ_URL', auth: { bearer: 'HQ_TOKEN' } }, down: { description: 'Gone', url: 'DOWN_URL' } },
	agent: { internal: 'Staff brief.', external: 'Customer brief.', skills: { pricing: '---\ndescription: How we price\n---\n## Discounts\nTen percent.\n## Rounding\nUp.' } },
	integrations: {}, pipelines: {}, teams: {}, automations: {}, channels: { field: { transport: 'whatsapp' } }, connections: {}, apps: {}, customFields: {},
} as unknown as EngineManifest;
const guest = { source: `export default { collection: { quotes: { bodies: { actions: {
	mark: async (input, ctx) => (await ctx.act('quotes.create', { title: input.title })).records[0].id,
} } } } };` };

// ── a provider cassette: each step answers one model request ──
type Step = (req: AiRequest, signal: AbortSignal, onDelta?: (t: string) => void, onProgress?: (reasoning?: string) => void) => AiResponse | Promise<AiResponse>;
const say = (text: string, input = 10): Step => () => ({ content: text, toolCalls: [], finish: 'stop', usage: { input, output: 5 } });
const use = (name: string, input: Json, id = `c${Math.random().toString(36).slice(2, 8)}`, used = 10): Step => () =>
	({ content: '', toolCalls: [{ id, name, input }], finish: 'tool', usage: { input: used, output: 5 } });
function cassette(steps: Step[]) {
	const requests: AiRequest[] = [];
	let i = 0;
	const port: AiPort = { sys_1: respondSystem1, sys_2: { models: ['default'], async infer(req, signal, onDelta, onProgress) {
		requests.push(req);
		const s = steps[i++];
		if (s === undefined) throw new Error('cassette exhausted');
		return s(req, signal, onDelta, onProgress);
	} } };
	return { port, requests };
}
const toolNames = (r: AiRequest | undefined) => (r?.tools ?? []).map((t) => t.name);
const toolResults = (r: AiRequest) => r.messages.filter((m) => m.role === 'tool').map((m) => (m.content as { result: Json }).result);

// ── a local MCP server: stateless streamable HTTP answering JSON ──
let hq: Server, hqUrl = '';
const hqCalls: Json[] = [];
beforeAll(async () => {
	hq = createServer(async (req, res) => {
		if (req.headers.authorization !== 'Bearer s3cret') { res.writeHead(401).end(); return; }
		if (req.method !== 'POST') { res.writeHead(405).end(); return; }
		let body = '';
		for await (const c of req) body += String(c);
		const msg = JSON.parse(body) as { id?: number; method: string; params: { protocolVersion?: string; name?: string; arguments?: { text?: string } } };
		if (msg.id === undefined) { res.writeHead(202).end(); return; }
		const result = msg.method === 'initialize' ? { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'hq', version: '1' } }
			: msg.method === 'tools/list' ? { tools: [{ name: 'echo', description: 'Echo text', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] }
			: msg.method === 'tools/call' ? (hqCalls.push(msg.params as Json), { content: [{ type: 'text', text: `echo: ${msg.params.arguments?.text}` }] })
			: undefined;
		res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result === undefined
			? { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'no such method' } } : { jsonrpc: '2.0', id: msg.id, result }));
	});
	await new Promise<void>((r) => hq.listen(0, '127.0.0.1', r));
	hqUrl = `http://127.0.0.1:${(hq.address() as AddressInfo).port}/mcp`;
});
afterAll(() => new Promise<void>((r) => hq.close(() => r())));

async function setup(steps: Step[], over: Partial<AgentConfig> = {}) {
	const t = await testWorkspace({ manifest, guest });
	const ai = cassette(steps);
	// every commit the agent publishes to the live lane (its messages and conversations, as the panel receives them)
	const published: Captured[] = [], publish = t.engine.live.publish;
	t.engine.live.publish = (c) => { published.push(...c); return publish(c); };
	const agent = agents({ engine: t.engine, ai: ai.port, bindings: () => ({ now: t.clock.now(), today: t.clock.now().slice(0, 10), tz: 'UTC', params: {} }),
		mcp: { env: (n) => ({ HQ_URL: hqUrl, HQ_TOKEN: 's3cret', DOWN_URL: 'http://127.0.0.1:1/mcp' } as { [k: string]: string })[n] },
		...over });
	const user = async (id: string, o: { admin?: boolean; policies?: string[]; external?: boolean } = {}) => {
		await t.db.write({ text: `INSERT INTO sys_user (id, email, name, admin, kind) VALUES ($1, $2, $3, $4, $5)`, params: [id, `${id}@x.test`, id, o.admin ?? false, o.external ? 'external' : 'staff'] });
		for (const p of o.policies ?? []) await t.db.write({ text: `INSERT INTO sys_assignment (id, principal_type, principal, policy) VALUES ($1, 'sys_user', $2, $3)`, params: [crypto.randomUUID(), id, p] });
		return id;
	};
	const authority = async (id: string) => (await new Authorities(manifest, 'test').member(t.db, id))!;
	return { t, ai, agent, user, published, authority };
}
const quotes = async (t: TestWorkspace) => (await t.db.read([{ text: 'SELECT title, created_by FROM quotes ORDER BY title', params: [] }]))[0]!.rows;

describe('in-app turns', () => {
	it('acts as the member, records tool rows, and ends on a reply carrying its receipts (rule 59)', async () => {
		const { t, ai, agent, user, published } = await setup([use('act', { callable: 'quotes.create', input: { title: 'Desk' } }), say('Created the Desk quote.')]);
		const ann = await user('ann', { policies: ['rep'] });
		const c = await agent.start({ owner: ann });
		await agent.post({ conversation: c, as: { member: ann }, text: 'Make a quote for a desk', author: 'Ann' });
		const { reply } = await agent.drain(c);
		expect(await quotes(t)).toEqual([{ title: 'Desk', created_by: ann }]);
		expect(reply?.text).toBe('Created the Desk quote.');
		expect(reply?.meta).toMatchObject({ tag: 'reply', receipts: [{ outcome: 'committed', callable: 'quotes.create' }] });
		expect(ai.requests[0]!.messages[0]).toEqual({ role: 'user', content: '[Ann] Make a quote for a desk' });
		expect(ai.requests[0]!.system).toContain('Staff brief.');
		expect(ai.requests[0]!.system).not.toContain('Customer brief.');
		expect(toolResults(ai.requests[1]!)[0]).toMatchObject({ kind: 'committed' });
		// the conversation's status reaches the live lane as the turn runs and settles
		expect(published.filter((x) => x.collection === 'sys_conversation').map((x) => x.new?.['status']).slice(-2)).toEqual(['running', 'idle']);
		// the tool call was a `running` row, then the same row finished (rule 65: each write published as written)
		const tool = published.filter((x) => x.collection === 'sys_message' && x.new?.['role'] === 'tool');
		expect(tool.map((x) => x.new?.['state'])).toEqual(['running', null]);
		expect(new Set(tool.map((x) => x.id)).size).toBe(1);
		expect(tool.at(-1)!.new?.['content']).toMatchObject({ name: 'act', args: expect.stringContaining('quotes.create'), ms: expect.any(Number) });
		expect((await agent.conversation(c)).status).toBe('idle');
	});

	it('lists only the skills and MCP servers the actor\'s capabilities name, and calls the MCP tool (rules 58, 63b)', async () => {
		const { ai, agent, user, authority } = await setup([use('mcp__hq__echo', { text: 'hi' }), use('skill', { name: 'pricing', section: 'Discounts' }), say('HQ said hi.'), say('Nothing to add.')]);
		const ann = await user('ann', { policies: ['rep'] });
		const bob = await user('bob', { policies: ['reader'] });
		const c = await agent.start({ owner: ann });
		await agent.post({ conversation: c, as: { member: ann }, text: 'ask hq' });
		await agent.drain(c);
		expect(toolNames(ai.requests[0])).toEqual(expect.arrayContaining(['read', 'act', 'skill', 'mcp__hq__echo', 'subagent']));
		expect(toolResults(ai.requests[1]!)[0]).toMatchObject({ content: [{ type: 'text', text: 'echo: hi' }] });
		expect(hqCalls).toContainEqual({ name: 'echo', arguments: { text: 'hi' } });
		expect(toolResults(ai.requests[2]!)[1]).toBe('## Discounts\nTen percent.\n');
		const d = await agent.start({ owner: bob });
		await agent.post({ conversation: d, as: { member: bob }, text: 'anything?' });
		await agent.drain(d);
		const names = toolNames(ai.requests[3]);
		expect(names).not.toContain('skill');
		expect(names.some((n) => n.startsWith('mcp__'))).toBe(false);
		expect(names).not.toContain('act');
		expect(agent.surface(await authority(ann))).toMatchObject({ mcp: [{ name: 'hq' }] });
	});

	it('an unreachable MCP server is unavailable, never a failed turn', async () => {
		const { ai, agent, user } = await setup([say('Fine.')]);
		const root = await user('root', { admin: true });
		const c = await agent.start({ owner: root });
		await agent.post({ conversation: c, as: { member: root }, text: 'hello' });
		expect((await agent.drain(c)).reply?.text).toBe('Fine.');
		expect(toolNames(ai.requests[0])).toContain('mcp__hq__echo');
		expect(toolNames(ai.requests[0]).some((n) => n.startsWith('mcp__down__'))).toBe(false);
	});

	it('holds a confirm action on a card until the member confirms; it then executes and the turn goes on', async () => {
		const { t, ai, agent, user, authority } = await setup([use('act', { callable: 'quotes.mark', input: { title: 'Chair' } }, 'k1'), say('Marked.')]);
		const ann = await user('ann', { policies: ['rep'] });
		const c = await agent.start({ owner: ann });
		await agent.post({ conversation: c, as: { member: ann }, text: 'mark a chair' });
		await agent.drain(c);
		expect(await quotes(t)).toEqual([]);
		const held = (await agent.transcript(c)).find((r) => r.state === 'confirm')!;
		expect(held.meta).toMatchObject({ tag: 'confirm', call: { id: 'k1', name: 'act' } });
		const bob = await user('bob', { policies: ['rep'] });
		await expect(agent.confirm(held.id, true, await authority(bob))).rejects.toThrow(/only the person/);
		const { reply } = await agent.confirm(held.id, true, await authority(ann));
		expect(await quotes(t)).toEqual([{ title: 'Chair', created_by: ann }]);
		expect(reply).toMatchObject({ text: 'Marked.', meta: { receipts: [{ outcome: 'committed', callable: 'quotes.mark' }] } });
		expect(toolResults(ai.requests[1]!)[0]).toMatchObject({ kind: 'committed' });
	});

	it('compacts when the reported input passes 90% of the window, and the next call starts from the checkpoint (rule 62)', async () => {
		const { ai, agent, user } = await setup([use('history', { query: 'x' }, 'd1', 95), say('| Section | Summary |\n|---|---|\n| Goal | g |'), say('Done.')], { windows: { default: 100 } });
		const root = await user('root', { admin: true });
		const c = await agent.start({ owner: root });
		await agent.post({ conversation: c, as: { member: root }, text: 'go' });
		await agent.drain(c);
		expect(ai.requests[1]!.system).toBe(COMPACT_FORMAT);
		const after = ai.requests[2]!.messages.map((x) => JSON.stringify(x.content));
		expect(after.some((x) => x.includes('context checkpoint'))).toBe(true);
		expect(after.some((x) => x.includes('d1'))).toBe(false);
		expect(after.some((x) => x.includes('go'))).toBe(true);
	});

	it('a stream still open at the wall is cut and continued as a new step: two calls, one reply (rule 63)', async () => {
		const stalls: Step = (_req, signal, onDelta) => new Promise((_, reject) => { onDelta?.('The answer '); signal.addEventListener('abort', () => reject(new Error('aborted'))); });
		const { ai, agent, user } = await setup([stalls, say('is 42.')], { wallMs: 30 });
		const root = await user('root', { admin: true });
		const c = await agent.start({ owner: root });
		await agent.post({ conversation: c, as: { member: root }, text: 'question' });
		const { reply } = await agent.drain(c);
		expect(ai.requests).toHaveLength(2);
		expect(reply?.text).toBe('The answer is 42.');
		expect((await agent.transcript(c)).filter((r) => r.role === 'assistant')).toHaveLength(1);
		expect(ai.requests[1]!.messages.at(-1)).toMatchObject({ role: 'assistant' });
	});

	it('stops at the step budget with a fixed reply', async () => {
		const { agent, user } = await setup([use('history', { query: 'x' }), use('history', { query: 'x' }), use('history', { query: 'x' })], { steps: 2 });
		const root = await user('root', { admin: true });
		const c = await agent.start({ owner: root });
		await agent.post({ conversation: c, as: { member: root }, text: 'loop' });
		expect((await agent.drain(c)).reply).toMatchObject({ text: FIXED.budget, meta: { tag: 'failed', code: 'stepBudget' } });
	});

	it('an external member without an external brief has no agent; a staff brief never reaches them', async () => {
		const { ai, agent, user } = await setup([say('hi')]);
		const cus = await user('cus', { external: true, policies: ['reader'] });
		const c = await agent.start({ owner: cus });
		await agent.post({ conversation: c, as: { member: cus }, text: 'hello' });
		await agent.drain(c);
		expect(ai.requests[0]!.system).toContain('Customer brief.');
		expect(ai.requests[0]!.system).not.toContain('Staff brief.');
		expect(toolNames(ai.requests[0])).not.toContain('subagent');
	});
});

describe('plans and the verifier (rule 63a)', () => {
	it('plan mode drafts; execution is verified by an independent sub-run, again after every miss, with no stall (today\'s behaviour)', async () => {
		const miss = say(JSON.stringify({ complete: false, gaps: ['no evidence'], summary: 'not yet' }));
		const { ai, agent, user } = await setup([
			use('update_plan', { body: '1. Read quotes\nCheck: a count is reported' }), say('Plan drafted.'),
			say('Done.'), miss, say('Still done.'), miss, say('Really done.'), miss, say('Truly done.'), miss,
			say('Counted 0 quotes.'), say(JSON.stringify({ complete: true, gaps: [], summary: 'ok' })),
		]);
		const root = await user('root', { admin: true });
		const c = await agent.start({ owner: root });
		await agent.post({ conversation: c, as: { member: root }, text: 'plan it', mode: 'plan' });
		await agent.drain(c);
		expect(toolNames(ai.requests[0])).not.toContain('act');
		expect((await agent.conversation(c)).plan).toMatchObject({ status: 'draft', body: expect.stringContaining('Read quotes') });
		await agent.executePlan(c, { member: root });
		expect(ai.requests[3]!.system).toContain('independent verification agent');
		expect(ai.requests[3]!.tools).toBeUndefined();
		expect(JSON.stringify(ai.requests[4]!.messages)).not.toContain('plan it');
		expect((await agent.conversation(c)).plan).toMatchObject({ status: 'verified', verdicts: 4 });
		expect(ai.requests).toHaveLength(12);
	});
});

/** A channel sender's `as` (P32): the envoy, the linked member if any, and whether it is a DM. */
const envoyAs = (name: string, sender: string, member: string | null, dm: boolean) => ({ envoy: { name, channel: name === 'field' ? 'field' : 'desk', sender, member, dm } });

describe('envoy conversations', () => {
	it('an ambient message starts nothing and is readable by read_messages; each addressed steer carries its sender header, and every group turn holds the envoy\'s policies alone (rule 60, P32)', async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => { release = r; });
		const { ai, agent, user } = await setup([
			async (req) => { await gate; return use('read_messages', {})(req, AbortSignal.timeout(1)); },
			use('read', { collection: 'quotes' }), say('Both seen.'),
		]);
		const ann = await user('ann', { admin: true });
		const ben = await user('ben', { policies: ['rep'] });
		const c = await agent.start({ envoy: 'field', channel: 'field' });
		await agent.ambient({ conversation: c, text: 'site 14 photo', author: 'Cara' });
		expect((await agent.drain(c)).reply).toBeNull();
		expect(ai.requests).toHaveLength(0);
		await agent.post({ conversation: c, as: envoyAs('field', '+1', ann, false), text: '@bot add A1', author: 'Ann' });
		const turn = agent.drain(c);
		await new Promise((r) => setTimeout(r, 50));
		await agent.post({ conversation: c, as: envoyAs('field', '+2', ben, false), text: '@bot and B1', author: 'Ben' });
		expect((await agent.drain(c)).ran).toBe(false);
		release();
		const { reply } = await turn;
		expect(toolNames(ai.requests[0])).not.toContain('act'); // an administrator in a group holds the envoy's `reader` only
		expect(toolNames(ai.requests[1])).not.toContain('act');
		const second = JSON.stringify(ai.requests[1]!.messages);
		expect(second).toContain('[Ann · linked member ann] @bot add A1');
		expect(second).toContain('[Ben · linked member ben] @bot and B1');
		expect(JSON.stringify(toolResults(ai.requests[1]!).at(-1))).toContain('site 14 photo');
		expect(JSON.stringify(ai.requests[0]!.messages.at(-1))).toContain('1 unread chat message');
		expect(reply?.text).toBe('Both seen.');
	});

	it('a DM holds the envoy\'s policies joined by the linked member\'s own authority; the same administrator in a group is refused (rule 57, P32)', async () => {
		const { t, ai, agent, user } = await setup([use('act', { callable: 'quotes.create', input: { title: 'Boss' } }), say('ok'), say('no')]);
		const root = await user('root', { admin: true });
		const dm = await agent.start({ envoy: 'field', channel: 'field' });
		await agent.post({ conversation: dm, as: envoyAs('field', '+9', root, true), text: 'add Boss', author: 'Root' });
		await agent.drain(dm);
		expect(await quotes(t)).toEqual([{ title: 'Boss', created_by: root }]);
		const group = await agent.start({ envoy: 'field', channel: 'field' });
		await agent.post({ conversation: group, as: envoyAs('field', '+9', root, false), text: '@bot add Boss', author: 'Root' });
		await agent.drain(group);
		expect(toolNames(ai.requests[2])).not.toContain('act');
	});

	it('a public envoy delegates in the background; its sub-agent cannot write outside the envoy\'s policies, reports back and its usage rolls into the parent (rules 63a, parity 1.14)', async () => {
		const parent = [use('subagent', { action: 'spawn', task: 'Create a quote called Sneaky' }), say('Working on it.'), say('Sorry, I cannot create that quote.')];
		const child = [use('act', { callable: 'quotes.create', input: { title: 'Sneaky' } }), say('I may not create quotes.')];
		let p = 0, k = 0;
		const route: Step = (req, signal, d) => JSON.stringify(req.messages[0]).includes('Sneaky') ? child[k++]!(req, signal, d) : parent[p++]!(req, signal, d);
		const { t, ai, agent } = await setup(Array(5).fill(route));
		const c = await agent.start({ envoy: 'sales_desk', channel: 'desk' });
		const as = envoyAs('sales_desk', '+6590000000', null, true);
		await agent.post({ conversation: c, as, text: 'make me a quote', author: '+6590000000' });
		const { reply } = await agent.drain(c);
		expect(await quotes(t)).toEqual([]);
		expect(toolNames(ai.requests[0])).toContain('subagent');
		const kid = ai.requests.filter((r) => JSON.stringify(r.messages[0]).includes('Sneaky'));
		expect(kid).toHaveLength(2);
		expect(toolNames(kid[0])).not.toContain('act');
		expect(toolNames(kid[0])).not.toContain('subagent');
		expect(toolResults(kid[1]!)[0]).toEqual({ error: "No tool 'act'." });
		expect(kid[0]!.system).toContain('Customer brief.');
		expect(JSON.stringify(kid[0]!.messages[0])).toContain('not linked');
		expect(JSON.stringify(ai.requests.at(-1)!.messages)).toContain('I may not create quotes.');
		expect(reply?.text).toBe('Sorry, I cannot create that quote.');
		expect(reply?.meta).toMatchObject({ usage: { calls: 5 } }); // three of its own, two of the sub-agent's
	});

	it('a failed turn sends a public sender the fixed reply, never the internal error, and writes an error event (§5.12)', async () => {
		const { t, agent } = await setup([() => { throw Object.assign(new Error('provider key sk-123 rejected'), { status: 401 }); }]);
		const c = await agent.start({ envoy: 'sales_desk', channel: 'desk' });
		await agent.post({ conversation: c, as: envoyAs('sales_desk', 'x', null, true), text: 'hi' });
		const { reply } = await agent.drain(c);
		expect(reply?.text).toBe(FIXED.failed);
		expect(JSON.stringify(reply)).not.toContain('sk-123');
		expect((await t.db.read([{ text: `SELECT severity FROM sys_event WHERE conversation = $1`, params: [c] }]))[0]!.rows).toEqual([{ severity: 'error' }]);
	});

	it('stop cancels queued input and ends the turn; resume runs again', async () => {
		const { agent, user, ai } = await setup([say('late')]);
		const root = await user('root', { admin: true });
		const c = await agent.start({ owner: root });
		await agent.post({ conversation: c, as: { member: root }, text: 'one' });
		await agent.stop(c);
		expect((await agent.drain(c)).ran).toBe(false);
		expect((await agent.transcript(c))[0]!.state).toBe('cancelled');
		await agent.post({ conversation: c, as: { member: root }, text: 'two' });
		expect((await agent.resume(c)).reply?.text).toBe('late');
		expect(ai.requests).toHaveLength(1);
	});
});


describe('toolset parity with today (agent-tools-parity.md)', () => {
	const post = async (agent: Awaited<ReturnType<typeof setup>>['agent'], c: string, member: string, text: string, o: { mode?: 'agent' | 'plan' | 'compact'; tz?: string } = {}) =>
		agent.post({ conversation: c, as: { member }, text, author: member, ...o });

	it('steers from two senders are never collated: each step runs under one sender (rule 60, parity 2.7)', async () => {
		const { ai, agent, user } = await setup([say('ok bob'), say('ok root')]);
		const bob = await user('bob', { policies: ['reader'] });
		const root = await user('root', { admin: true });
		const c = await agent.start({ envoy: 'field', channel: 'field' });
		await post(agent, c, bob, 'read please');
		await post(agent, c, root, 'delete everything');
		await agent.drain(c);
		expect(toolNames(ai.requests[0])).not.toContain('act');
		expect(JSON.stringify(ai.requests[0]!.messages)).not.toContain('delete everything');
		expect(toolNames(ai.requests[1])).toContain('act');
	});

	it('a write answers the stored row; the reply carries summed usage (parity 1.2, 3.14)', async () => {
		const { ai, agent, user } = await setup([use('act', { callable: 'quotes.create', input: { title: 'Desk' } }), say('Done.')]);
		const ann = await user('ann', { policies: ['rep'] });
		const c = await agent.start({ owner: ann });
		await post(agent, c, ann, 'desk');
		const { reply } = await agent.drain(c);
		expect(toolResults(ai.requests[1]!)[0]).toMatchObject({ kind: 'committed', stored: [{ title: 'Desk', region: 'north' }] });
		expect(reply?.meta).toMatchObject({ usage: { input: 20, output: 10, calls: 2 } });
	});

	it('the system prompt is byte-identical across actors and days and carries the outline; each step closes with the clock and the actor (rule 62, P32)', async () => {
		const { t, ai, agent, user } = await setup([say('a'), say('b')]);
		const ann = await user('ann', { policies: ['rep'] });
		const root = await user('root', { admin: true });
		const c = await agent.start({ owner: ann });
		await post(agent, c, ann, 'when', { tz: 'Asia/Singapore' });
		await agent.drain(c);
		t.clock.advance('1d');
		const d = await agent.start({ owner: root });
		await post(agent, d, root, 'hi');
		await agent.drain(d);
		expect(ai.requests[1]!.system).toBe(ai.requests[0]!.system);
		expect(ai.requests[0]!.system).toContain('# Workspace outline');
		expect(ai.requests[0]!.system).toMatch(/^- quotes: .*\| title, region/m);
		const note = (n: number) => JSON.stringify(ai.requests[n]!.messages.at(-1)!.content);
		expect(note(0)).toMatch(/Now: .*\(UTC, .*theirs .*\(Asia\/Singapore\).*You act for ann@x.test; policies rep/);
		expect(note(1)).toContain('You act for root@x.test, an administrator');
	});

	it('read keeps named fields whole and pages on from the last row it shows, and honours field masks (parity 1.1, 1.3)', async () => {
		const long = (i: number) => `${String(i).padStart(2, '0')} ${'x'.repeat(2_000)}`;
		const q = { collection: 'quotes', select: { title: true }, orderBy: { title: 'asc' } };
		const onward: Step = (req, s, d) => use('read', { ...q, limit: 1, after: (toolResults(req)[0] as { next: string }).next })(req, s, d);
		const { t, ai, agent, user } = await setup([use('read', { ...q, limit: 30 }), onward, say('a'), use('read', { collection: 'quotes', limit: 1 }), say('b')]);
		const root = await user('root', { admin: true });
		for (let i = 0; i < 30; i++) await t.db.write({ text: `INSERT INTO quotes (id, title, region) VALUES (gen_random_uuid(), $1, 'north')`, params: [long(i)] });
		const c = await agent.start({ owner: root });
		await post(agent, c, root, 'list');
		await agent.drain(c);
		const page = toolResults(ai.requests[1]!)[0] as { rows: { title: string }[]; next: string | null; clipped: string };
		expect(page.rows.length).toBeGreaterThan(0);
		expect(page.rows.length).toBeLessThan(30);
		expect(page.rows[0]!.title).toBe(long(0));
		expect((toolResults(ai.requests[2]!)[1] as { rows: { title: string }[] }).rows[0]!.title).toBe(long(page.rows.length));
		const nora = await user('nora', { policies: ['narrow'] });
		const d = await agent.start({ owner: nora });
		await post(agent, d, nora, 'what is a quote');
		await agent.drain(d);
		expect((toolResults(ai.requests[4]!)[0] as { rows: { region: unknown }[] }).rows[0]!.region).toEqual({ $masked: true });
	});

	it('stop then a follow-up runs; resume after a stop recalls the stopped request (parity 3.4, 2.20)', async () => {
		const { ai, agent, user } = await setup([say('two done'), say('resumed')]);
		const root = await user('root', { admin: true });
		const c = await agent.start({ owner: root });
		await post(agent, c, root, 'one');
		await agent.stop(c);
		await post(agent, c, root, 'two');
		expect((await agent.drain(c)).reply?.text).toBe('two done');
		await post(agent, c, root, 'three');
		await agent.stop(c);
		expect((await agent.resume(c)).reply?.text).toBe('resumed');
		expect(JSON.stringify(ai.requests[1]!.messages)).toContain('Not yet handled: three');
	});

	it('goals are a validated checklist; update_plan patches against its revision; a draft plan locks execution (parity 1.10, 1.11, 3.6)', async () => {
		const { ai, agent, user } = await setup([
			use('goals', { items: [{ id: 'a', text: 'Find', status: 'done' }, { id: 'b', text: 'Fix', status: 'doing' }] }),
			use('goals', { items: [{ id: 'a', text: 'Find', status: 'pending' }] }), say('ok'),
			use('update_plan', { body: '1. Read\n2. Write' }), use('update_plan', { patch: { old: '2. Write', new: '2. Report' }, expectedRevision: 1 }),
			use('update_plan', { body: 'stale', expectedRevision: 1 }), say('drafted'), say('still planning'),
		]);
		const root = await user('root', { admin: true });
		const c = await agent.start({ owner: root });
		await post(agent, c, root, 'track it');
		await agent.drain(c);
		expect(toolResults(ai.requests[2]!)[1]).toEqual({ error: "Goal 'a' is done; it stays done with its text." });
		expect((await agent.conversation(c)).goals).toEqual([{ id: 'a', text: 'Find', status: 'done' }, { id: 'b', text: 'Fix', status: 'doing' }]);
		await post(agent, c, root, 'plan', { mode: 'plan' });
		await agent.drain(c);
		expect((await agent.conversation(c)).plan).toMatchObject({ revision: 2, body: '1. Read\n2. Report', status: 'draft' });
		expect(toolResults(ai.requests[6]!).at(-1)).toEqual({ error: 'The plan is at revision 2; read it again before editing.' });
		await post(agent, c, root, 'just do it');
		await agent.drain(c);
		expect(toolNames(ai.requests[7])).toContain('update_plan');
		expect(toolNames(ai.requests[7])).not.toContain('act');
	});

	it('the compact tool and /compact checkpoint; an empty summary is asked for once more (parity 1.12, 3.9, 3.22)', async () => {
		const { ai, agent, user } = await setup([use('compact', { reason: 'long' }), say(''), say('| Goal | g |'), say('after'), say('| Goal | again |')]);
		const root = await user('root', { admin: true });
		const c = await agent.start({ owner: root });
		await post(agent, c, root, 'go');
		expect((await agent.drain(c)).reply?.text).toBe('after');
		expect(ai.requests[1]!.system).toBe(COMPACT_FORMAT);
		expect(ai.requests[2]!.system).toBe(COMPACT_FORMAT);
		expect(JSON.stringify(ai.requests[3]!.messages)).toContain('context checkpoint');
		await post(agent, c, root, '/compact', { mode: 'compact' });
		await agent.drain(c);
		expect(ai.requests).toHaveLength(5);
		expect((await agent.transcript(c)).filter((r) => r.meta?.tag === 'compact')).toHaveLength(2);
		expect(await agent.exportTranscript(c)).toMatch(/Model calls: 4\. Tool calls: compact 1\.[\s\S]*## Checkpoint[\s\S]*### Assistant\n\nafter/);
	});

	it('history searches this conversation or all of the person\'s; a clipped result is readable with read_output; repeated failures get guidance (parity 1.7, 1.19, 3.11)', async () => {
		const big = { rows: undefined, blob: 'y'.repeat(40_000) };
		const bigTool: HostTool = { name: 'big', description: 'Big', input: { type: 'object' }, call: async () => big as unknown as Json };
		const bad = use('read', { collection: 'nope' });
		const { ai, agent, user } = await setup([say('first'), use('history', { query: 'PURPLE', scope: 'mine' }), use('big', {}, 'b1'), use('read_output', { call: 'b1', offset: 100 }),
			bad, bad, bad, say('done')], { hostTools: [bigTool] });
		const root = await user('root', { admin: true });
		const c1 = await agent.start({ owner: root });
		await post(agent, c1, root, 'the PURPLE door');
		await agent.drain(c1);
		const c2 = await agent.start({ owner: root });
		await post(agent, c2, root, 'where was that door?');
		await agent.drain(c2);
		expect(toolResults(ai.requests[2]!)[0]).toMatchObject({ hits: [{ conversation: c1, text: 'the PURPLE door' }] });
		expect(JSON.stringify(toolResults(ai.requests[3]!)[1])).toContain('clipped, 40002 bytes');
		expect(toolResults(ai.requests[3]!)[1]).toMatchObject({ readOutput: "clipped: read_output { call: 'b1' } reads the whole result" });
		expect(toolResults(ai.requests[4]!)[2]).toMatchObject({ offset: 100, total: JSON.stringify(big).length, next: 13_100, parts: expect.arrayContaining(['y'.repeat(1000)]) });
		expect(toolResults(ai.requests[7]!).at(-1)).toMatchObject({ guidance: RECOVERY });
		expect(toolResults(ai.requests[6]!).at(-1)).not.toHaveProperty('guidance');
	});

	it('a clipped file is read on with read_output: by the call its clip note names, or the latest with no call; escaped code stays within the bound (rule 62)', async () => {
		// a Svelte page: quotes, tabs and newlines grow when the result is encoded again
		const page = Array.from({ length: 900 }, (_, n) => `\t<td class="c" data-k="${n}">{row["f${n}"]}</td>`).join('\n');
		const read: HostTool = { name: 'draft_read', description: 'Read', input: { type: 'object' }, readOnly: true, call: async () => ({ files: { 'src/app/crm/+desk.page.svelte': page } }) };
		const { ai, agent, user } = await setup([use('draft_read', {}, 'r1'), use('read_output', { call: 'r1' }), use('read_output', { offset: 5_000 }), use('read_output', { call: 'guess' }), say('done')],
			{ hostTools: [read] });
		const root = await user('root', { admin: true });
		const c = await agent.start({ owner: root });
		await post(agent, c, root, 'read the desk');
		await agent.drain(c);
		const whole = JSON.stringify({ files: { 'src/app/crm/+desk.page.svelte': page } });
		expect(toolResults(ai.requests[1]!)[0]).toMatchObject({ readOutput: "clipped: read_output { call: 'r1' } reads the whole result" });
		type Out = { offset: number; total: number; parts: string[]; next?: number };
		const byId = toolResults(ai.requests[2]!)[1] as unknown as Out;
		expect(byId).toMatchObject({ offset: 0, total: whole.length });
		expect(byId.parts.join('')).toBe(whole.slice(0, byId.next));
		expect(byId.parts.every((p) => !p.includes('[clipped'))).toBe(true);
		expect(new TextEncoder().encode(JSON.stringify(byId)).length).toBeLessThanOrEqual(16 * 1024);
		const latest = toolResults(ai.requests[3]!)[2] as unknown as Out;
		expect(latest.parts.join('')).toBe(whole.slice(5_000, latest.next ?? whole.length));
		expect(toolResults(ai.requests[4]!)[3]).toMatchObject({ error: expect.stringContaining('omit call') });
	});

	it('host tools learn the person and conversation, readOnly ones serve plan mode, a slow one becomes a job collected with wait; host skills merge (parity 1.13, 1.17, 1.6)', async () => {
		const seen: HostToolContext[] = [];
		let finish!: (v: Json) => void;
		const tools: HostTool[] = [
			{ name: 'studio_read', description: 'Read the draft', input: { type: 'object' }, readOnly: true, call: async (_i, ctx) => { seen.push(ctx); return 'draft'; } },
			{ name: 'studio_validate', description: 'Validate', input: { type: 'object' }, call: () => new Promise<Json>((r) => { finish = r; }) },
		];
		const { ai, agent, user } = await setup([use('studio_read', {}), say('planned'), use('studio_validate', {}), async (req) => { finish({ valid: true }); return use('wait', { seconds: 5 })(req, AbortSignal.timeout(1)); }, say('valid'),
			use('skill', { name: 'authoring', section: 'Rules' }), say('read')],
			{ hostTools: async () => tools, hostInlineMs: 20, skills: async () => ({ authoring: '---\ndescription: Author a workspace\n---\n## Rules\nOne file per collection.' }) });
		const root = await user('root', { admin: true });
		const c = await agent.start({ owner: root });
		await post(agent, c, root, 'plan', { mode: 'plan' });
		await agent.drain(c);
		expect(toolNames(ai.requests[0])).toContain('studio_read');
		expect(toolNames(ai.requests[0])).not.toContain('studio_validate');
		expect(seen[0]).toMatchObject({ actor: { kind: 'member', id: root }, conversation: c });
		await agent.discardPlan(c);
		await post(agent, c, root, 'validate');
		await agent.drain(c);
		expect(toolResults(ai.requests[3]!).at(-1)).toMatchObject({ job: expect.any(String) });
		expect(toolResults(ai.requests[4]!).at(-1)).toMatchObject({ settled: { label: 'studio_validate', result: { valid: true } } });
		await post(agent, c, root, 'how do I author?');
		await agent.drain(c);
		expect(toolResults(ai.requests[6]!).at(-1)).toBe('## Rules\nOne file per collection.');
		const bob = await user('bob', { policies: ['reader'] });
		const d = await agent.start({ owner: bob });
		await post(agent, d, bob, 'hi');
		await agent.drain(d).catch(() => undefined);
		expect(toolNames(ai.requests[7])).not.toContain('studio_read');
	});

	it('geocode is offered when the host binds a geocoder (parity 1.5)', async () => {
		const { ai, agent, user } = await setup([use('geocode', { query: '1 Main St' }), say('ok')], {
			geocoder: { search: async () => [{ point: { lat: 1.3, lng: 103.8 }, label: 'Main', address: '1 Main St' }], reverse: async () => null } });
		const root = await user('root', { admin: true });
		const c = await agent.start({ owner: root });
		await post(agent, c, root, 'where');
		await agent.drain(c);
		expect(toolResults(ai.requests[1]!)[0]).toEqual([{ label: 'Main', address: '1 Main St', location: { lat: 1.3, lng: 103.8 } }]);
	});

	it('in-app attachments are listed as file references and read with read_attachment; images beyond the budget drop the oldest (parity 1.9, 2.10)', async () => {
		let seq = 0;
		const nine: Step = () => ({ content: '', toolCalls: Array.from({ length: 9 }, (_, i) => ({ id: `r${i}`, name: 'read_attachment', input: { seq, file: i, as: 'image' } })), finish: 'tool', usage: { input: 1, output: 1 } });
		const { ai, agent, user } = await setup([nine, say('seen')], { attachments: { read: async () => ({ mime: 'image/png', bytes: new Uint8Array(4) }) } });
		const root = await user('root', { admin: true });
		const c = await agent.start({ owner: root });
		const files = Array.from({ length: 9 }, (_, i) => ({ id: `f${i}`, name: `p${i}.png`, mime: 'image/png' }));
		seq = (await agent.post({ conversation: c, as: { member: root }, text: 'look', files })).seq;
		await agent.drain(c);
		expect(JSON.stringify(ai.requests[0]!.messages)).toContain('file reference {\\"id\\":\\"f0\\",\\"name\\":\\"p0.png\\",\\"mime\\":\\"image/png\\"}');
		expect(ai.requests[1]!.files).toHaveLength(8);
		expect(toolResults(ai.requests[1]!).at(-1)).toMatchObject({ dropped: expect.stringContaining('1 older') });
	});

	it('read_attachment sends a PDF to the next model step as a document', async () => {
		let seq = 0;
		const { ai, agent, user } = await setup([
			() => ({ content: '', toolCalls: [{ id: 'pdf', name: 'read_attachment', input: { seq, as: 'document' } }], finish: 'tool', usage: { input: 1, output: 1 } }),
			say('seen')
		], { attachments: { read: async () => ({ mime: 'application/pdf', bytes: new Uint8Array([37, 80, 68, 70]) }) } });
		const root = await user('root', { admin: true });
		const c = await agent.start({ owner: root });
		seq = (await agent.post({ conversation: c, as: { member: root }, text: 'inspect the report',
			files: [{ id: 'f1', name: 'report.pdf', mime: 'application/pdf' }] })).seq;
		await agent.drain(c);
		expect(ai.requests[1]!.files).toMatchObject([{ mime: 'application/pdf' }]);
		expect(toolResults(ai.requests[1]!)[0]).toMatchObject({ attached: 'the file is attached to your next step' });
	});

	it('channel rows carry their envelope; read_messages reads unread ambient rows once, oldest first, without revoked ones; revokes and edits converge without rewriting an admitted row (parity 2.9, 1.8, 2.19)', async () => {
		const { t, ai, agent, user } = await setup([use('read_messages', {}, 'r1'), use('read_messages', {}, 'r2'), say('ok')]);
		const ann = await user('ann', { policies: ['rep'] });
		const group = '1203@g.us', wire = (id: string, text: string, o: { [k: string]: Json } = {}) => t.engine.channels.receive({ kind: 'inbound', channel: 'field',
			message: { id, thread: group, group: true, sentAt: t.clock.now(), from: { handle: `${id}@s.whatsapp.net`, name: `Sender ${id}` }, text, attachments: [], ...o } });
		await wire('A', 'site 14 photo');
		await wire('B', 'wrong message');
		await wire('C', 'crane is late');
		await t.engine.channels.receive({ kind: 'inbound', channel: 'field', message: { id: 'B', deleted: true } }); // a bare revoke: the id alone
		const c = conversationId('field', group);
		await agent.post({ conversation: c, as: { member: ann }, text: '@bot anything new?', author: 'Ann' });
		await agent.drain(c);
		expect(JSON.stringify(ai.requests[0]!.messages.at(-1))).toContain('2 unread chat messages');
		const first = toolResults(ai.requests[1]!)[0] as { messages: { text: string; sender: string; message: string }[] };
		expect(first.messages.map((m) => m.text)).toEqual(['site 14 photo', 'crane is late']);
		expect(first.messages[0]).toMatchObject({ sender: 'A@s.whatsapp.net', message: 'A' });
		expect(toolResults(ai.requests[2]!)[1]).toMatchObject({ messages: [] });
		// an admitted row is the transcript: an edit or a revoke never rewrites it; an unadmitted one converges
		await t.db.write({ text: `UPDATE sys_message SET role = 'user', state = 'consumed', content = jsonb_build_object('text', text) WHERE provider_id = 'A'`, params: [] });
		await wire('A', 'edited', { version: new Date(Date.parse(t.clock.now()) + 1000).toISOString() });
		await wire('C', 'crane is on time', { version: new Date(Date.parse(t.clock.now()) + 1000).toISOString() });
		await t.engine.channels.receive({ kind: 'inbound', channel: 'field', message: { id: 'A', deleted: true } });
		await t.engine.channels.receive({ kind: 'inbound', channel: 'field', message: { id: 'Z', deleted: true } });
		await wire('Z', 'revoked before it arrived');
		const rows = (await t.db.read([{ text: `SELECT provider_id, text, deleted_at IS NOT NULL AS deleted FROM sys_message WHERE channel = 'field' ORDER BY provider_id`, params: [] }]))[0]!.rows;
		expect(rows).toEqual([{ provider_id: 'A', text: 'site 14 photo', deleted: true }, { provider_id: 'B', text: '', deleted: true },
			{ provider_id: 'C', text: 'crane is on time', deleted: false }, { provider_id: 'Z', text: '', deleted: true }]);
		const envelope = messages([(await agent.transcript(c)).find((r) => r.provider_id === 'A')!])[0]!.content as string;
		expect(envelope).toMatch(/^\[.*Sender A · ambient · chat .* · message A · sender A@s\.whatsapp\.net\]\nsite 14 photo$/);
	});
});

describe('durable turns (rule 48)', () => {
	it('a turn whose process died is taken over by its agent.turn run once the lease lapses, and never runs twice at once', async () => {
		const ai = cassette([say('recovered')]);
		const t = await testWorkspace({ manifest, guest, ai: ai.port, now: new Date().toISOString() /* the lease is the database's clock */ });
		await t.db.write({ text: `INSERT INTO sys_user (id, email, name, admin) VALUES ('root', 'root@x.test', 'Root', true)`, params: [] });
		const agent = t.engine.agents, c = await agent.start({ owner: 'root' });
		await agent.post({ conversation: c, as: { member: 'root' }, text: 'hi' });
		// another process claimed the turn (its lease and its takeover run) and died before its first step
		await t.db.write({ text: `WITH c AS (UPDATE sys_conversation SET status = 'running', lease_until = now() + interval '1 minute' WHERE id = $1 RETURNING id)
			INSERT INTO sys_run (id, automation, input, due_at, cause, depth) VALUES (gen_random_uuid()::text, 'agent.turn', jsonb_build_object('conversation', $1::text), $2::timestamptz + interval '1 minute', 'schedule', 0)`,
		params: [c, t.clock.now()] });
		expect((await agent.drain(c)).ran).toBe(false);
		t.clock.advance('2min');
		await t.runDue(); // the lease is still live: the run looks again later, and nothing ran
		expect(ai.requests).toHaveLength(0);
		await t.db.write({ text: `UPDATE sys_conversation SET lease_until = now() - interval '1 second' WHERE id = $1`, params: [c] });
		t.clock.advance('2min');
		await t.runDue();
		expect(ai.requests).toHaveLength(1);
		expect((await agent.transcript(c)).at(-1)).toMatchObject({ role: 'assistant', text: 'recovered' });
		expect((await t.db.read([{ text: `SELECT count(*)::int AS n FROM sys_run WHERE automation = 'agent.turn' AND state = 'queued'`, params: [] }]))[0]!.rows[0]).toEqual({ n: 0 });
	});
});

describe('counting is one aggregate read (hr: "why did turnover spike in March 2026" took 24 reads)', () => {
	it('the read tool offers aggregate with count and by (time buckets named), and a grouped aggregate needs no limit from the model', async () => {
		const { t, ai, agent, user } = await setup([use('read', { collection: 'quotes', aggregate: { count: true, by: 'region' } }), say('Two north, one south.')]);
		const root = await user('root', { admin: true });
		await t.as(t.admin).act('quotes.create', [{ title: 'a', region: 'north' }, { title: 'b', region: 'north' }, { title: 'c', region: 'south' }]);
		const c = await agent.start({ owner: root });
		await agent.post({ conversation: c, as: { member: root }, text: 'How many quotes per region?' });
		await agent.drain(c);
		const read = ai.requests[0]!.tools!.find((x) => x.name === 'read')!;
		expect(read.description).toContain('aggregate');
		expect(read.description).toContain('by: { month:');
		expect((read.input as { properties: { aggregate: { properties: object } } }).properties.aggregate.properties).toMatchObject({ count: {}, by: {} });
		expect(ai.requests[0]!.system).toContain('one aggregate read');
		const answer = JSON.stringify(toolResults(ai.requests[1]!)[0]);
		expect(answer).not.toContain('error');
		expect(answer).toContain('north');
		expect(answer).toContain('2');
	});
});

describe('a turn never settles silently (staging: 12 failing reads, then an empty reply)', () => {
	const visible = (rows: Awaited<ReturnType<ReturnType<typeof agents>['transcript']>>) => rows.filter((r) => r.role === 'assistant' && (r.text ?? '').trim() !== '' && r.content !== null
		&& ((r.content as { toolCalls?: Json[] }).toolCalls ?? []).length === 0);

	it('a bad filter names the field and the valid ones; identical failing calls are cut short; an empty reply ends with a visible message', async () => {
		const bad = use('read', { collection: 'quotes', where: { month: '2026-03' } });
		const { ai, agent, user } = await setup([...Array.from({ length: 12 }, () => bad), say(''), say(''), say(''), say('')]);
		const root = await user('root', { admin: true });
		const c = await agent.start({ owner: root });
		await agent.post({ conversation: c, as: { member: root }, text: 'Why did turnover spike in March 2026?' });
		await agent.drain(c);
		// actionable: the bad path, and what may be named instead
		expect(toolResults(ai.requests[1]!)[0]).toMatchObject({ error: expect.stringContaining("unknown field 'month'"), fields: ['title', 'region'] });
		// the fourth identical call is not run again
		expect(toolResults(ai.requests[4]!).at(-1)).toMatchObject({ error: expect.stringContaining('Not run') });
		expect(ai.requests[4]!.messages.some((m) => String(m.content).includes(NUDGE.failing))).toBe(true);
		const rows = await agent.transcript(c);
		// staff see the real failure, not the cut-short
		expect(visible(rows)).toEqual([expect.objectContaining({ text: FIXED.stuck, meta: expect.objectContaining({ tag: 'failed', code: 'toolFailures', detail: expect.stringContaining("unknown field 'month'") }) })]);
		expect((await agent.conversation(c)).status).toBe('idle');
		expect(ai.requests).toHaveLength(6);
	});

	it('a tool call whose arguments did not parse is answered with the parse error and the turn goes on', async () => {
		const garbled: Step = () => ({ content: '', toolCalls: [{ id: 'g1', name: 'read', input: {}, invalid: 'Expected double-quoted property name in JSON at position 12' }], finish: 'tool', usage: { input: 1, output: 1 } });
		const { ai, agent, user } = await setup([garbled, say('Fixed it.')]);
		const root = await user('root', { admin: true });
		const c = await agent.start({ owner: root });
		await agent.post({ conversation: c, as: { member: root }, text: 'How many quotes?' });
		await agent.drain(c);
		expect(toolResults(ai.requests[1]!)[0]).toEqual({ error: expect.stringContaining('not valid JSON (Expected double-quoted') });
		expect(visible(await agent.transcript(c))).toEqual([expect.objectContaining({ text: 'Fixed it.' })]);
	});

	it('an empty reply after a successful read is asked for once more, then answered with a visible message', async () => {
		const { agent, user } = await setup([use('read', { collection: 'quotes' }), say(''), say('')]);
		const root = await user('root', { admin: true });
		const c = await agent.start({ owner: root });
		await agent.post({ conversation: c, as: { member: root }, text: 'summarise' });
		const { reply } = await agent.drain(c);
		expect(reply).toMatchObject({ meta: { tag: 'failed', code: 'emptyReply' } });
		expect(reply?.text).toBe(FIXED.empty);
	});
});

describe('reasoning and metering (L-BOLT-412, L-BOLT-432, L-BOLT-547)', () => {
	const events = async (t: TestWorkspace) => (await t.db.read([{ text: `SELECT severity, attributes FROM sys_event WHERE event = 'ai.call' ORDER BY id`, params: [] }]))[0]!.rows;
	it('reasoning is stored verbatim beside the text (the literal "None." too) and goes back to the model; a reasoning-only reply is kept and continued once', async () => {
		const thinks: Step = (_req, _signal, _onDelta, onProgress) => { onProgress?.('Thinking.'); return { content: '', toolCalls: [], finish: 'stop', reasoning: 'Thinking.', usage: { input: 1, output: 1 } }; };
		const answers: Step = () => ({ content: 'Balanced.', toolCalls: [], finish: 'stop', reasoning: 'None.', usage: { input: 1, output: 1 } });
		const { ai, agent, user } = await setup([thinks, answers, say('again')]);
		const root = await user('root', { admin: true });
		const c = await agent.start({ owner: root });
		await agent.post({ conversation: c, as: { member: root }, text: 'payroll?' });
		const { reply } = await agent.drain(c);
		expect(reply?.content).toMatchObject({ text: 'Balanced.', reasoning: 'None.' });
		const assistant = (await agent.transcript(c)).filter((r) => r.role === 'assistant');
		expect(assistant.map((r) => r.content)).toMatchObject([{ text: '', reasoning: 'Thinking.' }, { text: 'Balanced.', reasoning: 'None.' }]);
		expect(ai.requests[1]!.messages).toContainEqual({ role: 'user', content: `[note]\n${NUDGE.empty}` });
		expect(ai.requests[1]!.messages).toContainEqual({ role: 'assistant', content: { text: '', toolCalls: [], reasoning: 'Thinking.' } });
		await agent.post({ conversation: c, as: { member: root }, text: 'and?' });
		await agent.drain(c);
		expect(ai.requests[2]!.messages).toContainEqual(expect.objectContaining({ role: 'assistant', content: expect.objectContaining({ reasoning: 'None.' }) }));
	});

	it('every provider call is one observation: a charge above the $5 gauge is flagged and the turn goes on; a missing charge is marked for attention; the reply names its model', async () => {
		const pricey: Step = () => ({ content: '', toolCalls: [{ id: 'd1', name: 'history', input: { query: 'x' } }], finish: 'tool', usage: { input: 3, output: 1, cost: 6, call: 'gen-1' } });
		const unpriced: Step = () => ({ content: 'Done.', toolCalls: [], finish: 'stop', usage: { input: 3, output: 1 } });
		const { t, agent, user } = await setup([pricey, unpriced]);
		const root = await user('root', { admin: true });
		const c = await agent.start({ owner: root });
		await agent.post({ conversation: c, as: { member: root }, text: 'go' });
		const { reply } = await agent.drain(c);
		expect(reply?.text).toBe('Done.');
		expect(reply?.meta).toMatchObject({ usage: { calls: 2, cost: 6, model: 'default' } });
		expect(await events(t)).toEqual([
			{ severity: 'warn', attributes: { call: 'gen-1', model: 'default', input: 3, output: 1, cost: 6, settlement: 'pending', gauge: 5 } },
			{ severity: 'warn', attributes: { call: null, model: 'default', input: 3, output: 1, cost: null, settlement: 'attention' } },
		]);
	});

	it('a checkpoint names who asked for it, and input still queued at the boundary stays in what the model reads (L-BOLT-546)', async () => {
		const { ai, agent, user } = await setup([say('| Section | Summary |\n|---|---|\n| Goal | g |'), say('Seen.')]);
		const root = await user('root', { admin: true }), ann = await user('ann', { admin: true });
		const c = await agent.start({ owner: root });
		await agent.post({ conversation: c, as: { member: root }, text: '/compact', mode: 'compact' });
		const queued = await agent.post({ conversation: c, as: { member: ann }, text: 'late one' }); // another sender: claimed at the next step
		await agent.drain(c);
		const checkpoint = (await agent.transcript(c)).find((r) => r.meta?.tag === 'compact')!;
		expect(checkpoint.meta).toMatchObject({ origin: 'manual', keep: [queued.id] });
		expect(JSON.stringify(ai.requests[1]!.messages)).toContain('late one');
	});
});
