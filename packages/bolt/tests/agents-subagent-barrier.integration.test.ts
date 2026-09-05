import { afterEach, describe, expect, it } from 'vitest';
import { AgentId, DirectiveMode, DirectivePriority, TaskId } from '@norbital-ai/bolt-protocol';
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
			delegation: 'disabled'
		})
	]
});

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

const submitParent = async (agents: Agents.Interface, name: string, taskId: TaskId) => {
	await harness!.runtime.runPromise(
		agents.submit(harness!.effectId(`submit:${name}`), adminSubject, {
			taskId,
			agentId: AgentId.make('web'),
			message: Agents.userAgentInput('Coordinate the field work.'),
			mode: DirectiveMode.make('agent'),
			priority: DirectivePriority.make('normal')
		})
	);
};

const execute = (agents: Agents.Interface, name: string, taskId: TaskId) =>
	harness!.runtime.runPromise(agents.execute(harness!.effectId(name), adminSubject, taskId));

const childTaskRow = async (parentId: TaskId) => {
	const rows = await harness!.database.query(
		`select id, status, agent_id, parent_id from agent_task where parent_id = $1`,
		[parentId]
	);
	return rows[0];
};

describe('sub-agent orchestration over a scripted transcript', () => {
	it('parks on a running child, wakes the parent when the child settles, and demands consumption before finishing', async () => {
		let childTaskId: string | undefined;
		const parentTaskId = TaskId.make('00000000-0000-4000-8000-000000000901');
		const { ai, requests } = scriptedTranscript([
			assistantToolCall(
				'subagent',
				{ action: 'spawn', agentId: 'worker', instruction: 'Report the field status.' },
				'spawn-1'
			),
			async () => {
				const child = await childTaskRow(parentTaskId);
				childTaskId = String(child?.id);
				return assistantText('Child dispatched; standing by.');
			},
			// The child's own turn.
			assistantText('Field status: all sites nominal.'),
			// Parent resume 1: a bare answer hits the required-child barrier.
			assistantText('The child work is finished.'),
			(request) => {
				expect(JSON.stringify(request.messages)).toContain(
					'Consume required child Tasks with subagent await before finishing'
				);
				return assistantToolCall('subagent', { action: 'await', taskId: childTaskId }, 'await-1');
			},
			assistantText('Child result consumed; the field report is nominal.')
		]);
		harness = await makeBoltTestRuntime(definition, { ai });
		const agents = await harness.runtime.runPromise(Agents.Service);
		await submitParent(agents, '901', parentTaskId);

		const parked = await execute(agents, '901:a', parentTaskId);
		expect(parked.status).toBe('waiting');
		const child = await childTaskRow(parentTaskId);
		expect(child).toMatchObject({ agent_id: 'worker', status: 'ready' });
		expect(
			await harness.database.query(`select status, phase from agent_run where task_id = $1`, [
				parentTaskId
			])
		).toEqual([{ status: 'waiting', phase: 'children' }]);

		const [beforeResume] = await harness.database.query(
			'select capability_snapshot from agent_run where task_id = $1',
			[parentTaskId]
		);
		expect(beforeResume?.capability_snapshot).toMatchObject({
			capabilities: expect.any(Array),
			authorityDigest: expect.any(String)
		});
		const childDone = await execute(agents, '901:child', TaskId.make(String(child?.id)));
		expect(childDone.status).toBe('done');
		// The child's completion wakes the parked parent: run re-armed at a new epoch.
		expect(
			await harness.database.query(
				`select task.status as task_status, run.status as run_status, run.epoch
				 from agent_task task join agent_run run on run.id = task.active_run_id
				 where task.id = $1`,
				[parentTaskId]
			)
		).toEqual([{ task_status: 'ready', run_status: 'running', epoch: 2 }]);

		expect(
			await harness.database.query('select capability_snapshot from agent_run where task_id = $1', [
				parentTaskId
			])
		).toEqual([beforeResume]);
		const resumed = await execute(agents, '901:b', parentTaskId);
		expect(resumed.status).toBe('done');
		const parentMessages = await harness.database.query(
			`select message from agent_message where task_id = $1 order by sequence`,
			[parentTaskId]
		);
		expect(JSON.stringify(parentMessages)).toContain('Consume required child Tasks');
		const consumed = toolResultFor(requests.at(-1)!, 'subagent');
		expect(consumed).toMatchObject({ state: 'done', taskId: childTaskId });
		expect(JSON.stringify(consumed)).toContain('Field status: all sites nominal.');
	});

	it('delivers a parent message and a parent steer to the child, claiming the steer first', async () => {
		let childTaskId: string | undefined;
		const parentTaskId = TaskId.make('00000000-0000-4000-8000-000000000902');
		const { ai, feed, requests } = scriptedTranscript([
			assistantToolCall(
				'subagent',
				{ action: 'spawn', agentId: 'worker', instruction: 'Record the field update.' },
				'spawn-1'
			),
			async (request) => {
				const child = await childTaskRow(parentTaskId);
				childTaskId = String(child?.id);
				// The spawn tool result carries the child's directive id.
				const spawned = toolResultFor(request, 'subagent');
				expect(spawned).toMatchObject({ taskId: childTaskId, state: 'running' });
				return assistantToolCall(
					'subagent',
					{ action: 'message', taskId: childTaskId, message: 'Capture the invoice count.' },
					'message-1'
				);
			},
			() =>
				assistantToolCall(
					'subagent',
					{ action: 'steer', taskId: childTaskId, message: 'Prioritize the payroll export.' },
					'steer-1'
				),
			assistantText('Directives delivered; standing by.'),
			// The child answers the steer first.
			(request) => {
				const transcript = JSON.stringify(request.messages);
				expect(transcript).toContain('Prioritize the payroll export.');
				expect(transcript).toContain('[Parent agent');
				return assistantText('Payroll export prioritized.');
			}
		]);
		harness = await makeBoltTestRuntime(definition, { ai });
		const agents = await harness.runtime.runPromise(Agents.Service);
		await submitParent(agents, '902', parentTaskId);
		const parked = await execute(agents, '902:a', parentTaskId);
		expect(parked.status).toBe('waiting');

		const childRow = await childTaskRow(parentTaskId);
		const childTaskId2 = TaskId.make(String(childRow?.id));
		const childSteered = await execute(agents, '902:child', childTaskId2);
		expect(childSteered.status).toBe('idle');
		expect((await childTaskRow(parentTaskId))?.status).toBe('ready');
		expect(
			await harness.database.query(
				`select sequence, priority, state from agent_inbox where task_id = $1 order by sequence`,
				[childTaskId2]
			)
		).toEqual([
			{ sequence: 1, priority: 'normal', state: 'queued' },
			{ sequence: 2, priority: 'normal', state: 'queued' },
			{ sequence: 3, priority: 'steer', state: 'settled' }
		]);
		const childRun = await harness.database.query(
			`select directive_id from agent_run where task_id = $1`,
			[childTaskId2]
		);
		const steerDirective = await harness.database.query(
			`select id from agent_inbox where task_id = $1 and sequence = 3`,
			[childTaskId2]
		);
		expect(childRun[0]?.directive_id).toEqual(steerDirective[0]?.id);

		// Four parent Generates plus the child's steer-answer Generate.
		expect(feed).toHaveLength(4 + 1);
		// The message tool result acknowledged as queued, never silently consumed.
		expect(toolResultFor(requests[2]!, 'subagent')).toMatchObject({
			taskId: childTaskId,
			state: 'queued'
		});
	});
});
