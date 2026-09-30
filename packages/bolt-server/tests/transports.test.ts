// bolt-server's self-host adapters (rules 38a, 71, §5.11.4, §5.11.6): the configuration decode, sealed secrets, the
// timekeeper, and the FIFO envelope. The channel providers are `@norbital-ai/providers`' tests; the routes are `channels.test.ts`.
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Rows, Sql, TenantDb } from '../../bolt/src/engine/contracts.ts';
import { sealedSecrets } from '../../bolt/src/engine/secrets.ts';
import { ConfigError, decodeConfig } from '../src/config.ts';
import { openAi, timekeeper } from '../src/ports.ts';
import { envelope } from '../src/server.ts';

const scratch = join(tmpdir(), 'norbital-scratch', `bolt-server-transports-${process.pid}`);
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const tick = () => new Promise((r) => setTimeout(r, 5));

describe('bolt start configuration (§5.11.6)', () => {
	const base = { BOLT_ARTIFACT: '/a', BOLT_PUBLIC_URL: 'https://acme.example', BOLT_PGLITE_DIR: '/db' };
	it('decodes the defaults and the flags', () => {
		const c = decodeConfig(base, ['--accept', '--trust-proxy=10.0.0.0/8,::1', '--founder=a@b.example', '--seed=./pack']);
		expect(c).toMatchObject({ host: '127.0.0.1', port: 3100, database: { pglite: '/db' }, publicUrl: 'https://acme.example', files: null, transactional: null,
			accept: true, trustProxy: ['10.0.0.0/8', '::1'], founder: 'a@b.example', seed: './pack', telemetryRetainHours: 72, environment: null });
		expect(decodeConfig({ ...base, BOLT_ENVIRONMENT: 'staging' }).environment).toBe('staging');
	});
	it.each([
		[{ ...base, BOLT_SERVER_PORT: '1' }, /unknown configuration: BOLT_SERVER_PORT/],
		[{ ...base, BOLT_DATABASE_URL: 'postgres://x' }, /exactly one/],
		[{ BOLT_ARTIFACT: '/a', BOLT_PUBLIC_URL: 'https://acme.example' }, /exactly one/],
		[{ ...base, BOLT_PUBLIC_URL: 'http://acme.example' }, /https/],
		[{ ...base, BOLT_PUBLIC_URL: 'https://acme.example/app' }, /no path/],
		[{ ...base, BOLT_MASTER_KEY: 'short' }, /32-byte/],
		[{ ...base, BOLT_AI_SYS_2_PROVIDER: 'anthropic' }, /not registered/],
		[{ ...base, BOLT_FILES_PROVIDER: 'local' }, /BOLT_FILES_ENDPOINT/],
		[{ BOLT_PUBLIC_URL: 'https://acme.example', BOLT_PGLITE_DIR: '/db' }, /BOLT_ARTIFACT/],
	])('refuses to start: %o', (env, message) => {
		expect(() => decodeConfig(env)).toThrow(ConfigError);
		expect(() => decodeConfig(env)).toThrow(message);
	});
	it('accepts a loopback http origin and refuses a bad flag', () => {
		expect(decodeConfig({ ...base, BOLT_PUBLIC_URL: 'http://app.localhost:5173' }).publicUrl).toBe('http://app.localhost:5173');
		expect(() => decodeConfig(base, ['--trust-proxy=nope'])).toThrow(/CIDR/);
		expect(() => decodeConfig(base, ['--port=1'])).toThrow(/flag/);
	});
});

/** `sys_config` as a map, read by the statements' parameters: a `%`-suffixed key is a prefix scan, a pair is an upsert, a lone key a delete. */
function configDb(rows: Map<string, string>): TenantDb {
	const out = (r: Rows['rows']): Rows => ({ rows: r, affected: r.length });
	return {
		read: async (statements: readonly Sql[]) => statements.map(({ params: [k] }) => {
			const key = String(k);
			if (!key.endsWith('%')) return out(rows.has(key) ? [{ value: rows.get(key)! }] : []);
			return out([...rows].filter(([x]) => x.startsWith(key.slice(0, -1))).map(([x, value]) => ({ key: x, value })));
		}),
		write: async ({ params: [k, v] }: Sql) => { if (v === undefined) rows.delete(String(k)); else rows.set(String(k), String(v)); return out([]); },
		transaction: () => { throw new Error('secrets take no transaction'); },
	};
}

