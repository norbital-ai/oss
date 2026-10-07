// The agent engine's pure parts (rules 60, 62, 63): bounded tool results, the context projection, the 60 s wall's cut
// steps on the AI port and `ctx.ai.sys_2.infer`'s continuation.
import { respondSystem1 } from '../src/test/index.ts'; // hook:decisions
import { describe, expect, it } from 'vitest';
import type { Json } from '../src/decl/values.ts';
import type { AiPort, AiRequest, AiResponse, CrossCall, EngineManifest } from '../src/engine/contracts.ts';
import { applyPatch, inferFacility, modelCall } from '../src/engine/agent/ai.ts';
import { bound, BOUNDS, messages, outline, projection, system } from '../src/engine/agent/context.ts';
import { listed, preview, type MessageRow } from '../src/engine/agent/schema.ts';

const size = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;
const row = (seq: number, o: Partial<MessageRow> = {}): MessageRow => ({ id: `m${seq}`, conversation: 'c', seq, role: 'user', content: { text: `t${seq}` }, text: `t${seq}`,
	state: 'consumed', mode: 'agent', as: null, author: null, meta: null, supersedes: null, turn: null, ...o });
const port = (answers: ((req: AiRequest, signal: AbortSignal, onDelta?: (t: string) => void, onReasoning?: (t?: string) => void) => Promise<AiResponse>)[]) => {
	const requests: AiRequest[] = [];
	let i = 0;
	const p: AiPort = { sys_1: respondSystem1, sys_2: { models: ['default'], infer: (req, signal, onDelta, onReasoning) => { requests.push(req); return answers[i++]!(req, signal, onDelta, onReasoning); } } };
	return { p, requests };
};
/** A stream that yields `text`, then stays open until the wall aborts it. */
const stalls = (text: string) => (_: AiRequest, signal: AbortSignal, onDelta?: (t: string) => void) =>
	new Promise<AiResponse>((_, reject) => { onDelta?.(text); signal.addEventListener('abort', () => reject(new Error('aborted'))); });
const done = (text: string) => async (): Promise<AiResponse> => ({ content: text, toolCalls: [], finish: 'stop', usage: { input: 1, output: 1 } });

describe('tool results are bounded (rule 62)', () => {
	it('clips long cells and drops trailing rows with a note, within 16 KiB', () => {
		const rows = Array.from({ length: 200 }, (_, i) => ({ id: String(i), note: 'x'.repeat(2_000) }));
		const out = bound({ rows, next: null }) as { rows: { note: string }[]; clipped: string };
		expect(size(out)).toBeLessThanOrEqual(BOUNDS.resultBytes);
		expect(out.rows[0]!.note).toMatch(/clipped, 2002 bytes/);
		expect(out.clipped).toMatch(new RegExp(`showing ${out.rows.length} of 200 rows`));
		expect(bound({ a: 1 })).toEqual({ a: 1 });
	});
	it('previews are at most 2 KiB', () => {
		expect(new TextEncoder().encode(preview('é'.repeat(3_000))).length).toBeLessThanOrEqual(2051);
		expect(preview('short')).toBe('short');
	});
});

