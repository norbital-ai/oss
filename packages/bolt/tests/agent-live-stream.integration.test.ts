// The agent's turn reaches the panel through the one live stream (§5.9, rules 64–66): while the model writes, its reply
// row is rewritten at most every STREAM_FLUSH_MS and each flush arrives as a `patch` of the conversation's live
// transcript (the text growing, `streaming` until the final write); a tool call is a `running` row finished in place;
// the conversation list patches `running` then `idle`. Nothing re-reads: each view has one `answer`, then patches. A stop
// keeps the partial reply, marked interrupted. `/__bolt/agent/stream` and `/__bolt/agent/conversations` are gone.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AiPort, AiResponse, EngineManifest } from '../src/engine/contracts.ts';
import { STREAM_FLUSH_MS } from '../src/engine/agent/index.ts';
import { Authorities } from '../src/engine/identity/actor.ts';
import { boltHandler } from '../src/protocol/http.ts';
import type { AgentConversation, AgentRow, Frame } from '../src/protocol/wire.ts';
import { shellApi } from '../src/shell/runtime.ts';
import { respondSystem1, testWorkspace } from '../src/test/index.ts';
import { sse } from './support/live-bolt.ts';

const manifest = {
	workspace: { tz: 'UTC', locale: 'en', agent: { triage: false } },
	models: {}, relationships: {}, collections: {}, policies: {},
	agent: { internal: 'Staff brief.', skills: {} },
	integrations: {}, pipelines: {}, teams: {}, automations: {}, channels: {}, connections: {}, envoys: {}, mcp: {}, apps: {}, customFields: {},
} as unknown as EngineManifest;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Long enough between two deltas for a flush to be written and routed. */
const GAP = STREAM_FLUSH_MS * 2;
const usage = { input: 10, output: 5 };
const until = async (ok: () => boolean, n = 1_000) => { for (let i = 0; i < n && !ok(); i++) await sleep(5); expect(ok()).toBe(true); };

type Infer = AiPort['sys_2']['infer'];
async function setup(infer: Infer) {
	const ai: AiPort = { sys_1: respondSystem1, sys_2: { models: ['default'], infer } };
	const t = await testWorkspace({ manifest, ai });
	await t.db.write({ text: `INSERT INTO sys_user (id, email, name) VALUES ('ann', 'ann@x.test', 'Ann')`, params: [] });
	const ann = (await new Authorities(manifest, 'test').member(t.db, 'ann'))!;
	const handle = boltHandler({ engine: t.engine, session: async () => ann, uuid: randomUUID,
		bindings: () => ({ now: t.clock.now(), today: t.clock.now().slice(0, 10), tz: 'UTC', params: {} }) });
	const fetch = (async (url: string | URL | Request, init?: RequestInit) =>
		await handle(new Request(new URL(String(url), 'http://cell'), init)) ?? new Response(null, { status: 404 })) as typeof globalThis.fetch;
	const api = shellApi(fetch);
	const started = await api.agent.start('Live');
	if (!started.ok || started.value.kind !== 'committed') throw new Error('start');
	const c = String((started.value.output as { id: string }).id);
	// the page's one live stream, and the panel's two views on it: the transcript and the conversation list
	const frames: Frame[] = [];
	const source = sse((u) => fetch(u), '/__bolt/live');
	source.onmessage = (m) => frames.push(JSON.parse(m.data) as Frame);
	await until(() => frames.some((f) => f.t === 'hello'));
	const conn = (frames.find((f) => f.t === 'hello') as Extract<Frame, { t: 'hello' }>).conn;
	const reg = await fetch('/__bolt/live', { method: 'POST', headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ conn, add: [{ view: 't', read: { m: 'transcript', a: [c] } }, { view: 'l', read: { m: 'conversations', a: [] } }] }) });
	expect(((await reg.json()) as { errors: unknown[] }).errors).toEqual([]);
	await until(() => frames.filter((f) => f.t === 'answer').length === 2);
	/** Every row a view's patches carried, in arrival order. */
	const upserts = <R>(view: string) => frames.flatMap((f) => f.t === 'patch' && f.view === view ? f.ops.flatMap((o) => o.op === 'upsert' ? [o.row as unknown as R] : []) : []);
	const settled = async () => { await handle.settled(); await t.engine.live.settled(); await sleep(20); };
	return { t, api, c, fetch, frames, upserts, settled, close: () => source.close() };
}

