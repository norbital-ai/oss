import { Schema } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { AgentId, DirectiveMode, DirectivePriority, ConversationId } from '@norbital-ai/bolt-protocol';
import { policy, workspace } from '../src/authoring/workspace-schema.js';
import * as Agents from '../src/runtime/agents/agents.js';
import { makeBoltTestRuntime, type BoltTestRuntime } from './support/bolt-test-layer.js';
import { cassetteTranscript, readCassetteFile } from '@norbital-ai/test-utilities';
import { Prompt } from 'effect/unstable/ai';
import { scriptedTranscript } from './agents-canonical-ai-fixture.js';
import { lastToolFailure, toolResultFor, toolResultsFor } from './agents-canonical-ai-fixture.js';

const cassette = (name: string) =>
	readCassetteFile(fileURLToPath(new URL(`./assets/${name}.cassette.json`, import.meta.url)));

const subject = {
	userId: 'operator-1',
	tenantId: 'test-tenant',
	teamPath: ['operator'],
	policies: []
};

const definition = workspace({
	name: 'skilled-operations',
	version: '1.0.0',
	collections: [],
	apps: [],
	policies: [
		policy({
			name: 'operator',
			effect: 'allow',
			actions: ['agent'],
			capabilities: { apps: ['*'], skills: ['payroll'] }
		})
	],
	teams: { operator: ['operator'] },
	automations: [],
	envoys: [],
	integrations: [],
	prompt: 'You are the skilled operations agent.',
	tools: [],
	skills: [
		{ name: 'payroll', body: '# Payroll\n\nUse the approved workflow.' },
		{ name: 'secret-handbook', body: '# Secrets\n\nNever distributed.' }
	],
	requiredFacilities: []
});

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

const runTurn = async (
	ai: ReturnType<typeof cassetteTranscript>['ai'],
	name: string,
	message: string
) => {
	harness = await makeBoltTestRuntime(definition, { ai });
	const agents = await harness.runtime.runPromise(Agents.Service);
	const conversationId = ConversationId.make(`00000000-0000-4000-8000-000000000a${name}`);
	await harness.runtime.runPromise(
		agents.submit(harness.effectId(`submit:${name}`), subject, {
			conversationId,
			agentId: AgentId.make('web'),
			message: Agents.userAgentInput(message),
			mode: DirectiveMode.make('agent'),
			priority: DirectivePriority.make('normal')
		})
	);
	const result = await harness.runtime.runPromise(
		agents.execute(harness.effectId(`execute:${name}`), subject, conversationId)
	);
	return { agents, conversationId, result };
};