describe('the context projection (rule 60)', () => {
	it('keeps the whole transcript except superseded, ambient, queued, pre-checkpoint and pre-plan rows', () => {
		const rows = [row(1), row(2, { meta: { tag: 'ambient' } }), row(3), row(4, { supersedes: 'm3' }), row(5, { role: 'assistant', content: { text: 'a', toolCalls: [] } }),
			row(6, { role: 'system', content: { text: 'summary' }, meta: { tag: 'compact', cutoff: 5, keep: ['m1'] } }), row(7), row(8, { state: 'queued' }), row(9, { role: null, addressed: false })];
		expect(projection(rows, { plan: null }).map((r) => r.id)).toEqual(['m1', 'm6', 'm7']);
		expect(projection(rows, { plan: { revision: 1, body: 'p', status: 'active', checkpoint: 6, verdicts: 0 } }).map((r) => r.id)).toEqual(['m7']);
		expect(projection(rows.slice(0, 5), { plan: null }).map((r) => r.id)).toEqual(['m1', 'm4', 'm5']);
	});
	it('every message carries its sender header, which says whom the turn serves (rule 57, P32); engine notes are user text', () => {
		const dm = { envoy: { name: 'desk', channel: 'wa', sender: '+65', member: 'u-ann', dm: true } };
		const out = messages([row(1, { author: 'Ann', as: dm }), row(2, { author: '+66', as: { envoy: { ...dm.envoy, member: null, dm: false } } }),
			row(3, { role: 'system', content: { text: 'ok' }, meta: { tag: 'verdict', complete: true, gaps: [] } })]);
		expect(out).toEqual([{ role: 'user', content: '[Ann · linked member u-ann, whose authority joins the envoy\'s] t1' },
			{ role: 'user', content: '[+66 · not linked] t2' }, { role: 'user', content: '[note]\nok' }]);
	});
	it('the system prompt is the kernel, brief, task and skills list only: no date, actor or conversation state (rule 62)', () => {
		const s = system({ envoy: 'Norbius', brief: 'Brief.', task: 'Task.', skills: { pricing: '---\ndescription: How we price\n---\nbody' } });
		expect(s).toContain('Brief.\n\nTask.\n\nSkills (read one with the skill tool):\n- pricing: How we price');
		expect(s).not.toMatch(/20\d\d|clock|timezone/i);
		// the channel guidance names the envoy, so a message that says the name is readable as addressed to it
		expect(s).toContain('You are Norbius, answering on a messaging channel.');
		// and it may not narrate the workspace's own checks
		expect(s).toContain('Never describe the workspace\'s own automated checks');
		// a turn without the source tools (an envoy's) is never told to call them; staff in the app are
		expect(system({ skills: {}, outline: '# Workspace outline' })).not.toMatch(/workspace_search|workspace_type/);
		expect(system({ skills: {}, outline: '# Workspace outline', tools: ['workspace_search'] })).toMatch(/workspace_search reads the source[\s\S]*Search or read any path with workspace_search/);
	});
});

describe('the workspace outline', () => {
	it("names each collection's write contract and nested relation writes, so a write needs no type lookup", () => {
		const m = {
			models: { sites: { fields: { name: {}, code: { optional: true } } }, jobs: { fields: { title: {}, done: { kind: 'enum', values: ['2', '10'] } }, unique: [{ fields: ['title'] }] } },
			collections: {
				sites: { create: { input: { columns: ['name', 'code'], with: { tasks: { create: { columns: ['title', 'site_id'] }, link: {} } } } },
					update: { input: { columns: ['name', 'code'], with: { tasks: { create: { columns: ['title', 'site_id'] }, link: {} } } } }, delete: {} },
				jobs: { create: { input: { columns: ['title'] } }, update: { input: { columns: ['title', 'done'] } } }
			},
			relationships: { 'jobs.site_id': { to: 'sites', inverse: 'tasks', optional: true } }, pipelines: { jobs: { import: {}, export: {} } }, customFields: {}, apps: {}, automations: {}, policies: {}
		} as unknown as EngineManifest;
		const lines = outline(m, null).split('\n');
		expect(lines.find((l) => l.startsWith('- sites'))).toContain('create(name, code?, tasks{create(title, site_id?), link}), update(as create), upsert, delete');
		expect(lines.find((l) => l.startsWith('- jobs'))).toContain('create(title), update(title, done), upsert, pipeline(import|export)');
		expect(lines.find((l) => l.startsWith('- jobs'))).toContain('done("2"|"10")');
	});
});

