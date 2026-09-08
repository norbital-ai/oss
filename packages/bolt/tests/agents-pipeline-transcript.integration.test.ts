import { afterEach, describe, expect, it } from 'vitest';
import { AgentId, DirectiveMode, DirectivePriority, ConversationId } from '@norbital-ai/bolt-protocol';
import { systemToolSpecs } from '../src/runtime/agents/capability-catalog.js';
import * as Agents from '../src/runtime/agents/agents.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	testWorkspace,
	type BoltTestRuntime
} from './support/bolt-test-layer.js';
import { fileURLToPath } from 'node:url';
import { cassetteTranscript, readCassetteFile } from '@norbital-ai/test-utilities';
import { lastToolResult, toolResultFor } from './agents-canonical-ai-fixture.js';

const cassette = (name: string) =>
	readCassetteFile(fileURLToPath(new URL(`./assets/${name}.cassette.json`, import.meta.url)));

const SYSTEM_TOOLS = systemToolSpecs.map(({ name }) => name);
/**
 * A model small enough for one large instruction to fill, and an instruction that fills it.
 *
 * Compaction is a fraction of the model's own context window now, not a fixed byte count, so a
 * suite that wants to see it states a small window rather than a large prompt. 64 KiB of prose is
 * roughly 16k tokens at the estimator's four-bytes-to-the-token; a 20k window puts the bound at 15k,
 * which this clears and an ordinary turn does not come close to.
 */
const SMALL_CONTEXT_WINDOW_TOKENS = 20_000;
const LARGE_INSTRUCTION = `Pipeline stress ${'x'.repeat(64 * 1_024)}`;

const PERSON_ID = '00000000-0000-4000-8000-000000000401';
const TOOL_TASK_ID = ConversationId.make('00000000-0000-4000-8000-000000000401');
const IMAGE_KEY = Agents.conversationAssetStorageKey(TOOL_TASK_ID, 'badge', 'badge.png');

const workspace = testWorkspace({
	skills: [{ name: 'payroll', body: '# Payroll\n\nUse the approved workflow.' }]
});

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

const openTask = async (
	ai: ReturnType<typeof cassetteTranscript>['ai'],
	name: string,
	mode: 'agent' | 'plan' | 'compact',
	message: string
) => {
	harness = await makeBoltTestRuntime(workspace, { ai });
	const agents = await harness.runtime.runPromise(Agents.Service);
	const conversationId = ConversationId.make(`00000000-0000-4000-8000-0000000004${name}`);
	await harness.runtime.runPromise(
		agents.submit(harness.effectId(`submit:${name}`), adminSubject, {
			conversationId,
			agentId: AgentId.make('web'),
			message: Agents.userAgentInput(message),
			mode: DirectiveMode.make(mode),
			priority: DirectivePriority.make('normal')
		})
	);
	return { agents, conversationId };
};

