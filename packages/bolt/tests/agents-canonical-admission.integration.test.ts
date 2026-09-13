import { afterEach, describe, expect, it } from 'vitest';
import {
	AgentId,
	DirectiveMode,
	DirectivePriority,
	MessageId,
	ConversationId
} from '@norbital-ai/bolt-protocol';
import * as Agents from '../src/runtime/agents/agents.js';
import { userMessageWithImages } from '../src/runtime/agents/image-descriptors.js';
import {
	scriptedTranscript,
	assistantText,
	assistantToolCall
} from './agents-canonical-ai-fixture.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	type BoltTestRuntime
} from './support/bolt-test-layer.js';
import { fileURLToPath } from 'node:url';
import { cassetteTranscript, readCassetteFile } from '@norbital-ai/test-utilities';
import type { AIRequest, AIResponse, FacilityBinding } from '@norbital-ai/bolt-protocol';

const cassette = (name: string) =>
	readCassetteFile(fileURLToPath(new URL(`./assets/${name}.cassette.json`, import.meta.url)));

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

describe('canonical Task admission vertical slice', () => {
	it('admits supported Office documents through the real conversation boundary and refuses executables', async () => {
		const { ai, requests } = scriptedTranscript([
			assistantText('Read DOCX.'),
			assistantText('Read XLSX.')
		]);
		harness = await makeBoltTestRuntime(undefined, { ai });
		const agents = await harness.runtime.runPromise(Agents.Service);
		const formats = [
			['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
			['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']
		] as const;
		for (const [index, [extension, mimeType]] of formats.entries()) {
			const conversationId = ConversationId.make(`00000000-0000-4000-8000-00000000030${index}`);
			const file = {
				name: `check.${extension}`,
				key: Agents.conversationAssetStorageKey(conversationId, 'office', `check.${extension}`),
				mimeType,
				size: 1024
			};
			await harness.runtime.runPromise(
				agents.submit(harness.effectId(`office-${index}`), adminSubject, {
					conversationId,
					agentId: AgentId.make('web'),
					message: userMessageWithImages('Read the attached acceptance document.', [file]),
					mode: DirectiveMode.make('agent'),
					priority: DirectivePriority.make('normal')
				})
			);
			expect(
				(
					await harness.runtime.runPromise(
						agents.execute(harness.effectId(`office-run-${index}`), adminSubject, conversationId)
					)
				).status
			).toBe('done');
			expect(requests[index]?.fileAssets).toEqual([file]);
			expect(requests[index]?.imageAssets ?? []).toEqual([]);
		}
		const conversationId = ConversationId.make('00000000-0000-4000-8000-000000000309');
		await harness.runtime.runPromise(
			agents.submit(harness.effectId('executable'), adminSubject, {
				conversationId,
				agentId: AgentId.make('web'),
				message: userMessageWithImages('Run this', [
					{
						name: 'check.exe',
						key: Agents.conversationAssetStorageKey(conversationId, 'binary', 'check.exe'),
						mimeType: 'application/x-msdownload',
						size: 1024
					}
				]),
				mode: DirectiveMode.make('agent'),
				priority: DirectivePriority.make('normal')
			})
		);
		await expect(
			harness.runtime.runPromise(
				agents.execute(harness.effectId('executable-run'), adminSubject, conversationId)
			)
		).rejects.toThrow('outside this conversation or malformed');
		expect(requests).toHaveLength(2);
	});

	it('retains messages queued while a provider is working and answers them in the same conversation', async () => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const twin = cassetteTranscript(cassette('agents-admission-queue'));
		const prompts: unknown[] = twin.requests as unknown[];
		let held = false;
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: (metadata, request, signal, onProgress) => {
				if (request._tag === 'Generate' && !held) {
					held = true;
					started.resolve();
					return release.promise.then(() => twin.ai.call(metadata, request, signal, onProgress));
				}
				return twin.ai.call(metadata, request, signal, onProgress);
			}
		};
		harness = await makeBoltTestRuntime(undefined, { ai });
		const agents = await harness.runtime.runPromise(Agents.Service);
		const conversationId = ConversationId.make('00000000-0000-4000-8000-000000000120');
		const submit = (text: string) =>
			harness!.runtime.runPromise(
				agents.submit(harness!.effectId(text), adminSubject, {
					conversationId,
					agentId: AgentId.make('web'),
					message: Agents.userAgentInput(text),
					mode: DirectiveMode.make('agent'),
					priority: DirectivePriority.make('normal')
				})
			);
		await submit('Initial instruction');
		expect(
			await harness.database.query('select title from conversation where id = $1', [conversationId])
		).toEqual([{ title: 'Initial instruction' }]);
		const running = harness.runtime.runPromise(
			agents.execute(harness.effectId('first-run'), adminSubject, conversationId)
		);
		await started.promise;
		try {
			await submit('Queued during generation');
		} finally {
			release.resolve();
		}
		await running;
		await harness.runtime.runPromise(
			agents.execute(harness.effectId('next-run'), adminSubject, conversationId)
		);
		expect(prompts).toHaveLength(2);
		expect(
			await harness.database.query('select title from conversation where id = $1', [conversationId])
		).toEqual([{ title: 'Initial instruction' }]);
		expect(JSON.stringify(prompts[1])).toContain('Queued during generation');
		expect(
			await harness.database.query(
				'select state from conversation_message where conversation_id = $1 and state is not null order by sequence',
				[conversationId]
			)
		).toEqual([{ state: 'consumed' }, { state: 'consumed' }]);
		expect(
			await harness.database.query(
				'select count(*)::int as count from conversation_message where conversation_id = $1',
				[conversationId]
			)
		).toEqual([{ count: 4 }]);
	});

	it('separates intentional repeated messages while retaining retry idempotency', async () => {
		harness = await makeBoltTestRuntime(undefined, {
			ai: cassetteTranscript(cassette('agents-admission-hello')).ai
		});
		const agents = await harness.runtime.runPromise(Agents.Service);
		const conversationId = ConversationId.make('00000000-0000-4000-8000-000000000110');
		const request = {
			conversationId,
			agentId: AgentId.make('web'),
			message: Agents.userAgentInput('hi'),
			mode: DirectiveMode.make('agent'),
			priority: DirectivePriority.make('normal'),
			submissionId: MessageId.make('00000000-0000-4000-8000-000000000111')
		};
		const first = await harness.runtime.runPromise(
			agents.submit(harness.effectId('send'), adminSubject, request)
		);
		await harness.runtime.runPromise(
			agents.execute(harness.effectId('execute'), adminSubject, conversationId)
		);
		const retry = await harness.runtime.runPromise(
			agents.submit(harness.effectId('retry'), adminSubject, request)
		);
		expect(retry).toEqual(first);
		const next = {
			...request,
			submissionId: MessageId.make('00000000-0000-4000-8000-000000000112')
		};
		const second = await harness.runtime.runPromise(
			agents.submit(harness.effectId('send-again'), adminSubject, next)
		);
		expect(second.messageId).not.toEqual(first.messageId);
		await expect(
			harness.runtime.runPromise(
				agents.submit(harness.effectId('changed-retry'), adminSubject, {
					...next,
					message: Agents.userAgentInput('changed')
				})
			)
		).rejects.toThrow(/submission ID/);
		await harness.runtime.runPromise(
			agents.execute(harness.effectId('execute-again'), adminSubject, conversationId)
		);
		expect(
			await harness.database.query(
				'select count(*)::int as count from conversation_message where conversation_id = $1',
				[conversationId]
			)
		).toEqual([{ count: 4 }]);
	});

	it('continues a completed conversation with its previous transcript and queues further instructions', async () => {
		const twin3 = cassetteTranscript(cassette('agents-admission-continue'));
		const prompts: unknown[] = twin3.requests as unknown[];
		harness = await makeBoltTestRuntime(undefined, { ai: twin3.ai });
		const agents = await harness.runtime.runPromise(Agents.Service);
		const conversationId = ConversationId.make('00000000-0000-4000-8000-000000000109');
		const submit = (key: string, text: string) =>
			harness!.runtime.runPromise(
				agents.submit(harness!.effectId(key), adminSubject, {
					conversationId,
					agentId: AgentId.make('web'),
					message: Agents.userAgentInput(text),
					mode: DirectiveMode.make('agent'),
					priority: DirectivePriority.make('normal')
				})
			);
		await submit('initial', 'Remember reference amber');
		await harness.runtime.runPromise(
			agents.execute(harness.effectId('first'), adminSubject, conversationId)
		);
		const original = await harness.database.query(
			'select * from conversation_message where conversation_id = $1 order by sequence',
			[conversationId]
		);
		await submit('followup', 'Continue using that reference');
		await submit('queued', 'Also include the next instruction');
		await harness.runtime.runPromise(
			agents.execute(harness.effectId('second'), adminSubject, conversationId)
		);
		expect(JSON.stringify(prompts.at(-1))).toContain('Remember reference amber');
		expect(JSON.stringify(prompts.at(-1))).toContain('Reply 1');
		expect(JSON.stringify(prompts.at(-1))).not.toContain('Also include the next instruction');
		await harness.runtime.runPromise(
			agents.execute(harness.effectId('execute:queued-follow-up'), adminSubject, conversationId)
		);
		expect(JSON.stringify(prompts.at(-1))).toContain('Also include the next instruction');
		expect(
			await harness.database.query(
				'select * from conversation_message where conversation_id = $1 and sequence <= 2 order by sequence',
				[conversationId]
			)
		).toEqual(original);
		expect(
			await harness.database.query(
				'select count(*)::int as count from conversation where id = $1',
				[conversationId]
			)
		).toEqual([{ count: 1 }]);
		expect(
			await harness.database.query(
				'select status from turn where conversation_id = $1 order by created_at',
				[conversationId]
			)
		).toEqual([{ status: 'succeeded' }, { status: 'succeeded' }, { status: 'succeeded' }]);
	});

	it('admits one queued message and mints no work occurrence for it', async () => {
		harness = await makeBoltTestRuntime(undefined, {
			ai: cassetteTranscript(cassette('agents-admission-hello')).ai
		});
		const agents = await harness.runtime.runPromise(Agents.Service);
		const conversationId = ConversationId.make('00000000-0000-4000-8000-000000000101');
		const request = {
			conversationId,
			agentId: AgentId.make('web'),
			message: Agents.userAgentInput('Hello'),
			mode: DirectiveMode.make('agent'),
			priority: DirectivePriority.make('normal')
		};

		const admitted = await harness.runtime.runPromise(
			agents.submit(harness.effectId('task-submit'), adminSubject, request)
		);
		expect(admitted.messageId).toEqual(expect.any(String));
		expect(
			await harness.database.query(
				`select
					(select count(*)::int from conversation where id = $1) as tasks,
					(select count(*)::int from conversation_message where conversation_id = $1) as messages,
					(select count(*)::int from conversation_message where conversation_id = $1 and state is not null) as directives,
					(select count(*)::int from turn where conversation_id = $1) as runs`,
				[conversationId]
			)
		).toEqual([{ tasks: 1, messages: 1, directives: 1, runs: 0 }]);
		// Admitting a message mints no work occurrence. A conversation is not a task, and the caller
		// that admits the message is the caller that answers it.
		expect(
			await harness.database.query(
				`select command from bolt_task where input->>'conversationId' = $1`,
				[conversationId]
			)
		).toEqual([]);
		expect(
			await harness.database.query(
				`select task.status, message.message->>'role' as role,
					inbox.state, inbox.turn_id as turn_id
				 from conversation task
				 join conversation_message message on message.conversation_id = task.id
				 join conversation_message inbox on inbox.conversation_id = task.id and inbox.state is not null
				 where task.id = $1`,
				[conversationId]
			)
		).toEqual([{ status: 'ready', role: 'user', state: 'queued', turn_id: null }]);

		const executed = await harness.runtime.runPromise(
			agents.execute(harness.effectId('task-execute'), adminSubject, conversationId)
		);
		expect(executed).toMatchObject({ conversationId, status: 'done' });
		expect(JSON.stringify(executed.output)).toContain('Hello back.');
		expect(
			await harness.database.query(
				`select task.status, inbox.state, run.status as run_status,
					count(message.id)::int as messages
				 from conversation task
				 join conversation_message inbox on inbox.conversation_id = task.id and inbox.state is not null
				 join turn run on run.conversation_id = task.id
				 join conversation_message message on message.conversation_id = task.id
				 where task.id = $1
				 group by task.status, inbox.state, run.status`,
				[conversationId]
			)
		).toEqual([{ status: 'done', state: 'consumed', run_status: 'succeeded', messages: 2 }]);
	});

	it('persists an explicit Plan edit as a draft revision and leaves the Task ready', async () => {
		harness = await makeBoltTestRuntime(undefined, {
			ai: scriptedTranscript([
				assistantToolCall(
					'update_plan',
					{
						operation: 'replace',
						expectedRevision: 0,
						body: 'Plan the clean migration and verify it.'
					},
					'plan'
				),
				assistantText('Draft ready.')
			]).ai
		});
		const agents = await harness.runtime.runPromise(Agents.Service);
		const conversationId = ConversationId.make('00000000-0000-4000-8000-000000000102');
		await harness.runtime.runPromise(
			agents.submit(harness.effectId('plan-submit'), adminSubject, {
				conversationId,
				agentId: AgentId.make('web'),
				message: Agents.userAgentInput('Plan the clean migration.'),
				mode: DirectiveMode.make('plan'),
				priority: DirectivePriority.make('normal')
			})
		);
		const result = await harness.runtime.runPromise(
			agents.execute(harness.effectId('plan-execute'), adminSubject, conversationId)
		);
		expect(result.status).toBe('idle');
		expect(
			await harness.database.query(
				`select task.status, plan.revision, plan.status as plan_status,
					run.mode, run.phase, run.status as run_status, inbox.state
				 from conversation task
				 join plan plan on plan.id = task.active_plan_id
				 join turn run on run.conversation_id = task.id
				 join conversation_message inbox on inbox.conversation_id = task.id and inbox.state is not null
				 where task.id = $1`,
				[conversationId]
			)
		).toEqual([
			{
				status: 'ready',
				revision: 1,
				plan_status: 'draft',
				mode: 'plan',
				phase: 'model',
				run_status: 'succeeded',
				state: 'consumed'
			}
		]);
	});
});
