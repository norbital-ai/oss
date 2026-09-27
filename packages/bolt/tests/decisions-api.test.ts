// `decisionsSystem1` (P35, P37) against a fake fetch standing in for OpenRouter's Decisions API: the port's request goes
// out as `{ model, state, questions }` field for field (a text-only state), the answers come back as given with a
// score's `level` added and `usage.cost` as `costUsd`; a context refusal is `tooLarge`; a slow, failing or malformed
// answer rejects (the client never falls back).
import { describe, expect, it } from 'vitest';
import { decisionsSystem1, type System1Request } from '../src/engine/decisions/index.ts';

type Mode = 'ok' | 'slow' | 'down' | 'context' | 'malformed';
const answerBody = (mode: Mode) => ({
	provider: 'typesafe',
	answers: {
		action: { type: 'choice', choice: 'wait', confidence: 0.92, probabilities: { respond: 0.05, wait: 0.92, ignore: 0.03 } },
		wait: mode === 'malformed' ? { type: 'score' } : { type: 'score', score: 1.99, confidence: 0.8, probabilities: { 0: 0.1, 1: 0.1, 2: 0.8 }, legend: { 0: '0 s', 1: '1 s', 2: '2 s' } },
		sorted: { type: 'noul', noul: 0.7 },
	},
	usage: { input_tokens: 120, output_tokens: 0, cost: 0.00004 },
});
const fake = (mode: Mode) => {
	const seen: { url: string; headers: Record<string, string>; body: unknown }[] = [];
	const transport = (async (url: string, init: RequestInit) => {
		seen.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
		if (mode === 'down') return new Response('boom', { status: 500 });
		if (mode === 'context') return new Response('{"error":{"message":"maximum context length is 32768 tokens"}}', { status: 400 });
		if (mode === 'slow') await new Promise((resolve, reject) => {
			const t = setTimeout(resolve, 400);
			init.signal?.addEventListener('abort', () => { clearTimeout(t); reject(init.signal!.reason); });
		});
		return Response.json(answerBody(mode));
	}) as typeof fetch;
	return { seen, transport };
};

const request: System1Request = {
	state: { pending: [{ from: 'Ann', text: 'the pump at Kismis', attachments: [{ name: 'p.png', mime: 'image/png', size: 2 }] }] },
	questions: {
		action: { type: 'choice', instructions: 'What now?', criteria: { respond: 'answer now', wait: 'more is coming', ignore: 'not for us' } },
		wait: { type: 'score', instructions: 'Seconds?', criteria: ['0 s', '1 s', '2 s'] },
		sorted: { type: 'noul', instructions: 'Does it ask for an order?', criteria: { true: 'it does', false: 'it does not' } },
	},
};
const ask = (transport: typeof fetch) => decisionsSystem1({ url: 'https://decisions.test/api/alpha/decisions', model: 'vendor/model', apiKey: 'k', timeoutMillis: 150 }, transport)
	.ask(request, new AbortController().signal);

describe('the Decisions API sys_1 client', () => {
	it('sends { model, state, questions } field for field and maps the answers back, a score gaining its level', async () => {
		const { seen, transport } = fake('ok');
		expect(await ask(transport)).toEqual({
			answers: {
				action: { type: 'choice', choice: 'wait', confidence: 0.92, probabilities: { respond: 0.05, wait: 0.92, ignore: 0.03 } },
				wait: { type: 'score', score: 1.99, level: 2, confidence: 0.8, probabilities: { 0: 0.1, 1: 0.1, 2: 0.8 }, legend: { 0: '0 s', 1: '1 s', 2: '2 s' } },
				sorted: { type: 'noul', noul: 0.7 },
			},
			costUsd: 0.00004, provider: 'typesafe', tokens: { input: 120, output: 0 },
		});
		expect(seen).toEqual([{ url: 'https://decisions.test/api/alpha/decisions', headers: { authorization: 'Bearer k', 'content-type': 'application/json' },
			body: { model: 'vendor/model', questions: request.questions, state: request.state } }]);
	});

	it('names the model as the provider when the answer names none', async () => {
		const { provider: _, ...rest } = answerBody('ok');
		const r = await decisionsSystem1({ url: 'u', model: 'vendor/model', apiKey: 'k' }, (async () => Response.json(rest)) as typeof fetch).ask(request, new AbortController().signal);
		expect(r.provider).toBe('vendor/model');
	});

	it('a context-limit refusal is tooLarge', async () => {
		await expect(ask(fake('context').transport)).rejects.toMatchObject({ kind: 'tooLarge' });
	});

	it('rejects on a timeout, an HTTP error and a malformed answer; it never falls back', async () => {
		for (const m of ['slow', 'down', 'malformed'] as const) {
			const { seen, transport } = fake(m);
			await expect(ask(transport)).rejects.toThrow();
			expect(seen).toHaveLength(1);
		}
	});
});
