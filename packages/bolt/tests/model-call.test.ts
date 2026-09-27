// modelCall's wall (rule 63): a stream cut while writing a tool call is its own failure, never "yielded nothing"
import { describe, expect, it } from 'vitest';
import { modelCall } from '../src/engine/agent/ai.ts';
import type { AiPort } from '../src/engine/contracts.ts';

const port = (behave: (onDelta?: (t: string) => void, onProgress?: () => void) => void): AiPort => ({
	sys_1: { ask: async () => { throw new Error('unused'); } },
	sys_2: { models: ['default'], infer: ((_r, signal, onDelta, onProgress) => new Promise((_resolve, reject) => {
		behave(onDelta, onProgress);
		signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
	})) as AiPort['sys_2']['infer'] },
} as unknown as AiPort);
const request = { model: 'default', system: '', messages: [] } as unknown as Parameters<typeof modelCall>[1];

describe('modelCall at its wall', () => {
	it('text so far: a cut step', async () => {
		expect(await modelCall(port((d) => d?.('partial')), request, { wallMs: 20 })).toMatchObject({ finish: 'cut', content: 'partial' });
	});
	it('only a tool call in progress: cutTool', async () => {
		expect(await modelCall(port((_d, p) => p?.()), request, { wallMs: 20 })).toMatchObject({ kind: 'timeout', cutTool: true });
	});
	it('nothing at all: yielded nothing', async () => {
		const r = await modelCall(port(() => {}), request, { wallMs: 20 });
		expect(r).toMatchObject({ kind: 'timeout' });
		expect((r as { cutTool?: boolean }).cutTool).toBeUndefined();
	});
});
