import { afterEach, describe, expect, it } from 'vitest';
import { AgentId, DirectiveMode, DirectivePriority, TaskId } from '@norbital-ai/bolt-protocol';
import { systemToolSpecs } from '../src/runtime/agents/capability-catalog.js';
import * as Agents from '../src/runtime/agents/agents.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	testWorkspace,
	type BoltTestRuntime
} from './support/bolt-test-layer.js';
import {
	assistantText,
	assistantToolCalls,
	lastToolResult,
	scriptedTranscript
} from './agents-canonical-ai-fixture.js';

const SYSTEM_TOOLS = systemToolSpecs.map(({ name }) => name);
const AUTO_COMPACT_PROMPT_BYTES = 64 * 1_024;
const LARGE_INSTRUCTION = `Pipeline stress ${'x'.repeat(AUTO_COMPACT_PROMPT_BYTES)}`;

const PERSON_ID = '00000000-0000-4000-8000-000000000401';
const TOOL_TASK_ID = TaskId.make('00000000-0000-4000-8000-000000000401');
const IMAGE_KEY = Agents.taskAssetStorageKey(TOOL_TASK_ID, 'badge', 'badge.png');

const everySystemTool = assistantToolCalls([
	{ name: 'describe_workspace', input: {} },
	{ name: 'list_skills', input: {} },
	{ name: 'read_skill', input: { name: 'payroll' } },
	{
		name: 'todo',
		input: { items: [{ id: 'inspect', text: 'Inspect the workspace', status: 'doing' }] }
	},
	{ name: 'search_task_history', input: { scope: 'this_task', query: 'pipeline' } },
	{ name: 'read_collection', input: { collection: 'people', limit: 10 } },
	{
		name: 'write_collection',
		input: {
			collection: 'people',
			operation: 'create',
			id: PERSON_ID,
			values: { name: 'Ada' }
		}
	},
	{
		name: 'use_image',
		input: {
			key: IMAGE_KEY,
			name: 'badge.png',
			mimeType: 'image/png',
			size: 128,
			detail: 'auto'
		}
	}
]);

const workspace = testWorkspace({
	skills: [{ name: 'payroll', body: '# Payroll\n\nUse the approved workflow.' }]
});

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

const openTask = async (
	ai: ReturnType<typeof scriptedTranscript>['ai'],
	name: string,
	mode: 'agent' | 'plan' | 'compact',
	message: string
) => {
	harness = await makeBoltTestRuntime(workspace, { ai });
	const agents = await harness.runtime.runPromise(Agents.Service);
	const taskId = TaskId.make(`00000000-0000-4000-8000-0000000004${name}`);
	await harness.runtime.runPromise(
		agents.submit(harness.effectId(`submit:${name}`), adminSubject, {
			taskId,
			agentId: AgentId.make('web'),
			message: Agents.userAgentInput(message),
			mode: DirectiveMode.make(mode),
			priority: DirectivePriority.make('normal')
		})
	);
	return { agents, taskId };
};

const runTask = async (
	ai: ReturnType<typeof scriptedTranscript>['ai'],
	name: string,
	mode: 'agent' | 'plan' | 'compact',
	message: string
) => {
	const { agents, taskId } = await openTask(ai, name, mode, message);
	const result = await harness!.runtime.runPromise(
		agents.execute(harness!.effectId(`execute:${name}`), adminSubject, taskId)
	);
	return { result, taskId, agents };
};

const toolNamesFrom = (request: {
	readonly messages: ReadonlyArray<{ readonly role: string; readonly content: unknown }>;
}) =>
	request.messages.flatMap((message) => {
		if (message.role !== 'tool' || !Array.isArray(message.content)) return [];
		return message.content.flatMap((part: unknown) =>
			typeof part === 'object' &&
			part !== null &&
			'name' in part &&
			'type' in part &&
			part.type === 'tool-result'
				? [String(part.name)]
				: []
		);
	});