const runTask = async (
	ai: ReturnType<typeof cassetteTranscript>['ai'],
	name: string,
	mode: 'agent' | 'plan' | 'compact',
	message: string
) => {
	const { agents, conversationId } = await openTask(ai, name, mode, message);
	const result = await harness!.runtime.runPromise(
		agents.execute(harness!.effectId(`execute:${name}`), adminSubject, conversationId)
	);
	return { result, conversationId, agents };
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
			'compact',
			'describe_workspace',
			'list_skills',
			'read_skill',
			'search_task_history',
			'use_image',
			'read_collection',
			'write_collection'
		]);
		const { ai, feed, requests } = cassetteTranscript(cassette('agents-pipe-system'));
		const { result, conversationId } = await runTask(ai, '01', 'agent', 'Exercise every system tool.');
		expect(result.status).toBe('done');
		/**
		 * Every system tool the recording exercised, which is every one except `compact`.
		 *
		 * The cassette is an account of what a provider said when shown a prompt, and `compact` did
		 * not exist when it was recorded. Adding a call to it would be inventing a model response;
		 * what the offered set contains is asserted below, and `compact`'s own behaviour has its own
		 * suite, because it is the one system tool whose effect lands in the loop rather than in a
		 * tool result.
		 */
		expect(toolNamesFrom(requests[1]!).toSorted()).toEqual(
			SYSTEM_TOOLS.filter((name) => name !== 'compact').toSorted()
		);
		expect(lastToolResult(requests[1]!)).toMatchObject({
			key: IMAGE_KEY,
			name: 'badge.png',
			mimeType: 'image/png'
		});
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
			 from conversation_message where conversation_id = $1 order by sequence`,
			[conversationId]
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

	it('kicks in Automatic Compact in agent mode when the context nears the model window', async () => {
		const { ai, feed, requests } = cassetteTranscript(
			cassette('agents-pipe-compact'),
			SMALL_CONTEXT_WINDOW_TOKENS
		);
		const { result, conversationId } = await runTask(ai, '02', 'agent', LARGE_INSTRUCTION);
		expect(result.status).toBe('done');
		expect(feed[0]).toMatchObject({
			automaticCompact: true,
			planMode: false,
			maxOutputTokens: 1_536
		});
		expect(feed[0]?.promptBytes).toBeGreaterThan(64 * 1_024);
		expect(feed[1]).toMatchObject({ automaticCompact: false, planMode: false });
		expect(JSON.stringify(requests[1]?.messages)).toContain(
			'Retained: the current user instruction, open decisions, and unresolved work.'
		);
		expect(feed).toHaveLength(2);
		const compact = await harness!.database.query(
			`select annotation->>'tag' as tag, annotation->>'origin' as origin
			 from conversation_message
			 where conversation_id = $1 and annotation->>'tag' = 'compact'`,
			[conversationId]
		);
		expect(compact).toEqual([{ tag: 'compact', origin: 'automatic' }]);
	});

	it('does not auto-compact in Plan mode; the model is fed the Plan contract', async () => {
		const { ai, feed } = cassetteTranscript(
			cassette('agents-pipe-plan'),
			SMALL_CONTEXT_WINDOW_TOKENS
		);
		const { result, conversationId } = await runTask(ai, '03', 'plan', LARGE_INSTRUCTION);
		expect(result.status).toBe('idle');
		expect(feed).toHaveLength(1);
		expect(feed[0]).toMatchObject({
			automaticCompact: false,
			planMode: true
		});
		expect(feed[0]?.promptBytes).toBeGreaterThan(64 * 1_024);
		expect(
			await harness!.database.query(
				`select plan.status, run.mode
				 from conversation task
				 join plan plan on plan.id = task.active_plan_id
				 join turn run on run.conversation_id = task.id
				 where task.id = $1`,
				[conversationId]
			)
		).toEqual([{ status: 'active', mode: 'plan' }]);
		expect(
			await harness!.database.query(
				`select count(*)::int as n from conversation_message
				 where conversation_id = $1 and annotation->>'origin' = 'automatic'`,
				[conversationId]
			)
		).toEqual([{ n: 0 }]);
	});

	it('Plan mode refuses write_collection and still leaves an active Plan', async () => {
		const { ai, feed, requests } = cassetteTranscript(cassette('agents-pipe-plan-refuse'));
		const { result } = await runTask(ai, '04', 'plan', 'Plan a people write.');
		expect(result.status).toBe('idle');
		expect(JSON.stringify(requests[1]?.messages)).toContain('ToolNotAllowed');
		expect(feed[0]?.planMode).toBe(true);
		expect(feed.every((step) => step.automaticCompact === false)).toBe(true);
		expect(requests).toHaveLength(2);
	});

	it('does not auto-compact on stop; compact waits for the next execute after resume', async () => {
		const { ai, feed } = cassetteTranscript(
			cassette('agents-pipe-stop'),
			SMALL_CONTEXT_WINDOW_TOKENS
		);
		const { agents, conversationId } = await openTask(ai, '05', 'agent', LARGE_INSTRUCTION);
		const stopped = await harness!.runtime.runPromise(
			agents.control(harness!.effectId('stop:05'), adminSubject, { conversationId, action: 'stop' })
		);
		expect(stopped).toEqual({ conversationId, status: 'stopped' });
		expect(feed).toEqual([]);
		expect(
			await harness!.database.query(
				`select count(*)::int as n from conversation_message
				 where conversation_id = $1 and annotation->>'tag' = 'compact'`,
				[conversationId]
			)
		).toEqual([{ n: 0 }]);

		const resumed = await harness!.runtime.runPromise(
			agents.control(harness!.effectId('resume:05'), adminSubject, { conversationId, action: 'resume' })
		);
		expect(resumed).toMatchObject({ conversationId, status: 'ready' });
		const executed = await harness!.runtime.runPromise(
			agents.execute(harness!.effectId('execute:05'), adminSubject, conversationId)
		);
		expect(executed.status).toBe('done');
		expect(feed[0]).toMatchObject({ automaticCompact: true, planMode: false });
		expect(feed[0]?.promptBytes).toBeGreaterThan(64 * 1_024);
		expect(
			await harness!.database.query(
				`select annotation->>'origin' as origin from conversation_message
				 where conversation_id = $1 and annotation->>'tag' = 'compact'`,
				[conversationId]
			)
		).toEqual([{ origin: 'automatic' }]);
	});

	it('treats /goal as an ordinary agent message, not a Plan or Compact mode', async () => {
		const { ai, feed } = cassetteTranscript(cassette('agents-pipe-goal'));
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
		const { ai, feed, requests } = cassetteTranscript(cassette('agents-pipe-plan-agent'));
		const { agents, conversationId } = await openTask(ai, '07', 'plan', brief);
		const planned = await harness!.runtime.runPromise(
			agents.execute(harness!.effectId('execute:07:plan'), adminSubject, conversationId)
		);
		expect(planned.status).toBe('idle');
		expect(feed[0]).toMatchObject({ planMode: true, compactMode: false, automaticCompact: false });
		expect(JSON.stringify(requests[0]?.messages)).toContain(brief);

		await harness!.runtime.runPromise(
			agents.submit(harness!.effectId('submit:07:agent'), adminSubject, {
				conversationId,
				agentId: AgentId.make('web'),
				message: Agents.userAgentInput('Execute the Active Plan.'),
				mode: DirectiveMode.make('agent'),
				priority: DirectivePriority.make('normal')
			})
		);
		const executed = await harness!.runtime.runPromise(
			agents.execute(harness!.effectId('execute:07:agent'), adminSubject, conversationId)
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
		const { ai, feed, requests } = cassetteTranscript(cassette('agents-pipe-compact-agent'));
		const { agents, conversationId } = await openTask(ai, '08', 'compact', instruction);
		const compacted = await harness!.runtime.runPromise(
			agents.execute(harness!.effectId('execute:08:compact'), adminSubject, conversationId)
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
				conversationId,
				agentId: AgentId.make('web'),
				message: Agents.userAgentInput('Continue after Compact.'),
				mode: DirectiveMode.make('agent'),
				priority: DirectivePriority.make('normal')
			})
		);
		const executed = await harness!.runtime.runPromise(
			agents.execute(harness!.effectId('execute:08:agent'), adminSubject, conversationId)
		);
		expect(executed.status).toBe('done');
		expect(feed[1]).toMatchObject({ compactMode: false, automaticCompact: false });
		const agentFeed = JSON.stringify(requests[1]?.messages);
		expect(agentFeed).toContain('Retained: open payroll decisions and the current export work.');
		expect(agentFeed).toContain('Continue after Compact.');
		expect(agentFeed).not.toContain(instruction);
	});
});
