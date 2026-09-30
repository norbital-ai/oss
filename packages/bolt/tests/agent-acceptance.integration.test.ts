// The owner's agent acceptance (2026-09-26) through the engine entry and the test kit, against a scripted model:
// a skill authored at `src/agent/skill/+<n>.skill.md` is compiled and read by the agent; the workspace's source and
// type index are generic tools (`workspace_search` for staff in the app, the outline in the prompt, `workspace_type` filtered by what the actor may
// use); an MCP server reaches its URL and token through the tenant's env with no host MCP binding; and an envoy over a
// fake WhatsApp: group chatter System 1 ignores gets nothing, a mention is answered, a DM is answered after triage.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Json } from '../src/decl/values.ts';
import type { AiPort, AiRequest, AiResponse, EngineManifest } from '../src/engine/contracts.ts';
import type { WorkspacePort } from '../src/engine/agent/tools.ts';
import type { System1Port } from '../src/engine/decisions/index.ts';
import { TRIAGE_DEBOUNCE } from '../src/engine/agent/triage.ts';
import { respondSystem1, testWorkspace } from '../src/test/index.ts';

const GOOD = fileURLToPath(new URL('./fixtures/good', import.meta.url));
type Step = (req: AiRequest) => AiResponse;
const say = (text: string): Step => () => ({ content: text, toolCalls: [], finish: 'stop', usage: { input: 10, output: 5 } });
const use = (name: string, input: Json): Step => () => ({ content: '', toolCalls: [{ id: `c${Math.random().toString(36).slice(2, 8)}`, name, input }], finish: 'tool', usage: { input: 10, output: 5 } });
function cassette(steps: Step[], sys_1: System1Port = respondSystem1) {
	const requests: AiRequest[] = [];
	const port: AiPort = { sys_1, sys_2: { models: ['default'], async infer(req) { requests.push(req); const s = steps.shift(); if (s === undefined) throw new Error('cassette exhausted'); return s(req); } } };
	return { port, requests };
}
const names = (r: AiRequest | undefined) => (r?.tools ?? []).map((t) => t.name);
/**
 * The tools a request's prompt names but does not offer. A prompt naming a tool the turn lacks is a call to nothing:
 * staging's WhatsApp envoy called workspace_search, and its tool-call markup went out as a chat message.
 */
const unoffered = (r: AiRequest) => [...new Set(r.system?.match(/\b(?:read|write|workspace|update|sandbox)_[a-z_]+\b/g))].filter((n) => !names(r).includes(n));
const results = (r: AiRequest) => r.messages.filter((m) => m.role === 'tool').map((m) => (m.content as { result: Json }).result);
const member = (id: string, o: { admin?: boolean; external?: boolean } = {}) => ({ text: `INSERT INTO sys_user (id, email, name, admin, kind) VALUES ($1, $2, $3, $4, $5)`,
	params: [id, `${id}@x.test`, id, o.admin ?? false, o.external ? 'external' : 'staff'] as Json[] });

// a page longer than one read: quotes and tabs grow when encoded, as a Svelte page's do
const DESK = 'src/app/crm/+desk.page.svelte';
const desk = Array.from({ length: 1500 }, (_, n) => `\t<td class="col">{row["field_${n + 1}"]}</td>`).join('\n');
/** The artifact's workspace as a host binds it (`workspaceFiles`); the index entry is what `bolt build` wrote for the good fixture. */
const workspace: WorkspacePort = {
	files: async () => ['src/agent/skill/+triage.skill.md', 'src/data/collection/orders/+collection.ts'],
	read: async (p) => p === 'src/agent/skill/+triage.skill.md' ? '---\ndescription: Triage a notice\n---\n## Steps\nRead it.\n' : p === DESK ? desk : null,
	types: async () => ({
		'collections.orders.queries.count_placed': { type: '{\n\tinput: {};\n\toutput: number;\n}', docs: 'Placed orders', source: 'src/data/collection/orders/+collection.ts:6' },
		'components.lib/panel': { type: '{\n\tjob: string;\n}', source: 'src/lib/panel.svelte' },
	}),
};