describe('sealed secrets (§5.11.4)', () => {
	it('stores envelopes a copied row cannot open, answers status without a key, refuses undeclared names', async () => {
		const rows = new Map<string, string>(), db = configDb(rows);
		const key = Buffer.alloc(32, 7);
		const s = sealedSecrets(db, key, { ERP_TOKEN: {}, BASE: { secret: false, default: 'https://erp.example' } });
		await s.set('workspace', 'ERP_TOKEN', 'tok');
		await s.set('user-1', 'google', 'refresh');
		expect(await s.use('workspace', 'ERP_TOKEN')).toBe('tok');
		expect(s.env('ERP_TOKEN')).toBe('tok');
		expect(s.env('BASE')).toBe('https://erp.example');
		await expect(s.set('workspace', 'OTHER', 'x')).rejects.toThrow(/declared/);
		// the user's envelope under another owner fails to open
		rows.set('secret:user-2:google', rows.get('secret:user-1:google')!);
		expect(await s.use('user-2', 'google')).toBeNull();
		expect(rows.get('secret:workspace:ERP_TOKEN')).not.toContain('tok');
		const keyless = sealedSecrets(db, null, { ERP_TOKEN: {}, BASE: { secret: false } });
		expect(await keyless.status('workspace')).toEqual({ ERP_TOKEN: true, BASE: false });
		await expect(keyless.set('workspace', 'ERP_TOKEN', 'x')).rejects.toThrow(/BOLT_MASTER_KEY/);
	});
});

describe('the in-process timekeeper and the envelope (rules 52a, 71)', () => {
	it('wakes a scope once at its earliest announcement and takes the settled answer', async () => {
		vi.useFakeTimers();
		const woke: string[] = [];
		let dk: ReturnType<typeof timekeeper> | undefined;
		dk = timekeeper(async (scope) => { woke.push(scope); if (woke.length === 1) dk!.settle(scope, new Date(Date.now() + 20).toISOString()); });
		dk.announce('ws', new Date(Date.now() + 40).toISOString());
		dk.announce('ws', new Date(Date.now() + 10).toISOString());
		dk.announce('ws', new Date(Date.now() + 60).toISOString()); // later: ignored
		await vi.advanceTimersByTimeAsync(9);
		expect(woke).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);
		expect(woke).toEqual(['ws']);
		await vi.advanceTimersByTimeAsync(20);
		expect(woke).toEqual(['ws', 'ws']);
		await vi.advanceTimersByTimeAsync(1_000); // the 40 and 60 announcements merged into the first wake: nothing is left
		expect(woke).toEqual(['ws', 'ws']);
		dk.stop();
		vi.useRealTimers();
	});
	it('stays silent about a wake that a stop interrupted, and never wakes again (rule 71a)', async () => {
		const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
		let calls = 0;
		const dk = timekeeper(async () => { calls++; dk.stop(); throw new Error('PGlite is closing'); });
		dk.announce('ws', new Date().toISOString());
		await vi.waitFor(() => expect(calls).toBe(1));
		expect(errors).not.toHaveBeenCalled();
		errors.mockRestore();
	});
	it('admits FIFO under the limit, request-path work ahead of automations', async () => {
		const admit = envelope(1);
		const order: string[] = [];
		let release!: () => void;
		const first = admit(0, () => new Promise<void>((r) => { order.push('a'); release = r; }));
		const automation = admit(1, async () => { order.push('automation'); });
		const request = admit(0, async () => { order.push('request'); });
		await tick();
		expect(order).toEqual(['a']);
		release();
		await Promise.all([first, automation, request]);
		expect(order).toEqual(['a', 'request', 'automation']);
	});
	it('drains within its grace: admission closes, waiters are shed, a never-settling call cannot hold it (rule 71a)', async () => {
		const admit = envelope(1);
		void admit(1, () => new Promise<void>(() => {}));
		const shed = expect(admit(0, async () => 'late')).rejects.toMatchObject({ code: 'busy' });
		const started = Date.now();
		expect(await admit.drain(50)).toBe(false);
		expect(Date.now() - started).toBeLessThan(500);
		await shed;
		await expect(admit(0, async () => 'new')).rejects.toMatchObject({ code: 'busy' });
		expect(await envelope(1).drain(10_000)).toBe(true);
	});
});

