// The test kit's provider cassette (L-BOLT-1015): `testWorkspace({ fakes: { ai: { cassette } } })` replays recorded
// responses per model class through the real agent loop; an unmapped class is Unavailable, a malformed recording fails
// the kit, a class played past its end throws. And the cassette latency budget (L-BOLT-434): with an instant provider
// the send reaches the provider, and the first part streams, within 100 ms at p95 over ten turns.
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { AiResponse, EngineManifest } from '../src/engine/contracts.ts';
import { respondSystem1, testWorkspace } from '../src/test/index.ts';

const manifest = {
	workspace: { tz: 'UTC', locale: 'en', agent: { triage: false }, ai: { models: ['default', 'fast'], default: 'default' } },
	models: {}, relationships: {}, collections: {}, policies: {},
	agent: { internal: 'Staff brief.', skills: {} },
	integrations: {}, pipelines: {}, teams: {}, automations: {}, channels: {}, connections: {}, envoys: {}, mcp: {}, apps: {}, customFields: {},
} as unknown as EngineManifest;
const reply = (content: string): AiResponse => ({ content, toolCalls: [], finish: 'stop', usage: { input: 10, output: 5 } });
const scratch = join(tmpdir(), 'norbital-scratch', `cassette-${randomUUID()}`);
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const member = (id: string) => ({ text: `INSERT INTO sys_user (id, email, name, admin) VALUES ($1, $2, $1, true)`, params: [id, `${id}@x.test`] });

describe('Fakes.ai.cassette', () => {
	it('replays a recorded file through the loop, in order, and reports what it played', async () => {
		mkdirSync(scratch, { recursive: true });
		const file = join(scratch, 'two.json');
		writeFileSync(file, JSON.stringify({ meta: { recordedAt: '2026-09-26' }, turns: [reply('First.'), reply('Second.')] }));
		const t = await testWorkspace({ manifest, fakes: { ai: { cassette: { default: file } } } });
		await t.db.write(member('ann'));
		const c = await t.engine.agents.start({ owner: 'ann' });
		await t.engine.agents.post({ conversation: c, as: { member: 'ann' }, text: 'one' });
		expect((await t.engine.agents.drain(c)).reply?.text).toBe('First.');
		await t.engine.agents.post({ conversation: c, as: { member: 'ann' }, text: 'two' });
		expect((await t.engine.agents.drain(c)).reply?.text).toBe('Second.');
		expect(t.fakes.ai?.requests.map((r) => r.model)).toEqual(['default', 'default']);
		expect(t.fakes.ai?.remaining()).toEqual({ default: 0 });
	});

	it('a class the cassette does not name is Unavailable at call time, not an activation failure', async () => {
		const t = await testWorkspace({ manifest, fakes: { ai: { cassette: { default: [reply('never')] } } } });
		await t.db.write(member('ann'));
		const c = await t.engine.agents.start({ owner: 'ann', model: 'fast' });
		await t.engine.agents.post({ conversation: c, as: { member: 'ann' }, text: 'hi' });
		await t.engine.agents.drain(c);
		const [row] = (await t.db.read([{ text: `SELECT attributes FROM sys_event WHERE event = 'agent.failed' AND conversation = $1`, params: [c] }]))[0]!.rows;
		expect(row!['attributes']).toMatchObject({ code: 'unavailable', message: "no model is mapped to the class 'fast'" });
		expect(t.fakes.ai?.requests).toEqual([]);
	});

	it('a malformed recording fails the kit; `ai` and `fakes.ai` together are refused', async () => {
		await expect(testWorkspace({ manifest, fakes: { ai: { cassette: { default: [{ content: 'x', finish: 'done' } as unknown as AiResponse] } } } }))
			.rejects.toThrow(/'default' turn 0 is not an AiResponse/);
		await expect(testWorkspace({ manifest, ai: { sys_1: respondSystem1, sys_2: { models: [], infer: async () => reply('') } }, fakes: { ai: { cassette: {} } } }))
			.rejects.toThrow(/not both/);
	});
});

describe('cassette latency (L-BOLT-434)', () => {
	const percentile = (xs: readonly number[], q: number) => xs.toSorted((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil(q * xs.length) - 1)]!;
	it('send → provider and send → first streamed part stay under 100 ms at p95 over ten turns', async () => {
		const TURNS = 10;
		let firstPart = 0;
		const t = await testWorkspace({ manifest, fakes: { ai: { cassette: { default: Array.from({ length: TURNS }, (_, i) => reply(`Reply ${i}.`)) } } } });
		// the first part the panel sees: the first reply row the turn publishes to the live lane
		const publish = t.engine.live.publish;
		t.engine.live.publish = (c) => { if (firstPart === 0 && c.some((x) => x.collection === 'sys_message' && x.new?.['role'] === 'assistant')) firstPart = performance.now(); return publish(c); };
		await t.db.write(member('ann'));
		const c = await t.engine.agents.start({ owner: 'ann' });
		const toProvider: number[] = [], toFirstPart: number[] = [];
		for (let i = 0; i < TURNS; i++) {
			firstPart = 0;
			const before = t.fakes.ai!.requests.length;
			const sent = performance.now();
			let settled = false;
			const turn = t.engine.agents.post({ conversation: c, as: { member: 'ann' }, text: `turn ${i}` }).then(() => t.engine.agents.drain(c)).finally(() => { settled = true; });
			while (t.fakes.ai!.requests.length === before && !settled) await new Promise((r) => setImmediate(r));
			const asked = performance.now();
			await turn;
			toProvider.push(asked - sent);
			toFirstPart.push(firstPart - sent);
		}
		expect(t.fakes.ai!.remaining()).toEqual({ default: 0 });
		expect(percentile(toProvider, 0.95)).toBeLessThan(100);
		expect(percentile(toFirstPart, 0.95)).toBeLessThan(100);
	});
});