const manifest = {
	workspace: { tz: 'UTC', locale: 'en', env: { HQ_URL: { label: 'HQ' }, HQ_TOKEN: { label: 'HQ token', secret: true } } },
	models: { jobs: { description: 'A job', label: 'title', fields: { title: { kind: 'text' } } } }, relationships: {},
	collections: { jobs: { read: { fields: 'all' } } }, integrations: {}, pipelines: {},
	policies: { desk: { description: 'Desk', grants: { jobs: { read: true } } } }, teams: {}, automations: {},
	channels: { field_wa: { transport: 'whatsapp' } }, connections: {},
	envoys: { field_ops: { channel: 'field_wa', audience: 'public', name: 'Norbius', policies: ['desk'], groupMessages: 'mention_or_reply', delegation: 'disabled', triage: {}, task: 'Keep jobs up to date.' } },
	mcp: { hq: { description: 'HQ tools', url: 'HQ_URL', auth: { bearer: 'HQ_TOKEN' } } }, apps: {}, customFields: {}, agent: { internal: 'Staff brief.', external: 'Customer brief.', skills: {} },
} as unknown as EngineManifest;

describe('skills and the workspace tools (acceptance 1, 3, 8)', () => {
	it('a compiled +triage.skill.md is listed in the static prompt beside the outline and read by the skill tool; workspace_type and workspace_search answer staff', async () => {
		const ai = cassette([use('skill', { name: 'triage', section: 'Steps' }), use('workspace_type', { name: 'collections.orders.queries.count_placed' }),
			use('workspace_search', { path: 'src/agent/skill/+triage.skill.md' }), say('Read it first.')]);
		const t = await testWorkspace({ root: GOOD, seed: 'none', ai: ai.port, agent: { workspace } });
		await t.db.write(member('ann', { admin: true }));
		const c = await t.engine.agents.start({ owner: 'ann' });
		await t.engine.agents.post({ conversation: c, as: { member: 'ann' }, text: 'How do I triage a notice?' });
		expect((await t.engine.agents.drain(c)).reply?.text).toBe('Read it first.');
		expect(ai.requests[0]!.system).toContain('- triage: Triage a notice');
		expect(ai.requests[0]!.system).toMatch(/# Workspace outline[\s\S]*## Collections\n[^\n]+\n- customers/);
		expect(names(ai.requests[0])).toEqual(expect.arrayContaining(['skill', 'workspace_type', 'workspace_search']));
		expect(results(ai.requests[1]!)[0]).toBe('## Steps\nRead it.\n');
		expect(results(ai.requests[2]!)[1]).toMatchObject({ type: '{\n\tinput: {};\n\toutput: number;\n}', source: 'src/data/collection/orders/+collection.ts:6' });
		expect(results(ai.requests[3]!)[2]).toEqual({ path: 'src/agent/skill/+triage.skill.md', total: 6, from: 1, to: 6, lines: expect.arrayContaining(['4: ## Steps']) });
	});

	it('workspace_search pages a long file as numbered lines with its line count, unclipped; from and to read a range', async () => {
		const ai = cassette([use('workspace_search', { path: DESK }), use('workspace_search', { path: DESK, from: 1400, to: 1402 }), use('workspace_search', { path: DESK, from: 1490 }), say('read')]);
		const t = await testWorkspace({ root: GOOD, seed: 'none', ai: ai.port, agent: { workspace } });
		await t.db.write(member('ann', { admin: true }));
		const c = await t.engine.agents.start({ owner: 'ann' });
		await t.engine.agents.post({ conversation: c, as: { member: 'ann' }, text: 'Read the desk.' });
		await t.engine.agents.drain(c);
		type Page = { total: number; from: number; to: number; lines: string[]; next?: number };
		const first = results(ai.requests[1]!)[0] as unknown as Page;
		expect(first).toMatchObject({ total: 1500, from: 1 });
		expect(first.lines[0]).toBe('1: \t<td class="col">{row["field_1"]}</td>');
		expect(first.lines).toHaveLength(first.to);
		expect(first.next).toBe(first.to + 1);
		expect(JSON.stringify(results(ai.requests[1]!)[0])).not.toContain('clipped');
		expect(results(ai.requests[2]!)[1]).toEqual({ path: DESK, total: 1500, from: 1400, to: 1402,
			lines: [1400, 1401, 1402].map((n) => `${n}: \t<td class="col">{row["field_${n}"]}</td>`) });
		expect(results(ai.requests[3]!)[2]).toMatchObject({ path: DESK, total: 1500, from: 1490, to: 1500 });
		expect(results(ai.requests[3]!)[2]).not.toHaveProperty('next');
	});

	it('an external member gets workspace_type for what they may use only, no workspace_search and no outline', async () => {
		const ai = cassette([use('workspace_type', {}), say('ok')]);
		const t = await testWorkspace({ manifest, ai: ai.port, agent: { workspace } });
		await t.db.write(member('eve', { external: true }));
		const c = await t.engine.agents.start({ owner: 'eve' });
		await t.engine.agents.post({ conversation: c, as: { member: 'eve' }, text: 'types?' });
		await t.engine.agents.drain(c);
		expect(names(ai.requests[0])).toContain('workspace_type');
		expect(names(ai.requests[0])).not.toContain('workspace_search');
		expect(ai.requests[0]!.system).not.toContain('# Workspace outline');
		expect(unoffered(ai.requests[0]!)).toEqual([]);
		expect(results(ai.requests[1]!)[0]).toEqual({ names: [] }); // no collection of hers, no components
	});
});

// a local MCP server: stateless streamable HTTP answering JSON
let hq: Server, hqUrl = '';
beforeAll(async () => {
	hq = createServer(async (req, res) => {
		if (req.headers.authorization !== 'Bearer tenant-token') { res.writeHead(401).end(); return; }
		if (req.method !== 'POST') { res.writeHead(405).end(); return; }
		let body = '';
		for await (const c of req) body += String(c);
		const msg = JSON.parse(body) as { id?: number; method: string; params: { protocolVersion?: string; arguments?: { text?: string } } };
		if (msg.id === undefined) { res.writeHead(202).end(); return; }
		const result = msg.method === 'initialize' ? { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'hq', version: '1' } }
			: msg.method === 'tools/list' ? { tools: [{ name: 'echo', description: 'Echo text', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] }
			: { content: [{ type: 'text', text: `echo: ${msg.params.arguments?.text}` }] };
		res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
	});
	await new Promise<void>((r) => hq.listen(0, '127.0.0.1', r));
	hqUrl = `http://127.0.0.1:${(hq.address() as AddressInfo).port}/mcp`;
});
afterAll(() => new Promise<void>((r) => hq.close(() => r())));


describe('MCP through the tenant env (acceptance 2)', () => {
	it('with no host MCP binding, the server URL and token come from the tenant env and its tool is called', async () => {
		const ai = cassette([use('mcp__hq__echo', { text: 'hi' }), say('HQ said hi.')]);
		const env = { HQ_URL: hqUrl, HQ_TOKEN: 'tenant-token' } as { [k: string]: string };
		const t = await testWorkspace({ manifest, ai: ai.port, runs: { env: (n) => env[n] } });
		await t.db.write(member('root', { admin: true }));
		const c = await t.engine.agents.start({ owner: 'root' });
		await t.engine.agents.post({ conversation: c, as: { member: 'root' }, text: 'ask hq' });
		expect((await t.engine.agents.drain(c)).reply?.text).toBe('HQ said hi.');
		expect(names(ai.requests[0])).toContain('mcp__hq__echo');
		expect(results(ai.requests[1]!)[0]).toMatchObject({ content: [{ type: 'text', text: 'echo: hi' }] });
	});
});

describe('an envoy over a fake WhatsApp with System 1 triage (acceptance 7)', () => {
	it('group chatter not for Norbius is ignored (no reply, never input); a mention is answered at once; a DM waits, then is answered', async () => {
		const decided: { kind: string; assistant: string; pending: string[]; asked: string[] }[] = [];
		// one verdict per pending message, in one call: the script is read per message, not per conversation
		const script = ['no', 'delay', 'yes'];
		const sys_1: System1Port = { async ask(r) {
			const st = r.state as { conversation: string; assistant: string; pending: { text: string }[] };
			const asked = Object.keys(r.questions).filter((id) => id !== 'wait');
			decided.push({ kind: st.conversation, assistant: st.assistant, pending: st.pending.map((p) => p.text), asked });
			const answers: Record<string, unknown> = {};
			for (const id of asked) {
				const v = script.shift()!;
				answers[id] = { type: 'choice', choice: v, confidence: 0.9, probabilities: { [v]: 0.9 } };
			}
			answers['wait'] = { type: 'score', score: 3, level: 3, confidence: 0.9, probabilities: {}, legend: {} };
			return { answers: answers as never, costUsd: 0.0001, provider: 'scripted' };
		} };
		const ai = cassette([say('Noted.'), say('On it.')], sys_1);
		const t = await testWorkspace({ manifest, ai: ai.port });
		const wa = t.fakes.transports.whatsapp;
		let n = 0;
		const inbound = async (from: string, text: string, over: { [k: string]: Json } = {}) => {
			await wa.emit({ kind: 'inbound', channel: 'field_wa', message: { id: `m${++n}`, thread: from, sentAt: t.clock.now(), from: { handle: from, name: null }, text, attachments: [], ...over } });
			await t.settled();
		};
		const debounce = async (s = TRIAGE_DEBOUNCE / 1000) => { t.clock.advance(`${s}s`); await t.runDue(); };
		const texts = () => wa.sent.map((s) => (s.message as { text: string }).text);
		const GROUP = { thread: '1203@g.us', group: true };

		await inbound('6591110000@s.whatsapp.net', 'lunch at 12?', GROUP);
		await debounce();
		expect(decided[0]).toEqual({ kind: 'envoy group', assistant: 'Norbius', pending: ['lunch at 12?'], asked: ['m0'] });
		expect(texts()).toEqual([]);
		expect(ai.requests).toHaveLength(0);

		await inbound('6591110000@s.whatsapp.net', '@bot the van is late', { ...GROUP, invocation: 'mention' });
		expect(decided).toHaveLength(1); // a mention bypasses System 1
		expect(texts()).toEqual(['Noted.']);
		expect(JSON.stringify(ai.requests[0]!.messages)).not.toContain('lunch at 12?');
		expect(unoffered(ai.requests[0]!)).toEqual([]);

		await inbound('6592220000@s.whatsapp.net', 'can you check job 7');
		await debounce();
		expect(decided[1]).toEqual({ kind: 'envoy DM', assistant: 'Norbius', pending: ['can you check job 7'], asked: ['m0'] });
		expect(texts()).toEqual(['Noted.']); // waiting for more
		await debounce(3);
		expect(decided[2]!.kind).toBe('envoy DM');
		expect(texts()).toEqual(['Noted.', 'On it.']);
		expect(wa.sent.at(-1)!.message).toMatchObject({ to: expect.stringContaining('6592220000') });
	});

	it('one call judges every pending message, and only the one it answers is admitted', async () => {
		// the shape the decider is asked in: `m0`, `m1`, … each its own yes/no/delay, all in one request. Without this a
		// burst is one verdict for the conversation, so a message that says the name cannot be answered while chatter is
		// ignored — which is exactly the bug that made `hi Norbius` disappear.
		const calls: string[][] = [];
		const sys_1: System1Port = { async ask(r) {
			const ids = Object.keys(r.questions).filter((id) => id !== 'wait');
			calls.push(ids);
			const answers: Record<string, unknown> = Object.fromEntries(ids.map((id, i) => [id, { type: 'choice', choice: i === 0 ? 'no' : 'yes',
				confidence: 0.9, probabilities: {} }]));
			answers['wait'] = { type: 'score', score: 0, level: 0, confidence: 0.9, probabilities: {}, legend: {} };
			return { answers: answers as never, costUsd: 0, provider: 'scripted' };
		} };
		const ai = cassette([say('On the van.')], sys_1);
		const t = await testWorkspace({ manifest, ai: ai.port });
		const wa = t.fakes.transports.whatsapp;
		let n = 0;
		const inbound = async (text: string) => {
			await wa.emit({ kind: 'inbound', channel: 'field_wa', message: { id: `n${++n}`, thread: '1203@g.us', sentAt: t.clock.now(),
				from: { handle: '6591110000@s.whatsapp.net', name: null }, text, attachments: [], group: true } });
			await t.settled();
		};
		const texts = () => wa.sent.map((s) => (s.message as { text: string }).text);

		await inbound('lunch at 12?');
		await inbound('Norbius, the van is late');
		t.clock.advance(`${TRIAGE_DEBOUNCE / 1000}s`);
		await t.runDue();

		expect(calls).toEqual([['m0', 'm1']]); // one call, both messages
		expect(texts()).toEqual(['On the van.']);
		expect(JSON.stringify(ai.requests.map((r) => r.messages))).not.toContain('lunch at 12?'); // the `no` never reached the model
	});
});
