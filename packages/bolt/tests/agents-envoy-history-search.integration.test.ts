import { Effect } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import { ConversationId } from '@norbital-ai/bolt-protocol';
import * as Collections from '../src/runtime/collections/collections.js';
import { HostTools } from '../src/runtime/facilities/services.js';
import * as Agents from '../src/runtime/agents/agents.js';
import { executeSystemTool } from '../src/runtime/agents/capability-catalog.js';
import * as Workspace from '../src/runtime/workspace.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	type BoltTestRuntime
} from './support/bolt-test-layer.js';

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

const insertTask = async (
	runtime: BoltTestRuntime,
	conversationId: ConversationId,
	workbenchId: string,
	agentId: string,
	audience: 'personal' | 'workbench'
) => {
	await runtime.database.query(
		`insert into conversation
		 (id, workbench_id, subject_id, agent_id, audience, status)
		 values ($1, $2, $3, $4, $5, 'ready')`,
		[conversationId, workbenchId, adminSubject.userId, agentId, audience]
	);
};

const insertMessage = async (
	runtime: BoltTestRuntime,
	messageId: string,
	conversationId: ConversationId,
	sequence: number,
	text: string
) => {
	await runtime.database.query(
		`insert into conversation_message
		 (id, conversation_id, sequence, author, message, semantic_hash)
		 values ($1, $2, $3, $4, $5, $6)`,
		[
			messageId,
			conversationId,
			sequence,
			{ kind: 'human', id: adminSubject.userId },
			Agents.userAgentInput(text),
			`hash:${messageId}`
		]
	);
};

describe('Task history search scope', () => {
	it('defaults to one Task and expands only to Tasks in the same workbench', async () => {
		harness = await makeBoltTestRuntime();
		const firstTask = ConversationId.make('00000000-0000-4000-8000-000000000701');
		const secondTask = ConversationId.make('00000000-0000-4000-8000-000000000702');
		await insertTask(harness, firstTask, 'field-workbench', 'desk', 'workbench');
		await insertTask(harness, secondTask, 'field-workbench', 'desk', 'workbench');
		await insertMessage(
			harness,
			'00000000-0000-4000-8000-000000000711',
			firstTask,
			1,
			'first marker'
		);
		await insertMessage(
			harness,
			'00000000-0000-4000-8000-000000000712',
			secondTask,
			1,
			'second marker'
		);

		const run = (input: Parameters<typeof executeSystemTool>[1]) =>
			harness!.runtime.runPromise(
				Effect.gen(function* () {
					const workspace = yield* Workspace.Service;
					const collections = yield* Collections.Service;
					const hostTools = yield* HostTools.Service;
					return yield* executeSystemTool('search_task_history', input, {
						effectId: harness!.effectId('history:search'),
						subject: adminSubject,
						agentId: 'desk',
						conversationId: firstTask,
						workbenchId: 'field-workbench',
						skills: [],
						toolNames: ['search_task_history'],
						collectionNames: [],
						readableCollectionNames: [],
						writableCollectionNames: [],
						workspace,
						collections,
						hostTools
					});
				})
			);

		const local = (await run({})) as { readonly messages: ReadonlyArray<unknown> };
		expect(JSON.stringify(local.messages)).toContain('first marker');
		expect(JSON.stringify(local.messages)).not.toContain('second marker');

		const workbench = (await run({
			scope: 'workbench',
			query: 'second marker',
			limit: 1
		})) as { readonly messages: ReadonlyArray<unknown> };
		expect(JSON.stringify(workbench.messages)).toContain('second marker');
		expect(JSON.stringify(workbench.messages)).not.toContain('first marker');
	});

	it('searches every complete Effect message persisted for one Task', async () => {
		harness = await makeBoltTestRuntime();
		const conversationId = ConversationId.make('00000000-0000-4000-8000-000000000703');
		await insertTask(harness, conversationId, conversationId, 'web', 'personal');
		await insertMessage(
			harness,
			'00000000-0000-4000-8000-000000000713',
			conversationId,
			1,
			'older searchable marker'
		);
		await insertMessage(
			harness,
			'00000000-0000-4000-8000-000000000714',
			conversationId,
			2,
			'incoming queued marker'
		);

		const result = await harness.runtime.runPromise(
			Effect.gen(function* () {
				const workspace = yield* Workspace.Service;
				const collections = yield* Collections.Service;
				const hostTools = yield* HostTools.Service;
				return yield* executeSystemTool(
					'search_task_history',
					{ limit: 50, query: 'marker' },
					{
						effectId: harness!.effectId('history:web'),
						subject: adminSubject,
						agentId: 'web',
						conversationId,
						workbenchId: conversationId,
						skills: [],
						toolNames: ['search_task_history'],
						collectionNames: [],
						readableCollectionNames: [],
						writableCollectionNames: [],
						workspace,
						collections,
						hostTools
					}
				);
			})
		);
		expect(JSON.stringify(result)).toContain('older searchable marker');
		expect(JSON.stringify(result)).toContain('incoming queued marker');
	});
});
