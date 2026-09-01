import { Schema } from 'effect';
import { Prompt } from 'effect/unstable/ai';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { ExactCharge } from '@norbital-ai/bolt-protocol/facilities';
import { SYSTEM_COLLECTION_MODELS } from '../../src/authoring/system-models.js';
import {
	AgentMessageRow,
	AgentPlanRow,
	AgentRunRow,
	AgentTaskRow,
	AgentUsageRow,
	type AgentMessage
} from '../../src/runtime/agents/agents.js';
import { SYSTEM_RELATIONSHIPS } from '../../src/runtime/schema/system-collections.js';

/**
 * The durable shape of the six agent collections: their columns, the rows that decode against them,
 * and the routes that join them.
 *
 * The message column holds an Effect `Prompt.MessageEncoded` verbatim rather than a Bolt rendering
 * of one, and a usage row records an exact integer charge rather than a float, so both are asserted
 * by round-tripping a real value through the schema instead of by naming the columns twice.
 */

const durableIds = {
	task: '00000000-0000-4000-8000-000000000001',
	plan: '00000000-0000-4000-8000-000000000002',
	message: '00000000-0000-4000-8000-000000000003',
	directive: '00000000-0000-4000-8000-000000000004',
	run: '00000000-0000-4000-8000-000000000005'
} as const;

const encodedMessage: Prompt.MessageEncoded = {
	role: 'assistant',
	content: 'The durable answer.',
	options: {}
};

describe('Effect AI durable contract', () => {
	it('declares exactly the six RFC agent collections and fields', () => {
		expect(
			Object.keys(SYSTEM_COLLECTION_MODELS)
				.filter((name) => name.startsWith('agent_'))
				.toSorted()
		).toEqual([
			'agent_inbox',
			'agent_message',
			'agent_plan',
			'agent_run',
			'agent_task',
			'agent_usage'
		]);
		expect(Object.keys(SYSTEM_COLLECTION_MODELS.agent_task.columns)).toEqual([
			'workbench_id',
			'subject_id',
			'agent_id',
			'audience',
			'parent_id',
			'status',
			'active_plan_id',
			'active_run_id',
			'epoch'
		]);
		expect(Object.keys(SYSTEM_COLLECTION_MODELS.agent_plan.columns)).toEqual([
			'task_id',
			'revision',
			'checkpoint_sequence',
			'body',
			'status'
		]);
		expect(Object.keys(SYSTEM_COLLECTION_MODELS.agent_message.columns)).toEqual([
			'task_id',
			'sequence',
			'run_id',
			'author',
			'message',
			'semantic_hash',
			'annotation',
			'supersedes_id'
		]);
		expect(Object.keys(SYSTEM_COLLECTION_MODELS.agent_inbox.columns)).toEqual([
			'task_id',
			'sequence',
			'message_id',
			'mode',
			'priority',
			'state',
			'claimed_run_id'
		]);
		expect(Object.keys(SYSTEM_COLLECTION_MODELS.agent_run.columns)).toEqual([
			'task_id',
			'directive_id',
			'epoch',
			'mode',
			'phase',
			'input_through_sequence',
			'model_id',
			'capability_snapshot',
			'status'
		]);
		expect(Object.keys(SYSTEM_COLLECTION_MODELS.agent_usage.columns)).toEqual([
			'call_id',
			'run_id',
			'provider',
			'model',
			'operation',
			'usage',
			'charge',
			'charge_source',
			'pricing_version',
			'settlement_id',
			'settlement_state'
		]);
	});

	it('stores one complete Effect message row', () => {
		const row = Schema.decodeUnknownSync(AgentMessageRow)({
			id: durableIds.message,
			task_id: durableIds.task,
			sequence: 1,
			run_id: durableIds.run,
			author: { kind: 'agent', id: 'assistant' },
			message: encodedMessage,
			semantic_hash: 'sha256:message'
		});
		const decoded = Schema.decodeUnknownSync(Prompt.Message)(row.message);

		expect(Schema.encodeSync(Prompt.Message)(decoded)).toEqual(encodedMessage);
		expectTypeOf<AgentMessage['message']>().toEqualTypeOf<Prompt.MessageEncoded>();
	});

	it('decodes Task, Plan, directive, and immutable run snapshot boundaries', () => {
		expect(
			Schema.decodeUnknownSync(AgentTaskRow)({
				id: durableIds.task,
				workbench_id: 'workbench-1',
				subject_id: 'subject-1',
				agent_id: 'agent-1',
				audience: 'personal',
				status: 'ready',
				epoch: 0
			}).status
		).toBe('ready');
		expect(
			Schema.decodeUnknownSync(AgentPlanRow)({
				id: durableIds.plan,
				task_id: durableIds.task,
				revision: 1,
				checkpoint_sequence: 0,
				body: 'Objective, approach, and verification contract.',
				status: 'active'
			}).revision
		).toBe(1);
		expect(
			Schema.decodeUnknownSync(AgentRunRow)({
				id: durableIds.run,
				task_id: durableIds.task,
				directive_id: durableIds.directive,
				epoch: 1,
				mode: 'agent',
				phase: 'model',
				input_through_sequence: 2,
				model_id: 'effect-model',
				capability_snapshot: {
					releaseId: 'release-1',
					authorityDigest: 'sha256:authority',
					capabilities: [
						{ id: 'system/todo', kind: 'tool', digest: 'sha256:todo' }
					]
				},
				status: 'running'
			}).capability_snapshot.capabilities[0]?.id
		).toBe('system/todo');
	});

	it('encodes exact integer charge observations without floating totals', () => {
		const charge = Schema.decodeUnknownSync(ExactCharge)({ currency: 'USD', coefficient: '125', scale: 6 });
		const usage = Schema.decodeUnknownSync(AgentUsageRow)({
			id: durableIds.message,
			call_id: 'provider-call-1',
			run_id: durableIds.run,
			provider: 'provider',
			model: 'model',
			operation: 'language',
			usage: {
				inputTokens: { total: 12 },
				outputTokens: { total: 4 }
			},
			charge: Schema.encodeSync(ExactCharge)(charge),
			charge_source: 'provider',
			pricing_version: 'provider-2026-09-01',
			settlement_id: 'ai:provider-call-1',
			settlement_state: 'settled'
		});

		expect(charge.coefficient).toBe(125n);
		expect(usage.charge?.coefficient).toBe('125');
	});

	it('declares parent, Task, message, directive, run, and usage routes', () => {
		const routes = SYSTEM_RELATIONSHIPS.map(({ source, name, target }) =>
			`${source}.${name}->${target}`
		);
		expect(routes).toEqual(
			expect.arrayContaining([
				'agent_task.parentTask->agent_task',
				'agent_task.children->agent_task',
				'agent_task.activePlan->agent_plan',
				'agent_task.activeRun->agent_run',
				'agent_message.task->agent_task',
				'agent_message.supersedes->agent_message',
				'agent_inbox.message->agent_message',
				'agent_run.directive->agent_inbox',
				'agent_run.messages->agent_message',
				'agent_run.usage->agent_usage',
				'agent_usage.run->agent_run'
			])
		);
	});
});