describe('scripted agent pipeline transcript', () => {
	it('streams every system tool through one Generate, then a final answer', async () => {
		expect(SYSTEM_TOOLS).toEqual([
			'todo',
			'describe_workspace',
			'list_skills',
			'read_skill',
			'search_task_history',
			'use_image',
			'read_collection',
			'write_collection'
		]);
		const { ai, feed, requests } = scriptedTranscript([
			everySystemTool,
			(request) => {
				expect(toolNamesFrom(request).toSorted()).toEqual([...SYSTEM_TOOLS].toSorted());
				expect(lastToolResult(request)).toMatchObject({
					key: IMAGE_KEY,
					name: 'badge.png',
					mimeType: 'image/png'
				});
				return assistantText('All system tools settled.');
			}
		]);
		const { result, taskId } = await runTask(ai, '01', 'agent', 'Exercise every system tool.');
		expect(result.status).toBe('done');
		expect(feed.every((step) => step.automaticCompact === false)).toBe(true);
		expect(feed.every((step) => step.planMode === false)).toBe(true);
		expect(feed).toHaveLength(2);
		expect(requests).toHaveLength(2);
		const output = requests[0]?.output;
		if (output?._tag !== 'Message') throw new Error('Expected tool-capable generation');
		expect(output.tools?.map(({ name }) => name).toSorted()).toEqual(
			[...SYSTEM_TOOLS, 'subagent'].toSorted()
		);
		expect(output.tools?.every(({ inputSchema }) => inputSchema['type'] === 'object')).toBe(true);
		expect(
			output.tools?.every(
				({ inputSchema }) =>
					!['oneOf', 'anyOf', 'allOf', 'enum', 'const', 'not'].some((key) => key in inputSchema)
			)
		).toBe(true);
		expect(
			output.tools?.find(({ name }) => name === 'write_collection')?.inputSchema
		).toMatchObject({
			required: ['collection', 'operation', 'id'],
			properties: { values: { type: 'object' } }
		});
		const persisted = await harness!.database.query(
			`select author->>'kind' as author_kind, message->>'role' as role
			 from agent_message where task_id = $1 order by sequence`,
			[taskId]
		);
		expect(persisted[0]).toEqual({ author_kind: 'human', role: 'user' });
		expect(persisted[1]).toEqual({ author_kind: 'agent', role: 'assistant' });
		expect(persisted.slice(2, 10).every((row) => row['author_kind'] === 'tool')).toBe(true);
		expect(persisted.at(-1)).toEqual({ author_kind: 'agent', role: 'assistant' });
		const people = await harness!.database.query(`select name from people where id = $1`, [
			PERSON_ID
		]);
		expect(people).toEqual([{ name: 'Ada' }]);
	});

	it('kicks in Automatic Compact in agent mode when the projection exceeds 64 KiB', async () => {
		const { ai, feed, requests } = scriptedTranscript([
			assistantText('Continuing from the compacted context.')
		]);
		const { result, taskId } = await runTask(ai, '02', 'agent', LARGE_INSTRUCTION);
		expect(result.status).toBe('done');
		expect(feed[0]).toMatchObject({
			automaticCompact: true,
			planMode: false,
			maxOutputTokens: 1_536
		});
		expect(feed[0]?.promptBytes).toBeGreaterThan(AUTO_COMPACT_PROMPT_BYTES);
		expect(feed[1]).toMatchObject({ automaticCompact: false, planMode: false });
		expect(JSON.stringify(requests[1]?.messages)).toContain(
			'Retained: the current user instruction, open decisions, and unresolved work.'
		);
		expect(feed).toHaveLength(2);
		const compact = await harness!.database.query(
			`select annotation->>'tag' as tag, annotation->>'origin' as origin
			 from agent_message
			 where task_id = $1 and annotation->>'tag' = 'compact'`,
			[taskId]
		);
		expect(compact).toEqual([{ tag: 'compact', origin: 'automatic' }]);
	});

	it('does not auto-compact in Plan mode; the model is fed the Plan contract', async () => {
		const { ai, feed } = scriptedTranscript([
			assistantText('Objective: inspect. Approach: read first. Verify: describe_workspace returns.')
		]);
		const { result, taskId } = await runTask(ai, '03', 'plan', LARGE_INSTRUCTION);
		expect(result.status).toBe('idle');
		expect(feed).toHaveLength(1);
		expect(feed[0]).toMatchObject({
			automaticCompact: false,
			planMode: true
		});
		expect(feed[0]?.promptBytes).toBeGreaterThan(AUTO_COMPACT_PROMPT_BYTES);
		expect(
			await harness!.database.query(
				`select plan.status, run.mode
				 from agent_task task
				 join agent_plan plan on plan.id = task.active_plan_id
				 join agent_run run on run.task_id = task.id
				 where task.id = $1`,
				[taskId]
			)
		).toEqual([{ status: 'active', mode: 'plan' }]);
		expect(
			await harness!.database.query(
				`select count(*)::int as n from agent_message
				 where task_id = $1 and annotation->>'origin' = 'automatic'`,
				[taskId]
			)
		).toEqual([{ n: 0 }]);
	});

	it('Plan mode refuses write_collection and still leaves an active Plan', async () => {
		const { ai, feed, requests } = scriptedTranscript([
			assistantToolCalls([
				{ name: 'describe_workspace', input: {} },
				{
					name: 'write_collection',
					input: {
						collection: 'people',
						operation: 'create',
						id: PERSON_ID,
						values: { name: 'Ada' }
					}
				}
			]),
			(request) => {
				expect(JSON.stringify(request.messages)).toContain('ToolNotAllowed');
				return assistantText(
					'Objective: do not write. Approach: describe only. Verify: write_collection is refused.'
				);
			}
		]);
		const { result } = await runTask(ai, '04', 'plan', 'Plan a people write.');
		expect(result.status).toBe('idle');
		expect(feed[0]?.planMode).toBe(true);
		expect(feed.every((step) => step.automaticCompact === false)).toBe(true);
		expect(requests).toHaveLength(2);
	});

	it('does not auto-compact on stop; compact waits for the next execute after resume', async () => {
		const { ai, feed } = scriptedTranscript([
			assistantText('Resumed after stop, from the compacted context.')
		]);
		const { agents, taskId } = await openTask(ai, '05', 'agent', LARGE_INSTRUCTION);
		const stopped = await harness!.runtime.runPromise(
			agents.control(harness!.effectId('stop:05'), adminSubject, { taskId, action: 'stop' })
		);
		expect(stopped).toEqual({ taskId, status: 'stopped' });
		expect(feed).toEqual([]);
		expect(
			await harness!.database.query(
				`select count(*)::int as n from agent_message
				 where task_id = $1 and annotation->>'tag' = 'compact'`,
				[taskId]
			)
		).toEqual([{ n: 0 }]);

		const resumed = await harness!.runtime.runPromise(
			agents.control(harness!.effectId('resume:05'), adminSubject, { taskId, action: 'resume' })
		);
		expect(resumed).toMatchObject({ taskId, status: 'ready' });
		const executed = await harness!.runtime.runPromise(
			agents.execute(harness!.effectId('execute:05'), adminSubject, taskId)
		);
		expect(executed.status).toBe('done');
		expect(feed[0]).toMatchObject({ automaticCompact: true, planMode: false });
		expect(feed[0]?.promptBytes).toBeGreaterThan(AUTO_COMPACT_PROMPT_BYTES);
		expect(
			await harness!.database.query(
				`select annotation->>'origin' as origin from agent_message
				 where task_id = $1 and annotation->>'tag' = 'compact'`,
				[taskId]
			)
		).toEqual([{ origin: 'automatic' }]);
	});

	it('treats /goal as an ordinary agent message, not a Plan or Compact mode', async () => {
		const { ai, feed } = scriptedTranscript([assistantText('Goal is just user text.')]);
		const { result } = await runTask(ai, '06', 'agent', '/goal ship the payroll export');
		expect(result.status).toBe('done');
		expect(feed).toHaveLength(1);
		expect(feed[0]).toMatchObject({
			automaticCompact: false,
			planMode: false,
			compactMode: false
		});
		expect(JSON.stringify(feed)).not.toContain('Plan mode:');
	});

	it('Plan mode then Agent: the model loses the pre-checkpoint brief and is given the Active Plan', async () => {
		const brief = 'UNIQUE_PLAN_BRIEF_MUST_LEAVE_THE_FEED';
		const { ai, feed, requests } = scriptedTranscript([
			assistantText(
				'Objective: ship export. Approach: read first. Verify: describe_workspace returns.'
			),
			assistantText('Executing against the Active Plan.')
		]);
		const { agents, taskId } = await openTask(ai, '07', 'plan', brief);
		const planned = await harness!.runtime.runPromise(
			agents.execute(harness!.effectId('execute:07:plan'), adminSubject, taskId)
		);
		expect(planned.status).toBe('idle');
		expect(feed[0]).toMatchObject({ planMode: true, compactMode: false, automaticCompact: false });
		expect(JSON.stringify(requests[0]?.messages)).toContain(brief);

		await harness!.runtime.runPromise(
			agents.submit(harness!.effectId('submit:07:agent'), adminSubject, {
				taskId,
				agentId: AgentId.make('web'),
				message: Agents.userAgentInput('Execute the Active Plan.'),
				mode: DirectiveMode.make('agent'),
				priority: DirectivePriority.make('normal')
			})
		);
		const executed = await harness!.runtime.runPromise(
			agents.execute(harness!.effectId('execute:07:agent'), adminSubject, taskId)
		);
		expect(executed.status).toBe('done');
		expect(feed[1]).toMatchObject({ planMode: false, automaticCompact: false });
		const agentFeed = JSON.stringify(requests[1]?.messages);
		expect(agentFeed).toContain('Active Plan revision');
		expect(agentFeed).toContain('Objective: ship export.');
		expect(agentFeed).not.toContain(brief);
		expect(agentFeed).toContain('Execute the Active Plan.');
	});

	it('Compact mode then Agent: the model loses the compact instruction and keeps the checkpoint', async () => {
		const instruction = 'UNIQUE_COMPACT_INSTRUCTION_MUST_LEAVE_THE_FEED';
		const { ai, feed, requests } = scriptedTranscript([
			assistantText('Retained: open payroll decisions and the current export work.'),
			assistantText('Continuing from the compacted checkpoint.')
		]);
		const { agents, taskId } = await openTask(ai, '08', 'compact', instruction);
		const compacted = await harness!.runtime.runPromise(
			agents.execute(harness!.effectId('execute:08:compact'), adminSubject, taskId)
		);
		expect(compacted.status).toBe('idle');
		expect(feed[0]).toMatchObject({
			compactMode: true,
			planMode: false,
			automaticCompact: false
		});
		expect(JSON.stringify(requests[0]?.messages)).toContain(instruction);

		await harness!.runtime.runPromise(
			agents.submit(harness!.effectId('submit:08:agent'), adminSubject, {
				taskId,
				agentId: AgentId.make('web'),
				message: Agents.userAgentInput('Continue after Compact.'),
				mode: DirectiveMode.make('agent'),
				priority: DirectivePriority.make('normal')
			})
		);
		const executed = await harness!.runtime.runPromise(
			agents.execute(harness!.effectId('execute:08:agent'), adminSubject, taskId)
		);
		expect(executed.status).toBe('done');
		expect(feed[1]).toMatchObject({ compactMode: false, automaticCompact: false });
		const agentFeed = JSON.stringify(requests[1]?.messages);
		expect(agentFeed).toContain('Retained: open payroll decisions and the current export work.');
		expect(agentFeed).toContain('Continue after Compact.');
		expect(agentFeed).not.toContain(instruction);
	});
});
