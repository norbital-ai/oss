import { describe, expect, it } from 'vitest';
import { exportTranscript } from '../src/client/ui/agent/export-transcript.js';
import {
	projectAgentUsage,
	projectConversationMessages
} from '../src/client/ui/agent/transcript.js';

const conversation = '00000000-0000-4000-8000-000000000e01';
const turn = '00000000-0000-4000-8000-000000000e02';
const row = (sequence: number, author: string, message: unknown) => ({
	id: `00000000-0000-4000-8000-00000000${String(sequence).padStart(4, '0')}`,
	conversation_id: conversation,
	sequence,
	turn_id: turn,
	author: { kind: author },
	message,
	annotation: null
});

describe('/export renders the transcript and its cost for the person tuning the agent', () => {
	it('lists model calls, tool counts, then every message in order', () => {
		const messages = projectConversationMessages([
			row(2, 'agent', {
				role: 'assistant',
				content: [
					{ type: 'reasoning', text: 'Look first.' },
					{ type: 'tool-call', id: 'c1', name: 'read_collection', params: { collection: 'people' } }
				]
			}),
			row(1, 'human', { role: 'user', content: 'Who is on leave?' }),
			row(3, 'tool', {
				role: 'tool',
				content: [
					{
						type: 'tool-result',
						id: 'c1',
						name: 'read_collection',
						result: { rows: [] },
						isFailure: false
					}
				]
			})
		]);
		const usage = projectAgentUsage([
			{
				call_id: 'call:1',
				turn_id: turn,
				provider: 'openrouter',
				model: 'deepseek/deepseek-v4.1-flash',
				operation: 'language',
				usage: {
					inputTokens: { total: 1000, uncached: 200, cacheRead: 800, cacheWrite: 0 },
					outputTokens: { total: 50, text: 40, reasoning: 10 }
				},
				charge: null,
				charge_source: null,
				pricing_version: null,
				settlement_id: 's1',
				settlement_state: 'settled'
			}
		]);
		const markdown = exportTranscript(conversation, messages, usage);
		expect(markdown).toContain('Model calls: **1** · input 1000 tokens (80% cached) · output 50');
		expect(markdown).toContain('Tool calls: read_collection ×1');
		const order = [
			'## 1 · user',
			'## 2 · assistant',
			'→ **read_collection**',
			'## 3 · tool',
			'← **read_collection**'
		].map((needle) => markdown.indexOf(needle));
		expect(order.every((at, index) => at >= 0 && (index === 0 || at > order[index - 1]!))).toBe(
			true
		);
		expect(markdown).toContain('> *reasoning:* Look first.');
	});
});

describe('a checkpoint table reads as headed sections', () => {
	it('turns the Section | Summary rows into headings and leaves other text alone', async () => {
		const { checkpointSections } = await import('../src/client/ui/agent/context-view.js');
		const table =
			'| Section | Summary |\n| --- | --- |\n| Goal | Ship it \\| soon |\n| Progress | None yet |';
		expect(checkpointSections(table)).toBe(
			'#### Goal\n\nShip it | soon\n\n#### Progress\n\nNone yet'
		);
		expect(checkpointSections('Plain checkpoint text.')).toBe('Plain checkpoint text.');
	});
});