describe('the agent turn over the live stream', () => {
	it('each flush of a reply arrives as a transcript patch while the model is still writing; tools run then finish in place', async () => {
		let step = 0;
		const seen: boolean[] = [];
		let s!: Awaited<ReturnType<typeof setup>>;
		const partial = (text: string) => s.upserts<AgentRow>('t').some((r) => r.role === 'assistant' && r.state === 'streaming' && r.text === text);
		s = await setup(async (_req, _signal, onDelta, onProgress): Promise<AiResponse> => {
			if (++step === 1) {
				onProgress?.('Looking ');
				onDelta?.('Let me ');
				await sleep(GAP);
				seen.push(partial('Let me ')); // the panel already shows the first words
				onDelta?.('check.');
				await sleep(GAP);
				return { content: 'Let me check.', toolCalls: [{ id: 'k1', name: 'history', input: { query: 'x' } }], finish: 'tool', reasoning: 'Looking ', usage };
			}
			onDelta?.('All ');
			await sleep(GAP);
			seen.push(partial('All '));
			onDelta?.('done');
			await sleep(GAP);
			seen.push(partial('All done'));
			onDelta?.('.');
			return { content: 'All done.', toolCalls: [], finish: 'stop', usage };
		});
		try {
			const posted = await s.api.agent.post(s.c, 'status?', true);
			expect(posted.ok && posted.value.kind).toBe('committed');
			await s.settled();
			expect(seen).toEqual([true, true, true]);

			const rows = s.upserts<AgentRow>('t');
			const [first, second] = [...new Set(rows.filter((r) => r.role === 'assistant').map((r) => r.id))];
			const of = (id: string | undefined) => rows.filter((r) => r.id === id);
			// one row per reply: streamed flushes, then the final write in place, text only ever growing
			expect(of(first).at(-1)).toMatchObject({ state: null, text: 'Let me check.', reasoning: 'Looking ' });
			expect(of(second).at(-1)).toMatchObject({ state: null, text: 'All done.', tag: 'reply' });
			for (const id of [first, second]) {
				const texts = of(id).map((r) => r.text ?? '');
				expect(texts.every((x, i) => i === 0 || x.startsWith(texts[i - 1]!))).toBe(true);
				// the cadence bounds the writes: at most one per delta, never one per token
				expect(of(id).filter((r) => r.state === 'streaming').length).toBeLessThanOrEqual(3);
			}
			// the tool call: a running row, then that row finished with its duration
			const tool = rows.filter((r) => r.role === 'tool');
			expect(new Set(tool.map((r) => r.id)).size).toBe(1);
			expect(tool[0]!.tool).toMatchObject({ name: 'history', running: true });
			expect(tool.at(-1)!.tool?.running).toBeUndefined();
			expect(typeof tool.at(-1)!.tool?.ms).toBe('number');
			// the list: this conversation ran, then settled
			const statuses = s.upserts<AgentConversation>('l').filter((r) => r.id === s.c).map((r) => r.status);
			expect(statuses).toContain('running');
			expect(statuses.at(-1)).toBe('idle');
			// exact routing: each view was answered once and then only patched (no re-read, no second stream)
			expect(s.frames.filter((f) => f.t === 'answer').map((f) => (f as { view: string }).view).sort()).toEqual(['l', 't']);
			expect(s.frames.some((f) => f.t === 'error')).toBe(false);
		} finally { s.close(); }
	});

	it('a stop mid-reply keeps what was written, finished as interrupted, and the list reads stopped', async () => {
		let s!: Awaited<ReturnType<typeof setup>>;
		s = await setup((_req, signal, onDelta) => new Promise<AiResponse>((_, reject) => {
			onDelta?.('Half ');
			signal.addEventListener('abort', () => reject(new Error('aborted')));
		}));
		try {
			await s.api.agent.post(s.c, 'go', true);
			await until(() => s.upserts<AgentRow>('t').some((r) => r.state === 'streaming' && r.text === 'Half '));
			await s.api.agent.stop(s.c);
			await s.settled();
			const reply = s.upserts<AgentRow>('t').filter((r) => r.role === 'assistant').at(-1)!;
			expect(reply).toMatchObject({ state: null, tag: 'cut', text: 'Half ' });
			expect(s.upserts<AgentConversation>('l').filter((r) => r.id === s.c).at(-1)?.status).toBe('stopped');
		} finally { s.close(); }
	});

	it('the old progress stream and the polled conversation list are gone', async () => {
		const s = await setup(async () => ({ content: 'Hi.', toolCalls: [], finish: 'stop', usage }));
		try {
			expect((await s.fetch(`/__bolt/agent/stream?conversation=${s.c}`)).status).toBe(404);
			expect((await s.fetch('/__bolt/agent/conversations')).status).toBe(404);
			// the models the selector offers are a plain one-shot read
			const models = await s.api.agent.models();
			expect(models.ok && models.value.default).toBe('default');
		} finally { s.close(); }
	});
});