describe('the OpenAI-compatible model port (P19)', () => {
	it('maps the declared classes to the operator\'s models on the sys_2 endpoint (the client itself: bolt tests/openai-chat.test.ts)', async () => {
		let url = '', sent: { model: string } | undefined;
		const f = (async (u: string | URL, init?: RequestInit) => {
			url = String(u);
			sent = JSON.parse(String(init?.body)) as typeof sent;
			return Response.json({ choices: [{ message: { content: 'ok' } }] });
		}) as typeof fetch;
		const ai = openAi({ sys1: { endpoint: 'https://s1.test/v1' }, sys2: { endpoint: 'https://llm.test/v1', credential: 'k' } },
			{ sys1: 'tiny', sys2: { default: 'gpt-x', fast: 'gpt-y' }, embed: {}, modalities: { sys2: null, embed: null } }, ['default', 'fast', 'strong'], f);
		expect(ai.sys_2.models).toEqual(['default', 'fast']);
		expect((await ai.sys_2.infer({ model: 'fast', messages: [{ role: 'user', content: 'hi' }] }, AbortSignal.timeout(1000))).content).toBe('ok');
		expect([url, sent!.model]).toEqual(['https://llm.test/v1/chat/completions', 'gpt-y']);
	});
	it('sys_1 asks the operator\'s model on its own endpoint in P37 shapes: a text-only state, a distribution decoded, a context refusal TooLarge', async () => {
		let url = '', sent: { model: string; response_format?: unknown; messages: { content: unknown }[] } | undefined, status = 200;
		const f = (async (u: string | URL, init?: RequestInit) => {
			url = String(u);
			sent = JSON.parse(String(init?.body)) as typeof sent;
			if (status !== 200) return new Response('{"error":{"message":"This model\'s maximum context length is 32768 tokens"}}', { status });
			return Response.json({ choices: [{ message: { content: '{"action":{"probabilities":{"respond":0.2,"wait":0.8}},"wait":{"probabilities":{"0":0.1,"1":0.2,"2":0.7}},"sure":{"noul":0.9}}' } }],
				usage: { prompt_tokens: 5, completion_tokens: 1, cost: 0.0001 } });
		}) as typeof fetch;
		const ai = openAi({ sys1: { endpoint: 'https://s1.test/v1', credential: 's' }, sys2: { endpoint: 'https://llm.test/v1' } },
			{ sys1: 'tiny', sys2: { default: 'gpt-x' }, embed: {}, modalities: { sys2: null, embed: null } }, ['default'], f);
		const request = { state: { text: 'see photo', photo: { name: 'p.png', mime: 'image/png', size: 2 } },
			questions: { action: { type: 'choice', instructions: 'p', criteria: { respond: 'now', wait: 'later' } },
				wait: { type: 'score', instructions: 's', criteria: ['0 s', '1 s', '2 s'] }, sure: { type: 'noul', instructions: 'n', criteria: { true: 'y', false: 'n' } } } } as const;
		const d = await ai.sys_1.ask(request, AbortSignal.timeout(1000));
		expect([url, sent!.model]).toEqual(['https://s1.test/v1/chat/completions', 'tiny']);
		expect(sent!.response_format).toMatchObject({ type: 'json_schema' });
		expect(sent!.messages.at(-1)!.content).toEqual(expect.stringContaining('"photo":{"name":"p.png","mime":"image/png","size":2}'));
		expect(d).toMatchObject({ costUsd: 0.0001, answers: { action: { type: 'choice', choice: 'wait', confidence: 0.8 }, sure: { type: 'noul', noul: 0.9 },
			wait: { type: 'score', level: 2, legend: { 2: '2 s' } } } });
		expect((d.answers['wait'] as { score: number }).score).toBeCloseTo(1.6);
		status = 400;
		await expect(ai.sys_1.ask(request, AbortSignal.timeout(1000))).rejects.toMatchObject({ kind: 'tooLarge' });
	});
	it('sys_1 on provider decisions posts { model, state, questions } to the Decisions API URL as given', async () => {
		let url = '', sent: unknown;
		const f = (async (u: string | URL, init?: RequestInit) => {
			url = String(u);
			sent = JSON.parse(String(init?.body));
			return Response.json({ answers: { sure: { type: 'noul', noul: 0.9 } }, usage: { cost: 0.00002 } });
		}) as typeof fetch;
		const ai = openAi({ sys1: { provider: 'decisions', endpoint: 'https://d.test/api/alpha/decisions', credential: 's' }, sys2: { endpoint: 'https://llm.test/v1' } },
			{ sys1: 'vendor/jev', sys2: { default: 'gpt-x' }, embed: {}, modalities: { sys2: null, embed: null } }, ['default'], f);
		const request = { state: { text: 'hi' }, questions: { sure: { type: 'noul', instructions: 'n', criteria: { true: 'y', false: 'n' } } } } as const;
		expect(await ai.sys_1.ask(request, AbortSignal.timeout(1000))).toMatchObject({ costUsd: 0.00002, answers: { sure: { type: 'noul', noul: 0.9 } } });
		expect([url, sent]).toEqual(['https://d.test/api/alpha/decisions', { model: 'vendor/jev', state: request.state, questions: request.questions }]);
	});
});
