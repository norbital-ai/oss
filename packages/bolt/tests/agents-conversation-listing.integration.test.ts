import { afterEach, describe, expect, it } from 'vitest';
import {
	AgentId,
	DirectiveMode,
	DirectivePriority,
	ConversationId
} from '@norbital-ai/bolt-protocol';
import * as Agents from '../src/runtime/agents/agents.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	testWorkspace,
	type BoltTestRuntime
} from './support/bolt-test-layer.js';

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

describe('Task admission projection', () => {
	it('commits one Task, message, and directive and deduplicates the same admission', async () => {
		harness = await makeBoltTestRuntime(testWorkspace());
		const agents = await harness.runtime.runPromise(Agents.Service);
		const conversationId = ConversationId.make('00000000-0000-4000-8000-000000000401');
		const request = {
			conversationId,
			agentId: AgentId.make('web'),
			message: Agents.userAgentInput('Run payroll'),
			mode: DirectiveMode.make('agent'),
			priority: DirectivePriority.make('normal')
		};
		const first = await harness.runtime.runPromise(
			agents.submit(harness.effectId('task-admission:first'), adminSubject, request)
		);
		const retry = await harness.runtime.runPromise(
			agents.submit(harness.effectId('task-admission:retry'), adminSubject, request)
		);
		expect(retry.messageId).toBe(first.messageId);

		expect(
			await harness.database.query(
				`select
					(select count(*)::int from conversation where id = $1) as tasks,
					(select count(*)::int from conversation_message where conversation_id = $1) as messages,
					(select count(*)::int from conversation_message where conversation_id = $1 and state is not null) as directives,
					(select count(*)::int from turn where conversation_id = $1) as runs`,
				[conversationId]
			)
		).toEqual([{ tasks: 1, messages: 1, directives: 1, runs: 0 }]);
		const followUp = await harness.runtime.runPromise(
			agents.submit(harness.effectId('task-admission:follow-up'), adminSubject, {
				...request,
				message: Agents.userAgentInput('Include the contractor run.')
			})
		);
		expect(followUp.messageId).not.toBe(first.messageId);
		expect(
			await harness.database.query(
				`select
					(select count(*)::int from conversation where id = $1) as tasks,
					(select count(*)::int from conversation_message where conversation_id = $1) as messages,
					(select count(*)::int from conversation_message where conversation_id = $1 and state is not null) as directives`,
				[conversationId]
			)
		).toEqual([{ tasks: 1, messages: 2, directives: 2 }]);
	});
});
