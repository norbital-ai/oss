import { afterEach, describe, expect, it } from 'vitest';
import {
	AgentId,
	DirectiveMode,
	DirectivePriority,
	ConversationId
} from '@norbital-ai/bolt-protocol';
import { envoy } from '../src/authoring/workspace-schema.js';
import * as Agents from '../src/runtime/agents/agents.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	testWorkspace,
	type BoltTestRuntime
} from './support/bolt-test-layer.js';
import {
	assistantText,
	assistantToolCall,
	scriptedTranscript,
	toolResultFor
} from './agents-canonical-ai-fixture.js';

const definition = testWorkspace({
	envoys: [
		envoy({
			name: 'worker',
			transport: 'whatsapp',
			audience: 'authenticated',
			policies: ['admin'],
			task: 'Report field status.',
			delegation: 'enabled'
		})
	]
});

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

const submitParent = async (
	agents: Agents.Interface,
	name: string,
	conversationId: ConversationId
) => {
	await harness!.runtime.runPromise(
		agents.submit(harness!.effectId(`submit:${name}`), adminSubject, {
			conversationId,
			agentId: AgentId.make('web'),
			message: Agents.userAgentInput('Coordinate the field work.'),
			mode: DirectiveMode.make('agent'),
			priority: DirectivePriority.make('normal')
		})
	);
};

const execute = (agents: Agents.Interface, name: string, conversationId: ConversationId) =>
	harness!.runtime.runPromise(
		agents.execute(harness!.effectId(name), adminSubject, conversationId)
	);

const childTaskRow = async (parentId: ConversationId) => {
	const rows = await harness!.database.query(
		`select id, status, agent_id, parent_id from conversation where parent_id = $1`,
		[parentId]
	);
	return rows[0];
};

