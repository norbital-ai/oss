import { describe, expect, it, afterEach } from 'vitest';
import { Effect } from 'effect';
import { AgentId, DirectiveMode, DirectivePriority, ConversationId, MessageId } from '@norbital-ai/bolt-protocol';
import * as Agents from '../src/runtime/agents/agents.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	testWorkspace,
	type BoltTestRuntime
} from './support/bolt-test-layer.js';
import { assistantText, scriptedTranscript } from './agents-canonical-ai-fixture.js';

/**
 * Revising a message you already sent.
 *
 * Nothing is edited and nothing is deleted. The revision is an ordinary appended message that names
 * the row it supersedes, and the same admission queues the turn that answers it — which is what
 * makes the transcript a record rather than a draft, and what lets the panel show both what was
 * asked and what it was changed to.
 *
 * This suite exists because the path had none. Its shape was pinned in `agents-durable-contract` and
 * its client call in `ui-agent-live-turn`, but that lane is gated on a live server and does not run,
 * so nothing exercised the runtime: not the authorship check, not the one-live-head rule, not the
 * turn the revision starts.
 */

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

const other = { ...adminSubject, userId: 'someone-else' };

const open = async (conversationId: ConversationId, replies: number = 4) => {
	const { ai } = scriptedTranscript(
		Array.from({ length: replies }, (_, index) => assistantText(`Reply ${index + 1}.`))
	);
	harness = await makeBoltTestRuntime(testWorkspace(), { ai });
	const agents = await harness.runtime.runPromise(Agents.Service);
	const sent = await harness.runtime.runPromise(
		agents.submit(harness.effectId('submit'), adminSubject, {
			conversationId,
			agentId: AgentId.make('web'),
			message: Agents.userAgentInput('Export the March payroll.'),
			mode: DirectiveMode.make('agent'),
			priority: DirectivePriority.make('normal')
		})
	);
	await harness.runtime.runPromise(
		agents.answerQueued(harness.effectId('answer'), adminSubject, conversationId)
	);
	return { agents, messageId: sent.messageId };
};

const transcript = (conversationId: ConversationId) =>
	harness!.database.query(
		`select id, sequence, supersedes_id, state, author->>'kind' as author,
		        message->>'role' as role, message->>'content' as content
		 from conversation_message where conversation_id = $1 order by sequence`,
		[conversationId]
	);

describe('revising a message', () => {
	it('appends the revision, points it at the original, and answers it in a new turn', async () => {
		const conversationId = ConversationId.make('00000000-0000-4000-8000-000000000e01');
		const { agents, messageId } = await open(conversationId);

		const revised = await harness!.runtime.runPromise(
			agents.editMessage(harness!.effectId('edit'), adminSubject, {
				conversationId,
				messageId,
				message: Agents.userAgentInput('Export the April payroll, not March.')
			})
		);
		expect(revised.supersedesId).toBe(messageId);
		expect(revised.messageId).not.toBe(messageId);

		// The original is still there, unaltered, and the revision sits after it naming it.
		const rows = (await transcript(conversationId)) as ReadonlyArray<Record<string, unknown>>;
		const original = rows.find((row) => row['id'] === messageId)!;
		const revision = rows.find((row) => row['id'] === revised.messageId)!;
		expect(String(original['content'])).toContain('March');
		expect(original['supersedes_id']).toBeNull();
		expect(revision['supersedes_id']).toBe(messageId);
		expect(Number(revision['sequence'])).toBeGreaterThan(Number(original['sequence']));

		// A revision is a message like any other: it queues, and the turn that answers it consumes it.
		await harness!.runtime.runPromise(
			agents.answerQueued(harness!.effectId('answer:revision'), adminSubject, conversationId)
		);
		const answered = (await transcript(conversationId)) as ReadonlyArray<Record<string, unknown>>;
		expect(answered.find((row) => row['id'] === revised.messageId)?.['state']).toBe('consumed');
		expect(
			await harness!.database.query(
				`select count(*)::int as turns from turn where conversation_id = $1`,
				[conversationId]
			)
		).toEqual([{ turns: 2 }]);
	});

	it('refuses a second live head: only the newest revision may be revised again', async () => {
		const conversationId = ConversationId.make('00000000-0000-4000-8000-000000000e02');
		const { agents, messageId } = await open(conversationId);
		const edit = (target: MessageId, text: string) =>
			agents.editMessage(harness!.effectId(`edit:${target}:${text.length}`), adminSubject, {
				conversationId,
				messageId: target,
				message: Agents.userAgentInput(text)
			});

		const first = await harness!.runtime.runPromise(edit(messageId, 'April, not March.'));

		// The original now has a revision, so revising it again would give it two live heads.
		const refused = await harness!.runtime.runPromise(
			Effect.flip(edit(messageId, 'May, actually.'))
		);
		expect(refused).toMatchObject({
			_tag: 'Bolt.AccessControl.AccessDenied',
			reason: 'the message is already superseded; revise its newest revision'
		});

		// Revising the newest revision is allowed, and chains.
		const second = await harness!.runtime.runPromise(edit(first.messageId, 'May, actually.'));
		expect(second.supersedesId).toBe(first.messageId);
	});

	it('refuses a revision by anyone but the author, and of anything but a person’s message', async () => {
		const conversationId = ConversationId.make('00000000-0000-4000-8000-000000000e03');
		const { agents, messageId } = await open(conversationId);

		// Not yours to revise. The conversation is the admin's, so this is refused as an unknown
		// conversation before authorship is even reached — the outer check is ownership.
		const byOther = await harness!.runtime.runPromise(
			Effect.flip(
				agents.editMessage(harness!.effectId('edit:other'), other, {
					conversationId,
					messageId,
					message: Agents.userAgentInput('Not mine to change.')
				})
			)
		);
		expect(byOther).toMatchObject({ _tag: 'Bolt.AccessControl.AccessDenied' });

		// The agent's own reply is not a draft. Only what a person wrote can be revised.
		const reply = (
			(await harness!.database.query(
				`select id from conversation_message
				 where conversation_id = $1 and author->>'kind' = 'agent' order by sequence limit 1`,
				[conversationId]
			)) as ReadonlyArray<{ id: string }>
		)[0]!;
		const ofReply = await harness!.runtime.runPromise(
			Effect.flip(
				agents.editMessage(harness!.effectId('edit:reply'), adminSubject, {
					conversationId,
					messageId: MessageId.make(reply.id),
					message: Agents.userAgentInput('Say it differently.')
				})
			)
		);
		expect(ofReply).toMatchObject({
			_tag: 'Bolt.AccessControl.AccessDenied',
			reason: 'only the author may revise their own message'
		});

		// A message that does not exist is refused by name, not by a decode failure somewhere later.
		const unknown = await harness!.runtime.runPromise(
			Effect.flip(
				agents.editMessage(harness!.effectId('edit:unknown'), adminSubject, {
					conversationId,
					messageId: MessageId.make('00000000-0000-4000-8000-0000000000ff'),
					message: Agents.userAgentInput('Nothing to revise.')
				})
			)
		);
		expect(unknown).toMatchObject({ reason: 'unknown Task message' });
	});
});
