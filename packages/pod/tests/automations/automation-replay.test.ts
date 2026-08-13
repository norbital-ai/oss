import { describe, expect, it } from 'vitest';
import {
	automationEffectRequestHash,
	automationReplayStorage,
	isAutomationEffectYield,
	replayAutomationAi
} from '../../src/server/run/automation-replay.server.js';
import type { DurableHostEffectRequest } from '../../src/host/types.js';
import { z } from 'zod';

const request: DurableHostEffectRequest = {
	kind: 'ai.prompt',
	prompt: 'Classify this record',
	model: 'test/model',
	outputSchema: { type: 'object' }
};

const turnRequest: DurableHostEffectRequest = {
	kind: 'ai.turn',
	messages: [{ role: 'user', content: 'Classify this record' }],
	model: 'test/model'
};

describe('durable automation replay', () => {
	it('canonicalizes request keys into one stable effect hash', () => {
		expect(automationEffectRequestHash(request)).toBe(
			automationEffectRequestHash({
				outputSchema: { type: 'object' },
				kind: 'ai.prompt',
				model: 'test/model',
				prompt: 'Classify this record'
			})
		);
	});

	it('hashes ai.prompt and ai.turn requests differently', () => {
		expect(automationEffectRequestHash(request)).not.toBe(automationEffectRequestHash(turnRequest));
	});

	it('yields the first missing effect with a stable run and ordinal identity', async () => {
		await automationReplayStorage.run({ jobId: 'job-1', effects: [], nextOrdinal: 0 }, async () => {
			try {
				replayAutomationAi({ request });
				expect.unreachable();
			} catch (cause) {
				expect(isAutomationEffectYield(cause)).toBe(true);
				if (!isAutomationEffectYield(cause)) return;
				expect(cause.ordinal).toBe(0);
				expect(cause.effectId).toContain('job-1:0:');
			}
		});
	});

	it('replays structured success and advances the next ordinal', async () => {
		await automationReplayStorage.run(
			{
				jobId: 'job-2',
				nextOrdinal: 0,
				effects: [
					{
						ordinal: 0,
						requestHash: automationEffectRequestHash(request),
						status: 'succeeded',
						result: { text: '{"kind":"match"}', stopReason: 'end' }
					}
				]
			},
			async () => {
				expect(
					replayAutomationAi({ request, schema: z.object({ kind: z.literal('match') }) })
				).toEqual({ kind: 'match' });
				expect(() => replayAutomationAi({ request })).toThrowError(
					/waiting for a durable AI effect/
				);
			}
		);
	});

	it('replays provider failure as a catchable authored error', async () => {
		await automationReplayStorage.run(
			{
				jobId: 'job-3',
				nextOrdinal: 0,
				effects: [
					{
						ordinal: 0,
						requestHash: automationEffectRequestHash(request),
						status: 'failed',
						error: 'provider unavailable'
					}
				]
			},
			async () => expect(() => replayAutomationAi({ request })).toThrowError('provider unavailable')
		);
	});

	it('refuses request drift at an already-settled ordinal', async () => {
		await automationReplayStorage.run(
			{
				jobId: 'job-4',
				nextOrdinal: 0,
				effects: [
					{
						ordinal: 0,
						requestHash: automationEffectRequestHash(request),
						status: 'succeeded',
						result: { text: 'ok', stopReason: 'end' }
					}
				]
			},
			async () =>
				expect(() =>
					replayAutomationAi({
						request: { ...request, prompt: 'Changed prompt' }
					})
				).toThrowError(/request changed/)
		);
	});
});
