import { Schema } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentId, DirectiveMode, DirectivePriority, TaskId } from '@norbital-ai/bolt-protocol';
import { policy, workspace } from '../src/authoring/workspace-schema.js';
import * as Agents from '../src/runtime/agents/agents.js';
import { makeBoltTestRuntime, type BoltTestRuntime } from './support/bolt-test-layer.js';
import {
	assistantText,
	assistantToolCalls,
	lastToolFailure,
	scriptedTranscript,
	toolResultFor,
	toolResultsFor
} from './agents-canonical-ai-fixture.js';

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
	ai: ReturnType<typeof scriptedTranscript>['ai'],
	name: string,
	message: string
) => {
	harness = await makeBoltTestRuntime(definition, { ai });
	const agents = await harness.runtime.runPromise(Agents.Service);
	const taskId = TaskId.make(`00000000-0000-4000-8000-000000000a${name}`);
	await harness.runtime.runPromise(
		agents.submit(harness.effectId(`submit:${name}`), subject, {
			taskId,
			agentId: AgentId.make('web'),
			message: Agents.userAgentInput(message),
			mode: DirectiveMode.make('agent'),
			priority: DirectivePriority.make('normal')
		})
	);
	const result = await harness.runtime.runPromise(
		agents.execute(harness.effectId(`execute:${name}`), subject, taskId)
	);
	return { agents, taskId, result };
};

describe('distributed skills and the Todo surface in the loop', () => {
	it('lists and reads only the skills the subject holds, and refuses an unheld skill', async () => {
		const { ai, feed, requests } = scriptedTranscript([
			assistantToolCalls([
				{ name: 'list_skills', input: {} },
				{ name: 'read_skill', input: { name: 'payroll' } },
				{ name: 'read_skill', input: { name: 'secret-handbook' } }
			]),
			assistantText('Skills inventoried.')
		]);
		const { result, taskId } = await runTurn(ai, '01', 'Follow the payroll skill.');
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
			 from agent_run run where run.task_id = $1`,
			[taskId]
		);
		const skills = Schema.decodeUnknownSync(
			Schema.Array(Schema.Struct({ kind: Schema.String, id: Schema.String }))
		)(snapshot[0]?.capabilities).filter(
			(capability: { kind: string }) => capability.kind === 'skill'
		);
		expect(skills).toHaveLength(1);
		expect(feed).toHaveLength(2);
	});

	it('reconciles the Todo list across calls and enforces done-is-terminal and single-doing', async () => {
		const { ai, requests } = scriptedTranscript([
			assistantToolCalls([
				{
					name: 'todo',
					input: {
						items: [
							{ id: 'inspect', text: 'Inspect the registry', status: 'done' },
							{ id: 'export', text: 'Export the payroll', status: 'pending' }
						]
					}
				},
				{
					name: 'todo',
					input: {
						items: [
							{ id: 'inspect', text: 'Inspect the registry', status: 'pending' },
							{ id: 'export', text: 'Export the payroll', status: 'doing' }
						]
					}
				},
				{
					name: 'todo',
					input: {
						items: [
							{ id: 'inspect', text: 'Inspect the registry', status: 'done' },
							{ id: 'export', text: 'Export the payroll', status: 'doing' },
							{ id: 'notify', text: 'Notify finance', status: 'doing' }
						]
					}
				},
				{
					name: 'todo',
					input: {
						items: [
							{ id: 'inspect', text: 'Inspect the registry', status: 'done' },
							{ id: 'export', text: 'Export the payroll', status: 'doing' }
						]
					}
				}
			]),
			assistantText('Todo reconciled.')
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
