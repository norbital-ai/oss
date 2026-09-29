// The agent engine's pure parts (rules 60, 62, 63): bounded tool results, the context projection, the 60 s wall's cut
// steps on the AI port and `ctx.ai.sys_2.infer`'s continuation.
import { respondSystem1 } from '../src/test/index.ts'; // hook:decisions
import { describe, expect, it } from 'vitest';
import type { Json } from '../src/decl/values.ts';
import type { AiPort, AiRequest, AiResponse, CrossCall, EngineManifest } from '../src/engine/contracts.ts';
import { inferFacility, modelCall } from '../src/engine/agent/ai.ts';
import { bound, BOUNDS, messages, outline, projection, system } from '../src/engine/agent/context.ts';
import { preview, type MessageRow } from '../src/engine/agent/schema.ts';

const size = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;
const row = (seq: number, o: Partial<MessageRow> = {}): MessageRow => ({ id: `m${seq}`, conversation: 'c', seq, role: 'user', content: { text: `t${seq}` }, text: `t${seq}`,
	state: 'consumed', mode: 'agent', as: null, author: null, meta: null, supersedes: null, turn: null, ...o });
const port = (answers: ((req: AiRequest, signal: AbortSignal, onDelta?: (t: string) => void) => Promise<AiResponse>)[]) => {
	const requests: AiRequest[] = [];
	let i = 0;
	const p: AiPort = { sys_1: respondSystem1, sys_2: { models: ['default'], infer: (req, signal, onDelta) => { requests.push(req); return answers[i++]!(req, signal, onDelta); } } };
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
		const s = system({ channel: true, brief: 'Brief.', task: 'Task.', skills: { pricing: '---\ndescription: How we price\n---\nbody' } });
		expect(s).toContain('Brief.\n\nTask.\n\nSkills (read one with the skill tool):\n- pricing: How we price');
		expect(s).not.toMatch(/20\d\d|clock|timezone/i);
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
		const never = inferFacility(port([stalls('a'), stalls('b')]).p, { wallMs: 20 });
		expect(await never({ ...call, args: [{ prompt: 'q', steps: 2 }] }, AbortSignal.timeout(5_000))).toMatchObject({ ok: false, error: { kind: 'timeout' } });
	});

	const call: Extract<CrossCall, { op: 'facility' }> = { op: 'facility', facility: 'ai', method: 'sys_2.infer', args: [] };
	const at = (o: Json) => ({ ...call, args: [o] });
	const tool = (name: string, input: Json, id = name) => async (): Promise<AiResponse> => ({ content: '', toolCalls: [{ id, name, input }], finish: 'tool', usage: { input: 1, output: 1 } });
	const output = { kind: 'object', fields: { n: { kind: 'int' }, note: { kind: 'text', optional: true } } } as Json;

	it('sys_2.infer: a structured output is sent as JSON Schema and decoded, naming each offending field (L-BOLT-371)', async () => {
		const { p, requests } = port([done('{"n":"x","extra":1}')]);
		const got = await inferFacility(p)(at({ prompt: 'q', output }), AbortSignal.timeout(5_000));
		expect(requests[0]!.output).toEqual({ type: 'object', additionalProperties: false, properties: { n: { type: 'integer' }, note: { type: 'string' } }, required: ['n'] });
		expect(got).toMatchObject({ ok: false, error: { kind: 'invalid', message: expect.stringMatching(/output\.extra: is not an input.*output\.n: expected an integer/) } });
		expect(await inferFacility(port([done('{"n":2}')]).p)(at({ prompt: 'q', output }), AbortSignal.timeout(5_000))).toEqual({ ok: true, value: { n: 2 } });
	});

	it('sys_2.infer: a reasoning-only reply is continued, at most 3 times running (L-BOLT-371)', async () => {
		const { p, requests } = port([done(''), done('hi')]);
		expect(await inferFacility(p)(at({ prompt: 'q' }), AbortSignal.timeout(5_000))).toEqual({ ok: true, value: 'hi' });
		expect(requests[1]!.messages.at(-1)).toEqual({ role: 'user', content: 'Continue, and give your answer.' });
		expect(await inferFacility(port([done(''), done(''), done(''), done('')]).p)(at({ prompt: 'q' }), AbortSignal.timeout(5_000))).toMatchObject({ ok: false, error: { kind: 'invalid' } });
	});

	it('sys_2.infer with tools: the model calls them, then submits a decoded answer through return_result (L-BOLT-372)', async () => {
		const seen: Json[] = [];
		const browse = { name: 'browse', description: 'Read a page', input: { type: 'object' }, call: async (input: Json) => { seen.push(input); return { text: 'rate is 3' }; } };
		const { p, requests } = port([tool('browse', { url: 'https://x' }), tool('return_result', { result: { n: 'three' } }, 'r1'), tool('return_result', { result: { n: 3 } }, 'r2')]);
		expect(await inferFacility(p)(at({ prompt: 'q', output, tools: ['browse'] }), AbortSignal.timeout(5_000), [browse])).toEqual({ ok: true, value: { n: 3 } });
		expect(seen).toEqual([{ url: 'https://x' }]);
		expect(requests[0]!.tools!.map((t) => t.name)).toEqual(['browse', 'return_result']);
		expect(requests[0]!.output).toBeUndefined();
		expect(requests[1]!.messages.at(-1)).toEqual({ role: 'tool', content: { id: 'browse', name: 'browse', result: { text: 'rate is 3' } } });
		expect(requests[2]!.messages.at(-1)).toMatchObject({ role: 'tool', content: { id: 'r1', result: { error: expect.stringContaining('output.n: expected an integer') } } });
	});

	it('sys_2.infer with tools: the last step offers only return_result, so a model still researching hands in what it has', async () => {
		const browse = { name: 'browse', description: 'Read a page', input: { type: 'object' }, call: async () => ({ text: 'more' }) };
		const { p, requests } = port([tool('browse', {}, 'b1'), tool('browse', {}, 'b2'), tool('return_result', { result: { n: 1 } }, 'r')]);
		expect(await inferFacility(p)(at({ prompt: 'q', output, tools: ['browse'], steps: 3 }), AbortSignal.timeout(5_000), [browse])).toEqual({ ok: true, value: { n: 1 } });
		expect(requests[1]!.tools!.map((t) => t.name)).toEqual(['browse', 'return_result']);
		expect(requests[2]!.tools!.map((t) => t.name)).toEqual(['return_result']);
		expect(requests[2]!.messages.at(-1)).toMatchObject({ role: 'user', content: expect.stringContaining('budget is spent') });
	});
});
