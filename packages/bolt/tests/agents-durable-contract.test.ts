import { Schema } from 'effect';
import { Prompt } from 'effect/unstable/ai';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { ExactCharge } from '@norbital-ai/bolt-protocol/facilities';
import { SYSTEM_COLLECTION_MODELS } from '../src/authoring/system-models.js';
import {
	ConversationMessageRow,
	PlanRow,
	TurnRow,
	ConversationRow,
	TurnUsageRow,
	type ConversationMessage
} from '../src/runtime/agents/agents.js';
import { SYSTEM_RELATIONSHIPS } from '../src/runtime/schema/system-collections.js';

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
	it('declares exactly the five conversation collections and fields', () => {
		expect(
			Object.keys(SYSTEM_COLLECTION_MODELS)
				.filter((name) =>
					['conversation', 'conversation_message', 'turn', 'turn_usage', 'plan'].includes(name)
				)
				.toSorted()
		).toEqual(['conversation', 'conversation_message', 'plan', 'turn', 'turn_usage']);
		// Nothing is called a task any more; the durable work queue keeps that name for itself.
		expect(
			Object.keys(SYSTEM_COLLECTION_MODELS).filter((name) => name.startsWith('agent_'))
		).toEqual([]);
		expect(Object.keys(SYSTEM_COLLECTION_MODELS.conversation.columns)).toEqual([
			'workbench_id',
			'subject_id',
			'agent_id',
			'audience',
			'parent_id',
			'title',
			'status',
			'active_plan_id',
			'active_turn_id',
			// The agent's checklist, stored rather than scanned out of the transcript.
			'todos'
		]);
		expect(Object.keys(SYSTEM_COLLECTION_MODELS.plan.columns)).toEqual([
			'conversation_id',
			'revision',
			'checkpoint_sequence',
			'body',
			'status'
		]);
		expect(Object.keys(SYSTEM_COLLECTION_MODELS.conversation_message.columns)).toEqual([
			'conversation_id',
			'sequence',
			'turn_id',
			'author',
			'message',
			'semantic_hash',
			'annotation',
			'supersedes_id',
			// The message queue, folded onto the message it is about.
			'state',
			'mode',
			'priority',
			'model_id'
		]);
		expect(Object.keys(SYSTEM_COLLECTION_MODELS.turn.columns)).toEqual([
			'conversation_id',
			'input_message_id',
			'mode',
			'phase',
			'input_through_sequence',
			'model_id',
			'context_window_tokens',
			'capability_snapshot',
			'status'
		]);
		expect(Object.keys(SYSTEM_COLLECTION_MODELS.turn_usage.columns)).toEqual([
			'call_id',
			'turn_id',
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
		const row = Schema.decodeUnknownSync(ConversationMessageRow)({
			id: durableIds.message,
			conversation_id: durableIds.task,
			sequence: 1,
			turn_id: durableIds.run,
			author: { kind: 'agent', id: 'assistant' },
			message: encodedMessage,
			semantic_hash: 'sha256:message'
		});
		const decoded = Schema.decodeUnknownSync(Prompt.Message)(row.message);

		expect(Schema.encodeSync(Prompt.Message)(decoded)).toEqual(encodedMessage);
		expectTypeOf<ConversationMessage['message']>().toEqualTypeOf<Prompt.MessageEncoded>();
	});

	it('decodes Task, Plan, directive, and public run metadata boundaries', () => {
		expect(
			Schema.decodeUnknownSync(ConversationRow)({
				row_version: 0,
				id: durableIds.task,
				workbench_id: 'workbench-1',
				subject_id: 'subject-1',
				agent_id: 'agent-1',
				audience: 'personal',
				status: 'ready'
			}).status
		).toBe('ready');
		expect(
			Schema.decodeUnknownSync(PlanRow)({
				id: durableIds.plan,
				conversation_id: durableIds.task,
				revision: 1,
				checkpoint_sequence: 0,
				body: 'Objective, approach, and verification contract.',
				status: 'active'
			}).revision
		).toBe(1);
		expect(
			Schema.decodeUnknownSync(TurnRow)({
				id: durableIds.run,
				conversation_id: durableIds.task,
				input_message_id: durableIds.directive,
				mode: 'agent',
				phase: 'model',
				input_through_sequence: 2,
				context_window_tokens: 1_000_000,
				model_id: 'effect-model',
				status: 'running'
			}).model_id
		).toBe('effect-model');
	});

	it('encodes exact integer charge observations without floating totals', () => {
		const charge = Schema.decodeUnknownSync(ExactCharge)({
			currency: 'USD',
			coefficient: '125',
			scale: 6
		});
		const usage = Schema.decodeUnknownSync(TurnUsageRow)({
			id: durableIds.message,
			call_id: 'provider-call-1',
			turn_id: durableIds.run,
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
		const routes = SYSTEM_RELATIONSHIPS.map(
			({ source, name, target }) => `${source}.${name}->${target}`
		);
		expect(routes).toEqual(
			expect.arrayContaining([
				'conversation.parentTask->conversation',
				'conversation.children->conversation',
				'conversation.activePlan->plan',
				'conversation.activeRun->turn',
				'conversation_message.task->conversation',
				'conversation_message.supersedes->conversation_message',
				'turn.input->conversation_message',
				'turn.messages->conversation_message',
				'turn.usage->turn_usage',
				'turn_usage.run->turn'
			])
		);
	});
});
