// The live provider probe (L-BOLT-435): one small streamed turn through the real `openAiChat` adapter against the
// operator's provider. Skipped unless BOLT_AI_SYS_2_ENDPOINT, BOLT_AI_SYS_2_CREDENTIAL and BOLT_AI_LIVE_MODEL (a
// provider model id) are set; it costs one tiny call. Cassettes (`fakes.ai.cassette`) cover the loop offline.
import { expect, it } from 'vitest';
import { openAiChat } from '../src/engine/agent/openai-chat.ts';

const endpoint = process.env['BOLT_AI_SYS_2_ENDPOINT'], credential = process.env['BOLT_AI_SYS_2_CREDENTIAL'], model = process.env['BOLT_AI_LIVE_MODEL'];

it.skipIf(!endpoint || !credential || !model)('a live provider streams a short answer with its usage', async () => {
	const infer = openAiChat({ endpoint: endpoint!, credential, models: { default: model! } });
	const deltas: string[] = [];
	const r = await infer({ model: 'default', system: 'Answer with one word.', messages: [{ role: 'user', content: 'Reply with the word pong.' }] },
		AbortSignal.timeout(60_000), (d) => deltas.push(d));
	expect(String(r.content).toLowerCase()).toContain('pong');
	expect(deltas.join('')).toBe(r.content);
	expect(r.finish).toBe('stop');
	expect(r.usage.input).toBeGreaterThan(0);
}, 90_000);
