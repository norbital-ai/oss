import { describe, expect, it } from 'vitest';
import { projectConversationMessages } from '../src/client/ui/agent/transcript.js';
import { canonicalAgentRows } from './ui-canonical-agent-fixture.js';

const conversationId = '00000000-0000-4000-8000-000000000101';
const runId = '00000000-0000-4000-8000-000000000102';

describe('parent-agent messages in a Task transcript', () => {
	it('preserves parent-agent authorship without rewriting the Effect message', () => {
		const [message] = projectConversationMessages(
			canonicalAgentRows([
				{
					conversationId,
					runId,
					author: { kind: 'parent-agent', id: 'migration-coordinator' },
					message: {
						role: 'user',
						content: 'Four errors remain in the migration boundary.'
					}
				}
			])
		);

		expect(message).toMatchObject({
			kind: 'message',
			conversationId,
			runId,
			author: { kind: 'parent-agent', id: 'migration-coordinator' },
			message: {
				role: 'user',
				content: 'Four errors remain in the migration boundary.'
			}
		});
	});

	it('keeps a tool result inside one complete canonical Prompt message', () => {
		const [message] = projectConversationMessages(
			canonicalAgentRows([
				{
					conversationId,
					runId,
					message: {
						role: 'tool',
						content: [
							{
								type: 'tool-result',
								id: 'call-1',
								name: 'system/message',
								isFailure: false,
								result: { delivered: true }
							}
						]
					}
				}
			])
		);

		expect(message?.message).toEqual({
			role: 'tool',
			content: [
				{
					type: 'tool-result',
					id: 'call-1',
					name: 'system/message',
					isFailure: false,
					result: { delivered: true }
				}
			]
		});
	});
});