describe('the AI port under the 60 s wall (rule 63)', () => {
	const req: AiRequest = { model: 'default', messages: [{ role: 'user', content: 'hi' }] };
	it('an absent port or an unmapped class is unavailable; files are capped per call', async () => {
		expect(await modelCall(undefined, req)).toMatchObject({ kind: 'unavailable' });
		expect(await modelCall(port([]).p, { ...req, model: 'vision' })).toMatchObject({ kind: 'unavailable', reason: expect.stringContaining('vision') });
		const files = Array.from({ length: 9 }, () => ({ mime: 'image/png', bytes: new Uint8Array(1) }));
		expect(await modelCall(port([]).p, { ...req, files })).toMatchObject({ kind: 'invalid' });
	});
	it('a stream open at the wall is kept as a cut step; one that yields nothing is a timeout (OD-13)', async () => {
		expect(await modelCall(port([stalls('partial ')]).p, req, { wallMs: 20 })).toMatchObject({ finish: 'cut', content: 'partial ' });
		expect(await modelCall(port([stalls('')]).p, req, { wallMs: 20 })).toMatchObject({ kind: 'timeout' });
		const own = async (): Promise<AiResponse> => ({ content: 'x', toolCalls: [], finish: 'cut', continuation: 'k', usage: { input: 1, output: 1 } });
		expect(await modelCall(port([own]).p, req, { wallMs: 20 })).toMatchObject({ finish: 'cut', continuation: 'k' });
		expect(await modelCall(port([async () => { throw Object.assign(new Error('prompt is too long'), { status: 400 }); }]).p, req)).toMatchObject({ kind: 'upstream', status: 400 });
	});
	it('ctx.ai.sys_2.infer: a 90 s stream is two calls and one answer', async () => {
		const { p, requests } = port([stalls('The answer '), done('is 42.')]);
		const infer = inferFacility(p, { wallMs: 20 });
		const call: Extract<CrossCall, { op: 'facility' }> = { op: 'facility', facility: 'ai', method: 'sys_2.infer', args: [{ prompt: 'q' } as Json] };
		expect(await infer(call, AbortSignal.timeout(5_000))).toEqual({ ok: true, value: 'The answer is 42.' });
		expect(requests).toHaveLength(2);
		expect(requests[1]!.messages).toEqual([{ role: 'user', content: 'q' }, { role: 'assistant', content: 'The answer ' }]);
		const json = inferFacility(port([stalls('{"n":'), done('42}')]).p, { wallMs: 20 });
		expect(await json({ ...call, args: [{ prompt: 'q', output: { kind: 'json' } }] }, AbortSignal.timeout(5_000))).toEqual({ ok: true, value: { n: 42 } });
		// no step budget: a model that never finishes runs until the ceiling on the whole call (the run's signal) ends it
		const never = inferFacility(port(Array.from({ length: 200 }, () => stalls('a'))).p, { wallMs: 20 });
		expect(await never({ ...call, args: [{ prompt: 'q' }] }, AbortSignal.timeout(400))).toMatchObject({ ok: false, error: { kind: 'timeout', message: expect.stringContaining('did not finish within') } });
	});

	const call: Extract<CrossCall, { op: 'facility' }> = { op: 'facility', facility: 'ai', method: 'sys_2.infer', args: [] };
	const at = (o: Json) => ({ ...call, args: [o] });
	const tool = (name: string, input: Json, id = name) => async (): Promise<AiResponse> => ({ content: '', toolCalls: [{ id, name, input }], finish: 'tool', usage: { input: 1, output: 1 } });
	const output = { kind: 'object', fields: { n: { kind: 'int' }, note: { kind: 'text', optional: true } } } as Json;

	it('sys_2.infer: a structured answer is built with patch and handed in with submit; a failed submit comes back by path and the loop goes on', async () => {
		const { p, requests } = port([tool('patch', { ops: [{ op: 'add', path: '/n', value: 'x' }] }, 'p1'), tool('submit', {}, 's1'),
			tool('patch', { ops: [{ op: 'replace', path: '/n', value: 3 }, { op: 'add', path: '/note', value: 'seen' }] }, 'p2'), tool('submit', {}, 's2')]);
		expect(await inferFacility(p)(at({ prompt: 'q', output }), AbortSignal.timeout(5_000))).toEqual({ ok: true, value: { n: 3, note: 'seen' } });
		expect(requests[0]!.tools!.map((t) => t.name)).toEqual(['patch', 'submit']);
		expect(requests[0]!.output).toBeUndefined();
		// the shape to build is in the prompt, as JSON Schema
		expect(requests[0]!.messages[0]!.content).toContain('"required":["n"]');
		expect(requests[2]!.messages.at(-1)).toMatchObject({ role: 'tool', content: { id: 's1', result: { error: expect.stringContaining('/n: expected an integer') } } });
	});

	it('applyPatch: RFC 6902 add, replace and remove at JSON Pointers, parents created, "-" appends, a batch whole or not at all', () => {
		const doc = { entries: { a: [{ label: '1' }] } } as Json;
		expect(applyPatch(doc, [{ op: 'add', path: '/entries/a/-', value: { label: '2' } }, { op: 'add', path: '/entries/b/label', value: 'x' },
			{ op: 'replace', path: '/entries/a/0/label', value: '1A' }, { op: 'remove', path: '/entries/a/1' }, { op: 'add', path: '/items', value: ['1A'] }]))
			.toEqual({ entries: { a: [{ label: '1A' }], b: { label: 'x' } }, items: ['1A'] });
		expect(() => applyPatch(doc, [{ op: 'add', path: '/ok', value: 1 }, { op: 'replace', path: '/missing', value: 1 }])).toThrow(/operation 1 \(replace \/missing\)/);
		expect(doc).toEqual({ entries: { a: [{ label: '1' }] } }); // the draft is never edited in place
	});

	it('sys_2.infer: the wall is idle time, so a model streaming its reasoning past it is one call, never cut', async () => {
		// every 10 ms a reasoning token for 100 ms against a 30 ms wall, then the answer
		const reasons = async (_: AiRequest, signal: AbortSignal, _d?: (t: string) => void, onReasoning?: (t?: string) => void): Promise<AiResponse> => {
			for (let i = 0; i < 10; i++) { if (signal.aborted) throw new Error('aborted'); onReasoning?.('thinking '); await new Promise((r) => setTimeout(r, 10)); }
			return { content: '{"n":5}', toolCalls: [], finish: 'stop', usage: { input: 1, output: 1 } };
		};
		const { p, requests } = port([reasons]);
		expect(await inferFacility(p, { wallMs: 30 })(at({ prompt: 'q', output }), AbortSignal.timeout(5_000))).toEqual({ ok: true, value: { n: 5 } });
		expect(requests).toHaveLength(1);
	});

	it('sys_2.infer: a structured answer that misses the output is handed back with its problems, at most 3 times running', async () => {
		// one impossible field used to end the inference, which cost the automation that owned it the whole answer
		const { p, requests } = port([done('{"n":"x"}'), done('{"n":4}')]);
		expect(await inferFacility(p)(at({ prompt: 'q', output }), AbortSignal.timeout(5_000))).toEqual({ ok: true, value: { n: 4 } });
		expect(requests).toHaveLength(2);
		expect(requests[1]!.messages.at(-1)).toMatchObject({ role: 'user', content: expect.stringContaining('/n: expected an integer') });
	});

	it('sys_2.infer: a structured answer written out as text is taken as a submission; prose is asked to patch, at most 3 times running', async () => {
		// one chatty turn used to fail the whole inference, which failed the automation that owned it
		const { p, requests } = port([done('Sure! Here is the verdict: suspicious.'), done('{"n":3}')]);
		expect(await inferFacility(p)(at({ prompt: 'q', output }), AbortSignal.timeout(5_000))).toEqual({ ok: true, value: { n: 3 } });
		expect(requests[1]!.messages.at(-1)).toMatchObject({ role: 'user', content: expect.stringContaining('Build the answer with patch') });
		expect(await inferFacility(port([done('prose'), done('more prose'), done('still prose'), done('never json')]).p)(at({ prompt: 'q', output }), AbortSignal.timeout(5_000)))
			.toMatchObject({ ok: false, error: { kind: 'invalid', message: 'the model did not build its answer with patch and submit' } });
	});

	it('sys_2.infer: a reasoning-only reply is continued, at most 3 times running (L-BOLT-371)', async () => {
		const { p, requests } = port([done(''), done('hi')]);
		expect(await inferFacility(p)(at({ prompt: 'q' }), AbortSignal.timeout(5_000))).toEqual({ ok: true, value: 'hi' });
		expect(requests[1]!.messages.at(-1)).toEqual({ role: 'user', content: 'Continue, and give your answer.' });
		expect(await inferFacility(port([done(''), done(''), done(''), done('')]).p)(at({ prompt: 'q' }), AbortSignal.timeout(5_000))).toMatchObject({ ok: false, error: { kind: 'invalid' } });
	});

	it('sys_2.infer with a JSON Schema output: the schema checks structure (if/then included), CEL rules check logic, both come back by path', async () => {
		const jsonSchema = { type: 'object', required: ['test'], properties: { test: { type: 'object', properties: {
			status: { enum: ['done', 'unable'] }, reading: { type: 'number', minimum: 0 }, reason: { type: 'string' } },
			if: { properties: { status: { const: 'unable' } } }, then: { required: ['reason'] } } } } as Json;
		const rules = [{ expression: "has(test.status) && test.status == 'unable' ? !has(test.reading) : true", message: 'an unperformed test has no reading' }];
		const { p, requests } = port([
			tool('patch', { ops: [{ op: 'add', path: '/test', value: { status: 'unable', reading: -1 } }] }, 'p1'), tool('submit', {}, 's1'),
			tool('patch', { ops: [{ op: 'remove', path: '/test/reading' }, { op: 'add', path: '/test/reason', value: 'VTs connected' }] }, 'p2'), tool('submit', {}, 's2')]);
		expect(await inferFacility(p)(at({ prompt: 'q', output: { jsonSchema, rules } }), AbortSignal.timeout(5_000)))
			.toEqual({ ok: true, value: { test: { status: 'unable', reason: 'VTs connected' } } });
		expect(requests[0]!.messages[0]!.content).toContain('an unperformed test has no reading');
		const back = JSON.stringify(requests[2]!.messages.at(-1));
		expect(back).toContain('/test/reading');
		expect(back).toContain('reason');
		expect(back).toContain('rule broken: an unperformed test has no reading');
		// a rule that does not compile is the caller's, refused before any model call
		expect(await inferFacility(port([]).p)(at({ prompt: 'q', output: { jsonSchema, rules: [{ expression: 'test.(', message: 'x' }] } }), AbortSignal.timeout(5_000)))
			.toMatchObject({ ok: false, error: { kind: 'invalid', message: expect.stringContaining('rule "x"') } });
	});

	it('sys_2.infer: more files than one request carries are read in batches into one draft, checked only after the last', async () => {
		const loads: string[] = [];
		const load = async (id: string) => { loads.push(id); return { mime: 'image/png', bytes: new Uint8Array(1) }; };
		const jsonSchema = { type: 'object', required: ['rows'], properties: { rows: { type: 'array', minItems: 2, items: { type: 'string' } } } } as Json;
		const { p, requests } = port([
			tool('patch', { ops: [{ op: 'add', path: '/rows', value: ['a'] }] }, 'p1'), tool('submit', {}, 's1'),
			tool('patch', { ops: [{ op: 'add', path: '/rows/-', value: 'b' }] }, 'p2'), tool('submit', {}, 's2')]);
		const files = Array.from({ length: 10 }, (_, i) => ({ id: `f${i}` }));
		expect(await inferFacility(p, { load })(at({ prompt: 'q', files, output: { jsonSchema } }), AbortSignal.timeout(5_000))).toEqual({ ok: true, value: { rows: ['a', 'b'] } });
		expect(requests.map((r) => r.files?.length)).toEqual([8, 8, 2, 2]);
		expect(loads).toEqual(files.map((f) => f.id));
		// the second batch starts from the first one's draft, which minItems alone would have refused
		expect(requests[2]!.messages[0]!.content).toContain('files 9–10');
		expect(requests[2]!.messages[0]!.content).toContain('{"rows":["a"]}');
	});

	it('sys_2.infer with tools: the model calls them beside patch and submit (L-BOLT-372)', async () => {
		const seen: Json[] = [];
		const browse = { name: 'browse', description: 'Read a page', input: { type: 'object' }, call: async (input: Json) => { seen.push(input); return { text: 'rate is 3' }; } };
		const { p, requests } = port([tool('browse', { url: 'https://x' }), tool('patch', { ops: [{ op: 'add', path: '/n', value: 3 }] }, 'p1'), tool('submit', {}, 's1')]);
		expect(await inferFacility(p)(at({ prompt: 'q', output, tools: ['browse'] }), AbortSignal.timeout(5_000), [browse])).toEqual({ ok: true, value: { n: 3 } });
		expect(seen).toEqual([{ url: 'https://x' }]);
		expect(requests[0]!.tools!.map((t) => t.name)).toEqual(['browse', 'patch', 'submit']);
		expect(requests[1]!.messages.at(-1)).toEqual({ role: 'tool', content: { id: 'browse', name: 'browse', result: { text: 'rate is 3' } } });
	});

});

describe('the panel conversation list', () => {
	it('admits a public envoy thread, and only what the read would return', () => {
		// a channel thread carries no owner, so admitting it by owner alone would keep every thread out of the live list
		const own = { owner: 'ann', channel: null, parent: null, envoy: null };
		const child = { owner: 'ann', channel: null, parent: 'p', envoy: null };
		const other = { owner: 'bob', channel: null, parent: null, envoy: null };
		const publicThread = { owner: null, channel: 'whatsapp', parent: null, envoy: 'field_ops' };
		const privateThread = { owner: null, channel: 'whatsapp', parent: null, envoy: 'secret' };
		expect(listed(own, 'ann')).toBe(true);
		expect(listed(child, 'ann')).toBe(false); // a sub-agent is never a root
		expect(listed(other, 'ann')).toBe(false);
		expect(listed(publicThread, 'ann', ['field_ops'])).toBe(true);
		expect(listed(privateThread, 'ann', ['field_ops'])).toBe(false); // never a row the read would not return
		expect(listed(null, 'ann', ['field_ops'])).toBe(false);
	});
});