describe('distributed skills and the Todo surface in the loop', () => {
	it('lists and reads only the skills the subject holds, and refuses an unheld skill', async () => {
		const { ai, feed, requests } = cassetteTranscript(cassette('agents-skills-01'));
		const { result, conversationId } = await runTurn(ai, '01', 'Follow the payroll skill.');
		expect(result.status).toBe('done');

		const second = requests[1]!;
		expect(toolResultFor(second, 'list_skills')).toEqual({ skills: ['payroll'] });
		expect(toolResultsFor(second, 'read_skill')[0]).toEqual({
			name: 'payroll',
			body: '# Payroll\n\nUse the approved workflow.'
		});
		const refusal = lastToolFailure(second);
		expect(refusal?.name).toBe('read_skill');
		expect(refusal?.failure).toMatchObject({
			code: 'Bolt.CapabilityCatalog.SkillError'
		});
		expect(String(refusal?.failure.message)).toContain('secret-handbook');
		expect(String(refusal?.failure.message)).toContain('missing');

		// The capability snapshot carries only the granted skill's digest.
		const snapshot = await harness!.database.query(
			`select run.capability_snapshot->'capabilities' as capabilities
			 from turn run where run.conversation_id = $1`,
			[conversationId]
		);
		const skills = Schema.decodeUnknownSync(
			Schema.Array(Schema.Struct({ kind: Schema.String, id: Schema.String }))
		)(snapshot[0]?.capabilities).filter(
			(capability: { kind: string }) => capability.kind === 'skill'
		);
		expect(skills).toHaveLength(1);
		expect(feed).toHaveLength(2);
	});

	/**
	 * The list is stored on the conversation, not recovered by scanning the transcript.
	 *
	 * That is the whole point of the change: a `read` answers what is stored, a later turn sees what
	 * an earlier one set, and the panel reads the same row rather than running a second scanner that
	 * has to agree with the runtime's by hand.
	 */
	it('stores the list on the conversation, and reads it back in a later turn', async () => {
		const encode = Schema.encodeSync(Prompt.Message);
		const items = [{ id: 'export', text: 'Export the payroll', status: 'doing' }];
		const { ai } = scriptedTranscript([
			encode(
				Prompt.assistantMessage({
					content: [
						Prompt.toolCallPart({
							id: 'set-1',
							name: 'todo',
							params: { operation: 'set', items },
							providerExecuted: false
						})
					]
				})
			),
			encode(Prompt.assistantMessage({ content: [Prompt.textPart({ text: 'Set.' })] })),
			encode(
				Prompt.assistantMessage({
					content: [
						Prompt.toolCallPart({
							id: 'read-1',
							name: 'todo',
							params: { operation: 'read' },
							providerExecuted: false
						})
					]
				})
			),
			encode(Prompt.assistantMessage({ content: [Prompt.textPart({ text: 'Read.' })] }))
		]);
		const { conversationId, agents } = await runTurn(ai, '03', 'Track the export.');

		// The row holds it, so nothing has to walk the transcript to find it.
		expect(
			await harness!.database.query('select todos from conversation where id = $1', [conversationId])
		).toEqual([{ todos: { items } }]);

		// And a second turn reads back exactly that.
		await harness!.runtime.runPromise(
			agents.submit(harness!.effectId('todo:stored:second'), subject, {
				conversationId,
				agentId: AgentId.make('web'),
				message: Agents.userAgentInput('What is left?'),
				mode: DirectiveMode.make('agent'),
				priority: DirectivePriority.make('normal')
			})
		);
		await harness!.runtime.runPromise(
			agents.execute(harness!.effectId('todo:stored:second-run'), subject, conversationId)
		);
		// The second turn only read, so the stored list is untouched and still the one the first set.
		expect(
			await harness!.database.query('select todos from conversation where id = $1', [conversationId])
		).toEqual([{ todos: { items } }]);
	});

	it('reconciles the Todo list across calls and enforces done-is-terminal and single-doing', async () => {
		/**
		 * The calls are authored here, not replayed from a recording.
		 *
		 * A cassette is a record of what a provider said when shown a prompt, and this tool's schema
		 * changed — `todo` now takes an `operation`, so the recorded arguments describe a contract that
		 * no longer exists. Editing the recording to add the field would be inventing a model response;
		 * what this row actually asserts is our own reconciliation rules, and those are ours to write.
		 */
		const todoCall = (id: string, items: ReadonlyArray<Record<string, string>>) =>
			Prompt.toolCallPart({
				id,
				name: 'todo',
				params: { operation: 'set', items },
				providerExecuted: false
			});
		const inspect = (status: string) => ({ id: 'inspect', text: 'Inspect the registry', status });
		const exportPayroll = (status: string) => ({ id: 'export', text: 'Export the payroll', status });
		const encode = Schema.encodeSync(Prompt.Message);
		const { ai, requests } = scriptedTranscript([
			encode(
				Prompt.assistantMessage({
					content: [
						todoCall('call-1', [inspect('done'), exportPayroll('pending')]),
						// Reopening a done item is refused.
						todoCall('call-2', [inspect('pending'), exportPayroll('doing')]),
						// Two `doing` at once is refused.
						todoCall('call-3', [
							inspect('done'),
							exportPayroll('doing'),
							{ id: 'notify', text: 'Notify finance', status: 'doing' }
						]),
						todoCall('call-4', [inspect('done'), exportPayroll('doing')])
					]
				})
			),
			encode(Prompt.assistantMessage({ content: [Prompt.textPart({ text: 'Todo reconciled.' })] }))
		]);
		const { result } = await runTurn(ai, '02', 'Track the export work.');
		expect(result.status).toBe('done');

		const final = requests[1]!;
		const todos = toolResultsFor(final, 'todo');
		expect(todos).toHaveLength(4);
		expect(todos[0]).toEqual({
			items: [
				{ id: 'inspect', text: 'Inspect the registry', status: 'done' },
				{ id: 'export', text: 'Export the payroll', status: 'pending' }
			]
		});
		// done-is-terminal: the completed item cannot go back to pending.
		expect(todos[1]).toMatchObject({ code: 'Bolt.CapabilityCatalog.ToolNotAllowed' });
		expect(String((todos[1] as { message: string }).message)).toContain('todo:done-is-terminal');
		// single-doing: two doing items in one list are refused.
		expect(String((todos[2] as { message: string }).message)).toContain('todo:multiple-doing');
		// The valid progression is echoed back with the terminal item preserved.
		expect(todos[3]).toEqual({
			items: [
				{ id: 'inspect', text: 'Inspect the registry', status: 'done' },
				{ id: 'export', text: 'Export the payroll', status: 'doing' }
			]
		});
	});
});
