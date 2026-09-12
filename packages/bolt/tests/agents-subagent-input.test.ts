import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { AgentId, EffectId, ConversationId } from '@norbital-ai/bolt-protocol';
import { WorkbenchId } from '@norbital-ai/bolt-protocol/facilities';
import { envoy } from '../src/authoring/workspace-schema.js';
import { spawnableAgentIds } from '../src/runtime/agents/agents.js';
import {
	InvalidToolInput,
	SUBAGENT_TOOL_NAME,
	ToolNotAllowed,
	executeSubagentTool,
	executeSystemTool,
	subagentToolSpec,
	type SubagentContext,
	type ToolExecutionContext
} from '../src/runtime/agents/capability-catalog.js';
import * as InvocationBudget from '../src/runtime/budget.js';
import type * as Collections from '../src/runtime/collections/collections.js';
import type * as Identity from '../src/runtime/identity/identity.js';

/**
 * RFC bolt.md B7 / AGENT-SUB1. The `subagent` tool's schema names the agents a spawn may target,
 * so an invented id is a decode failure on `agentId`; and a decode failure of any kind is
 * `InvalidToolInput` with the offending field, never the allow-list refusal `ToolNotAllowed`.
 */
const worker = envoy({
	name: 'worker',
	transport: 'whatsapp',
	audience: 'authenticated',
	policies: ['admin'],
	task: 'Report field status.',
	delegation: 'disabled'
});
const auditor = envoy({
	name: 'auditor',
	transport: 'whatsapp',
	audience: 'authenticated',
	policies: ['admin'],
	task: 'Audit the ledger.',
	delegation: 'disabled'
});

const subject: Identity.Subject = {
	userId: 'admin-1',
	tenantId: 'test-tenant',
	teamPath: ['admin'],
	policies: [],
	admin: true
};

const untouched = () =>
	Effect.die(new Error('the runtime must not be reached on a decode failure'));

const subagentContext = (
	spawnable: ReadonlyArray<string>,
	spawned: Array<{ agentId: string; instruction: string }> = [],
	isChild = false
): SubagentContext => ({
	effectId: EffectId.make('subagent-input'),
	subject,
	workbenchId: WorkbenchId.make('00000000-0000-4000-8000-000000000010'),
	agentId: AgentId.make('web'),
	conversationId: ConversationId.make('00000000-0000-4000-8000-000000000011'),
	isChild,
	spawnableAgentIds: spawnable,
	collections: { findMany: untouched } as unknown as Collections.Interface,
	budget: InvocationBudget.make(0),
	spawn: (_effectId, agentId, instruction) => {
		spawned.push({ agentId, instruction });
		return Effect.succeed({ conversationId: 'child', state: 'running' });
	},
	admit: untouched,
	awaitTarget: untouched,
	control: untouched
});

const systemContext = (): ToolExecutionContext =>
	({
		effectId: EffectId.make('system-input'),
		subject,
		agentId: 'web',
		conversationId: ConversationId.make('00000000-0000-4000-8000-000000000011'),
		workbenchId: '00000000-0000-4000-8000-000000000010',
		skills: [],
		toolNames: [],
		collectionNames: [],
		readableCollectionNames: [],
		writableCollectionNames: [],
		collections: { findMany: untouched } as unknown as Collections.Interface
	}) as unknown as ToolExecutionContext;

const failureOf = <A, E>(effect: Effect.Effect<A, E>): Promise<E> =>
	Effect.runPromise(Effect.flip(effect));

const enumOf = (spawnable: ReadonlyArray<string>): ReadonlyArray<string> | undefined => {
	const schema = subagentToolSpec(spawnable).inputSchema as {
		readonly properties?: { readonly agentId?: { readonly enum?: ReadonlyArray<string> } };
	};
	return schema.properties?.agentId?.enum;
};

