import { Effect } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import {
	AgentId,
	ConversationId,
	DirectiveMode,
	DirectivePriority
} from '@norbital-ai/bolt-protocol';
import * as Agents from '../src/runtime/agents/agents.js';
import { assistantText, scriptedTranscript } from './agents-canonical-ai-fixture.js';
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

/**
 * A turn whose host task has settled without settling the turn — killed with its isolate, or
 * failed past its retries — leaves the conversation `running` behind a dead worker. The next
 * message from anyone else used to defer to that worker forever. It now closes the corpse and
 * answers the message.
 */
describe('a message sent into a conversation held by a dead worker', () => {
	it('closes the abandoned turn, reopens the conversation, and answers', async () => {
		harness = await makeBoltTestRuntime(testWorkspace(), {
			ai: scriptedTranscript([assistantText('Picked up where the last turn stopped.')]).ai
		});
		const agents = await harness.runtime.runPromise(Agents.Service);
		const conversationId = ConversationId.make('00000000-0000-4000-8000-000000000d01');
		const submit = (name: string, text: string) =>
			harness!.runtime.runPromise(
				agents.submit(harness!.effectId(`submit:${name}`), adminSubject, {
					conversationId,
					agentId: AgentId.make('web'),
					message: Agents.userAgentInput(text),
					mode: DirectiveMode.make('agent'),
					priority: DirectivePriority.make('normal')
				})
			);
		const another = <A, E>(effect: Effect.Effect<A, E, string>) =>
			harness!.runtime.runPromise(
				effect.pipe(Effect.provideService(Agents.ExecutionOwner, 'another-driver'))
			);
		// Admission starts the first turn under the worker `agent:<message>`; nothing runs it.
		const first = await submit('first', 'Start the work.');
		await submit('follow-up', 'Hello? Are you still there?');

		// While that worker's task is unknown or still alive, another driver defers to it.
		expect(
			(
				await another(
					agents.execute(harness.effectId('execute:deferred'), adminSubject, conversationId)
				)
			).status
		).toBe('idle');
		await harness.database.query(
			`insert into bolt_task (command, input, effect_id, run_at, status, attempts)
			 values ('conversations.answer', '{}'::jsonb, $1, now(), 'running', 1)`,
			[Agents.executionTaskId(first.messageId)]
		);
		expect(
			(
				await another(
					agents.execute(harness.effectId('execute:alive'), adminSubject, conversationId)
				)
			).status
		).toBe('idle');

		// Once that task has settled, the next driver takes the conversation over.
		await harness.database.query(`update bolt_task set status = 'failed' where effect_id = $1`, [
			Agents.executionTaskId(first.messageId)
		]);
		const answered = await another(
			agents.execute(harness.effectId('execute:takeover'), adminSubject, conversationId)
		);
		expect(answered.status).toBe('done');
		expect(JSON.stringify(answered.output)).toContain('Picked up where the last turn stopped.');

		const rows = await harness.database.query(
			`select
				(select status from conversation where id = $1) as conversation,
				(select count(*)::int from turn where conversation_id = $1 and status = 'failed') as failed_turns,
				(select count(*)::int from conversation_message where conversation_id = $1 and author->>'kind' = 'system' and message::text like '%worker running the previous turn stopped%') as notices`,
			[conversationId]
		);
		expect(rows).toEqual([{ conversation: 'done', failed_turns: 1, notices: 1 }]);
	});
});
