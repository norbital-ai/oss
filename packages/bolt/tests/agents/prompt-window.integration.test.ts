import { Effect } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import type { AIRequest, AIResponse, FacilityBinding } from '@norbital-ai/bolt-protocol';
import * as Agents from '../../src/runtime/agents/agents.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	type BoltTestRuntime
} from '../support/bolt-test-layer.js';

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

describe('agent prompt window', () => {
	it('reads only the newest 64 rows, clears old huge tool output, and protects three recent turns', async () => {
		const requests: Array<AIRequest> = [];
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: async (_metadata, request) => {
				requests.push(request);
				return { _tag: 'Success', value: { output: { text: 'done' } } };
			}
		};
		harness = await makeBoltTestRuntime(undefined, { ai });
		const agents = await harness.runtime.runPromise(Agents.Service);
		await harness.runtime.runPromise(
			agents.open(harness.effectId('open'), adminSubject, 'web', 'prompt-window')
		);
		const hugeOld = `OLD:${'a'.repeat(50_100)}`;
		const hugeRecent = `RECENT:${'z'.repeat(50_100)}`;
		for (let index = 0; index < 70; index += 1) {
			const output = index === 6 ? hugeOld : index === 69 ? hugeRecent : `tool-output-${index}`;
			await harness.database.query(
				`insert into chat_message (conversation_id, role, content)
				 values ($1, 'assistant', $2::jsonb)`,
				[
					'prompt-window',
					JSON.stringify({
						id: `turn-${index}`,
						status: 'completed',
						parts: [
							{
								kind: 'tool-result',
								id: `call-${index}`,
								name: 'read_collection',
								output
							}
						],
						subject: adminSubject
					})
				]
			);
		}
		const admitted = await harness.runtime.runPromise(
			agents.enqueue(
				harness.effectId('enqueue'),
				adminSubject,
				'web',
				'prompt-window',
				'turn-latest',
				{
					kind: 'user_message',
					text: 'continue'
				}
			)
		);
		await harness.runtime.runPromise(
			agents.execute(harness.effectId('execute'), 'prompt-window', admitted.turnId)
		);
		const request = requests[0];
		if (request?._tag !== 'Turn') throw new Error('expected a turn');
		const encoded = JSON.stringify(request.messages);
		expect(request.messages.length).toBeLessThanOrEqual(66);
		// The oldest rows are outside the bounded read entirely; no second placeholder row is needed.
		expect(encoded).not.toContain(hugeOld);
		// The latest assistant turn is one of the protected three and remains exact.
		expect(encoded).toContain(hugeRecent);
	});
});