describe('subagent tool input (RFC bolt.md B7, AGENT-SUB1)', () => {
	it('lists exactly the workspace envoys plus the web agent as the spawnable ids', () => {
		const ids = spawnableAgentIds({ envoys: [worker, auditor] });
		expect(ids).toEqual(['web', 'worker', 'auditor']);
		expect(enumOf(ids)).toEqual(['web', 'worker', 'auditor']);
		expect(spawnableAgentIds({ envoys: [] })).toEqual(['web']);
		expect(subagentToolSpec(ids).name).toBe(SUBAGENT_TOOL_NAME);
	});

	it('refuses a spawn naming an agent the workspace does not declare as a field error on agentId', async () => {
		const spawned: Array<{ agentId: string; instruction: string }> = [];
		const failure = await failureOf(
			executeSubagentTool(
				{ action: 'spawn', agentId: 'sg-statutory-law-query', instruction: 'Look it up.' },
				subagentContext(['web', 'worker'], spawned),
				'spawn-1'
			)
		);
		expect(failure).toBeInstanceOf(InvalidToolInput);
		expect(failure).not.toBeInstanceOf(ToolNotAllowed);
		const invalid = failure as InvalidToolInput;
		expect(invalid.tool).toBe('subagent');
		expect(invalid.path).toBe('agentId');
		expect(invalid.message).toContain('"worker"');
		expect(invalid.detail).toBe(
			`Invalid input for tool "subagent" at "agentId": ${invalid.message}`
		);
		expect(spawned).toEqual([]);
	});

	it('reports a malformed call with the missing field, never ToolNotAllowed', async () => {
		const context = subagentContext(['web', 'worker']);
		const missingTask = await failureOf(executeSubagentTool({ action: 'read' }, context, 'read-1'));
		expect(missingTask).toBeInstanceOf(InvalidToolInput);
		expect((missingTask as InvalidToolInput).path).toBe('conversationId');

		const missingInstruction = await failureOf(
			executeSubagentTool({ action: 'spawn', agentId: 'worker' }, context, 'spawn-2')
		);
		expect(missingInstruction).toBeInstanceOf(InvalidToolInput);
		expect((missingInstruction as InvalidToolInput).path).toBe('instruction');

		const unknownAction = await failureOf(executeSubagentTool({ action: 'fly' }, context, 'fly-1'));
		expect(unknownAction).toBeInstanceOf(InvalidToolInput);
		expect((unknownAction as InvalidToolInput).path).toBe('');
		expect((unknownAction as InvalidToolInput).detail).toMatch(
			/^Invalid input for tool "subagent": /
		);

		for (const failure of [missingTask, missingInstruction, unknownAction]) {
			expect(failure).not.toBeInstanceOf(ToolNotAllowed);
			expect((failure as InvalidToolInput)._tag).toBe('Bolt.CapabilityCatalog.InvalidToolInput');
		}
	});

	it('hands a well-formed spawn to the runtime with the declared agent', async () => {
		const spawned: Array<{ agentId: string; instruction: string }> = [];
		const result = await Effect.runPromise(
			executeSubagentTool(
				{ action: 'spawn', agentId: 'worker', instruction: 'Report the field status.' },
				subagentContext(['web', 'worker'], spawned),
				'spawn-3'
			)
		);
		expect(result).toEqual({ conversationId: 'child', state: 'running' });
		expect(spawned).toEqual([{ agentId: 'worker', instruction: 'Report the field status.' }]);
	});

	it('refuses a spawn from a child Task: the lineage is exactly one level deep', async () => {
		const spawned: Array<{ agentId: string; instruction: string }> = [];
		const failure = await failureOf(
			executeSubagentTool(
				{ action: 'spawn', agentId: 'worker', instruction: 'Spawn a grandchild.' },
				subagentContext(['web', 'worker'], spawned, true),
				'spawn-child'
			)
		);
		expect(failure).toBeInstanceOf(ToolNotAllowed);
		expect((failure as ToolNotAllowed).tool).toBe('subagent:child-cannot-spawn');
		expect(spawned).toEqual([]);
	});

	it('reports a platform tool decode failure the same way, with a nested path', async () => {
		const missingName = await failureOf(executeSystemTool('read_skill', {}, systemContext()));
		expect(missingName).toBeInstanceOf(InvalidToolInput);
		expect(missingName).not.toBeInstanceOf(ToolNotAllowed);
		expect(missingName as InvalidToolInput).toMatchObject({ tool: 'read_skill', path: 'name' });

		const badItem = await failureOf(
			executeSystemTool(
				'todo',
				{ operation: 'set', items: [{ id: 'a', status: 'pending' }] },
				systemContext()
			)
		);
		expect(badItem).toBeInstanceOf(InvalidToolInput);
		expect(badItem as InvalidToolInput).toMatchObject({ tool: 'todo', path: 'items[0].text' });
	});
});