describe('sub-agent orchestration over a scripted transcript', () => {
	it('refuses fabricated child delegation and plan calls even when the child declaration enables delegation', async () => {
		const parentId = ConversationId.make('00000000-0000-4000-8000-000000000911');
		const { ai } = scriptedTranscript(
			[
				assistantToolCall(
					'subagent',
					{ action: 'spawn', agentId: 'worker', instruction: 'Inspect only.' },
					'spawn-boundary'
				),
				assistantText('Child dispatched.'),
				async () =>
					assistantToolCall(
						'subagent',
						{ action: 'await', conversationId: String((await childTaskRow(parentId))?.id) },
						'consume-boundary'
					),
				assistantText('Finished.')
			],
			{
				children: [
					assistantToolCall(
						'subagent',
						{ action: 'spawn', agentId: 'web', instruction: 'Must not run.' },
						'fabricated-spawn'
					),
					assistantToolCall(
						'update_plan',
						{ operation: 'replace', expectedRevision: 0, body: 'Must not create a child plan.' },
						'fabricated-plan'
					),
					assistantText('Boundary checked.')
				]
			}
		);
		harness = await makeBoltTestRuntime(definition, { ai });
		const agents = await harness.runtime.runPromise(Agents.Service);
		await submitParent(agents, '911', parentId);
		await execute(agents, '911', parentId);
		const child = await childTaskRow(parentId);
		expect(
			await harness.database.query('select id from conversation where parent_id = $1', [child?.id])
		).toEqual([]);
		expect(
			await harness.database.query('select id from plan where conversation_id = $1', [child?.id])
		).toEqual([]);
		const rows = await harness.database.query(
			"select message from conversation_message where conversation_id = $1 and author->>'kind' = 'tool'",
			[child?.id]
		);
		expect(JSON.stringify(rows).match(/"isFailure":true/g)).toHaveLength(2);
	});
	/**
	 * Two of a person's conversations can talk: a root may read and message another root it owns,
	 * not only its children. The message is that conversation's next input — it starts a turn on an
	 * idle one — and it is labelled by the conversation it came from. A conversation of somebody
	 * else stays out of reach.
	 */
	it("lets a root read and message a sibling conversation it owns, and nobody else's", async () => {
		const siblingId = ConversationId.make('00000000-0000-4000-8000-000000000903');
		const parentId = ConversationId.make('00000000-0000-4000-8000-000000000904');
		const strangerId = ConversationId.make('00000000-0000-4000-8000-000000000905');
		const { ai, requests } = scriptedTranscript([
			assistantText('Sibling settled.'),
			assistantToolCall(
				'search_task_history',
				{ scope: 'mine', query: 'Sibling settled' },
				'find-1'
			),
			assistantToolCall('subagent', { action: 'read', conversationId: siblingId }, 'read-1'),
			assistantToolCall(
				'subagent',
				{ action: 'message', conversationId: siblingId, message: 'Pick up the ledger.' },
				'message-1'
			),
			assistantToolCall('subagent', { action: 'read', conversationId: strangerId }, 'read-2'),
			assistantText('Sent.'),
			assistantText('Ledger picked up.')
		]);
		harness = await makeBoltTestRuntime(definition, { ai });
		const agents = await harness.runtime.runPromise(Agents.Service);
		await submitParent(agents, '903', siblingId);
		await execute(agents, '903', siblingId);
		await harness.database.query(
			`insert into conversation(id,workbench_id,subject_id,agent_id,audience,status) values ($1::uuid,$2::uuid,'someone-else','web','private','done')`,
			[strangerId, strangerId]
		);
		await submitParent(agents, '904', parentId);
		await execute(agents, '904', parentId);
		const parentRequests = requests.filter(({ sessionId }) => sessionId === parentId);
		// The sibling is found by searching every conversation of the person, id and all.
		expect(JSON.stringify(toolResultFor(parentRequests[1]!, 'search_task_history'))).toContain(
			siblingId
		);
		expect(toolResultFor(parentRequests[2]!, 'subagent')).toMatchObject({
			conversationId: siblingId,
			status: 'done'
		});
		expect(toolResultFor(parentRequests[3]!, 'subagent')).toMatchObject({
			conversationId: siblingId,
			state: 'queued'
		});
		const refused = toolResultFor(parentRequests[4]!, 'subagent');
		expect(JSON.stringify(refused)).toContain('ToolNotAllowed');
		// The message is the sibling's next input, named by the conversation it came from.
		await execute(agents, '903:b', siblingId);
		const rows = await harness.database.query(
			`select message from conversation_message where conversation_id = $1 order by sequence`,
			[siblingId]
		);
		expect(JSON.stringify(rows)).toContain(`[Agent conversation ${parentId}]`);
		expect(JSON.stringify(rows)).toContain('Ledger picked up.');
	});

	/**
	 * A parent runs its own children, inside its own turn, and does not stop for them.
	 *
	 * There used to be a park here: the parent set itself `waiting`, returned, and something else
	 * had to run the child and wake it. That something was a durable work occurrence, and when the
	 * occurrence went, nothing replaced it — a spawned child sat with a queued message no caller
	 * would ever answer, and the parent sat `waiting` forever. The child is a fiber of the parent's
	 * turn now: one `execute`, and the whole tree runs inside it, the child beside the parent.
	 */
	it('runs its child beside itself and demands consumption before finishing', async () => {
		let childConversationId: string | undefined;
		const parentConversationId = ConversationId.make('00000000-0000-4000-8000-000000000901');
		const { ai, requests } = scriptedTranscript(
			[
				assistantToolCall(
					'subagent',
					{ action: 'spawn', agentId: 'worker', instruction: 'Report the field status.' },
					'spawn-1'
				),
				async () => {
					const child = await childTaskRow(parentConversationId);
					childConversationId = String(child?.id);
					return assistantText('Child dispatched; standing by.');
				},
				(request) => {
					expect(JSON.stringify(request.messages)).toContain(
						'Consume required child Tasks with subagent await before finishing'
					);
					return assistantToolCall(
						'subagent',
						{ action: 'await', conversationId: childConversationId },
						'await-1'
					);
				},
				assistantText('Child result consumed; the field report is nominal.')
			],
			{
				// The child's own turn, forked by the spawn rather than run by a separate caller.
				children: [
					(request) => {
						const tools = request.output._tag === 'Message' ? request.output.tools : [];
						expect(tools?.map(({ name }) => name)).not.toContain('subagent');
						expect(tools?.map(({ name }) => name)).not.toContain('update_plan');
						return assistantText('Field status: all sites nominal.');
					}
				]
			}
		);
		harness = await makeBoltTestRuntime(definition, { ai });
		const agents = await harness.runtime.runPromise(Agents.Service);
		await submitParent(agents, '901', parentConversationId);

		// One call. No park, no wake, no second execute.
		const settled = await execute(agents, '901:a', parentConversationId);
		expect(settled.status).toBe('done');

		const child = await childTaskRow(parentConversationId);
		expect(child).toMatchObject({ agent_id: 'worker', status: 'done' });
		expect(
			await harness.database.query(`select status, phase from turn where conversation_id = $1`, [
				parentConversationId
			])
		).toEqual([{ status: 'succeeded', phase: 'model' }]);
		expect(
			await harness.database.query('select status from conversation where id = $1', [
				parentConversationId
			])
		).toEqual([{ status: 'done' }]);

		const [snapshot] = await harness.database.query(
			'select capability_snapshot from turn where conversation_id = $1',
			[parentConversationId]
		);
		expect(snapshot?.capability_snapshot).toMatchObject({
			capabilities: expect.any(Array),
			authorityDigest: expect.any(String)
		});

		const parentMessages = await harness.database.query(
			`select message from conversation_message where conversation_id = $1 order by sequence`,
			[parentConversationId]
		);
		expect(JSON.stringify(parentMessages)).toContain('Consume required child Tasks');
		const consumed = toolResultFor(
			requests.findLast(({ sessionId }) => sessionId === parentConversationId)!,
			'subagent'
		);
		expect(consumed).toMatchObject({ state: 'done', conversationId: childConversationId });
		expect(JSON.stringify(consumed)).toContain('Field status: all sites nominal.');

		/**
		 * Every provider call the parent made is billed, and they are distinct.
		 *
		 * The call used to be named `${run.id}:${iteration}`, and `iteration` restarted whenever the
		 * turn re-entered its loop — which is what the park's wake did. Two calls minted one
		 * `call_id` and the second usage row overwrote the first, losing a billable observation with
		 * nothing failing. The park is gone, but the naming is the guard: it is the transcript
		 * position now, which only advances.
		 */
		const usage = await harness.database.query(
			`select distinct usage.call_id from turn_usage usage
			 join turn run on run.id = usage.turn_id where run.conversation_id = $1`,
			[parentConversationId]
		);
		expect(usage).toHaveLength(4);
	});

	/**
	 * Every message one agent sends another steers, whatever order they were sent in.
	 *
	 * There used to be two tool actions here, `message` and `steer`, and a model had to choose. It
	 * has nothing to choose with: a parent writes to a child because the child is about to do
	 * something with what it says, so a message that waits for the child's current turn to finish is
	 * a message that arrives after the work it was meant to change. One action, and the priority is
	 * decided by who the author is.
	 */
	it('delivers both parent messages to the child as steering, ahead of its own instruction', async () => {
		let childConversationId: string | undefined;
		const parentConversationId = ConversationId.make('00000000-0000-4000-8000-000000000902');
		const delivered = Promise.withResolvers<void>();
		const { ai, feed, requests } = scriptedTranscript(
			[
				assistantToolCall(
					'subagent',
					{ action: 'spawn', agentId: 'worker', instruction: 'Record the field update.' },
					'spawn-1'
				),
				async (request) => {
					const child = await childTaskRow(parentConversationId);
					childConversationId = String(child?.id);
					// The spawn tool result carries the child's directive id.
					const spawned = toolResultFor(request, 'subagent');
					expect(spawned).toMatchObject({ conversationId: childConversationId, state: 'running' });
					return assistantToolCall(
						'subagent',
						{
							action: 'message',
							conversationId: childConversationId,
							message: 'Capture the invoice count.'
						},
						'message-1'
					);
				},
				() =>
					assistantToolCall(
						'subagent',
						{
							action: 'message',
							conversationId: childConversationId,
							message: 'Prioritize the payroll export.'
						},
						'steer-1'
					),
				(request) => {
					expect(toolResultFor(request, 'subagent')).toMatchObject({ state: 'queued' });
					delivered.resolve();
					return assistantText('Directives delivered; standing by.');
				},
				// Back in the parent, which is told to consume before it may finish.
				(request) => {
					expect(JSON.stringify(request.messages)).toContain(
						'Consume required child Tasks with subagent await before finishing'
					);
					return assistantToolCall(
						'subagent',
						{ action: 'await', conversationId: childConversationId },
						'await-1'
					);
				},
				assistantText('Child directives acknowledged.')
			],
			{
				children: [
					/**
					 * The child's one turn, running beside the parent, holding all three messages.
					 *
					 * One, not three, and that is the property. Steering is taken at a *step* boundary
					 * of the turn already running, so the two messages the parent sent after the spawn
					 * are folded into the turn answering the spawn rather than queued behind it. A child
					 * that had to finish before hearing them would answer the first instruction having
					 * been told twice that it was the wrong one. The first step is held until both are
					 * sent, so the second step is the one that hears them.
					 */
					async () => {
						await delivered.promise;
						return assistantToolCall('todo', { operation: 'read' }, 'look-1');
					},
					(request) => {
						const transcript = JSON.stringify(request.messages);
						expect(transcript).toContain('[Agent conversation');
						expect(transcript).toContain('Record the field update.');
						expect(transcript).toContain('Capture the invoice count.');
						expect(transcript).toContain('Prioritize the payroll export.');
						return assistantText('Payroll export prioritized.');
					}
				]
			}
		);
		harness = await makeBoltTestRuntime(definition, { ai });
		const agents = await harness.runtime.runPromise(Agents.Service);
		await submitParent(agents, '902', parentConversationId);
		const settled = await execute(agents, '902:a', parentConversationId);
		expect(settled.status).toBe('done');

		const childRow = await childTaskRow(parentConversationId);
		const childConversationId2 = ConversationId.make(String(childRow?.id));
		expect(childRow?.status).toBe('done');
		// Every message the parent sent was answered, and the steer was answered first.
		expect(
			await harness.database.query(
				`select sequence, priority, state from conversation_message where conversation_id = $1 and state is not null order by sequence`,
				[childConversationId2]
			)
		).toEqual([
			// The spawn instruction is itself parent-to-child, so it steers too. The distinction the
			// column still carries is a person's: a human `steer` from the composer.
			{ sequence: 1, priority: 'steer', state: 'consumed' },
			{ sequence: 2, priority: 'steer', state: 'consumed' },
			{ sequence: 3, priority: 'steer', state: 'consumed' }
		]);
		/**
		 * One run answered all three, which is what steering *is*.
		 *
		 * The run's declared input is the spawn instruction — the message that started the turn — and
		 * the two that arrived after it were stamped with the same run rather than starting their own.
		 */
		const childRuns = await harness.database.query(
			`select input_message_id from turn where conversation_id = $1`,
			[childConversationId2]
		);
		expect(childRuns).toHaveLength(1);
		expect(
			await harness.database.query(
				`select count(distinct turn_id)::int as runs from conversation_message
				 where conversation_id = $1 and state = 'consumed'`,
				[childConversationId2]
			)
		).toEqual([{ runs: 1 }]);
		expect(
			await harness.database.query(
				`select id from conversation_message where conversation_id = $1 and sequence = 1`,
				[childConversationId2]
			)
		).toEqual([{ id: childRuns[0]?.input_message_id }]);

		// Six parent Generates plus the child's two.
		expect(feed).toHaveLength(6 + 2);
		// The message tool result acknowledged as queued, never silently consumed.
		const parentRequests = requests.filter(({ sessionId }) => sessionId === parentConversationId);
		expect(toolResultFor(parentRequests[2]!, 'subagent')).toMatchObject({
			conversationId: childConversationId,
			state: 'queued'
		});
	});
});
