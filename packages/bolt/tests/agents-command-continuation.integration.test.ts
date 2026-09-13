import { afterEach, expect, it } from 'vitest';
import { Fiber, Schema } from 'effect';
import * as TaskQueue from '../src/runtime/tasks/tasks.js';
import type {
	AIRequest,
	AIResponse,
	HostScheduleOccurrence,
	HostToolRequest,
	HostToolResponse,
	FacilityBinding
} from '@norbital-ai/bolt-protocol';
import {
	EnvironmentName,
	Invocation,
	InvocationId,
	PROTOCOL_VERSION,
	ReleaseId,
	TenantId
} from '@norbital-ai/bolt-protocol';
import { dispatchInvocation } from '../src/runtime/dispatch.js';
import * as AgentDriver from '../src/runtime/agents/driver.js';
import { userAgentInput } from '../src/runtime/agents/agents.js';
import {
	assistantText,
	assistantToolCall,
	scriptedTranscript
} from './agents-canonical-ai-fixture.js';
import { makeBoltTestRuntime, type BoltTestRuntime } from './support/bolt-test-layer.js';
import { seedSession } from './support/fixture-identity.js';

let harness: BoltTestRuntime | undefined;
let releasePending: (() => void) | undefined;
afterEach(async () => {
	releasePending?.();
	releasePending = undefined;
	await harness?.dispose();
	harness = undefined;
});
const conversationId = '00000000-0000-4000-8000-000000000731';
const sendId = '00000000-0000-4000-8000-000000000732';
let serial = 0;
const command = (name: string, input: Schema.Json) =>
	harness!.runtime.runPromise(
		dispatchInvocation(
			Invocation.cases.Command.make({
				protocolVersion: PROTOCOL_VERSION,
				id: InvocationId.make(`continuation-${++serial}`),
				scope: {
					tenantId: TenantId.make('test-tenant'),
					environment: EnvironmentName.make('development'),
					releaseId: ReleaseId.make('local')
				},
				command: name,
				input,
				headers: { authorization: ['Bearer continuation-token'] }
			})
		)
	);

const taskInvocation = (occurrence: HostScheduleOccurrence) =>
	Invocation.cases.Task.make({
		protocolVersion: PROTOCOL_VERSION,
		id: InvocationId.make(`scheduled-${++serial}`),
		scope: {
			tenantId: TenantId.make('test-tenant'),
			environment: EnvironmentName.make('development'),
			releaseId: ReleaseId.make('local')
		},
		command: occurrence.command,
		input: occurrence.input,
		taskId: occurrence.taskId,
		attempt: occurrence.attempt
	});
const deliver = async (occurrence: HostScheduleOccurrence) => {
	const response = await harness!.runtime.runPromise(
		dispatchInvocation(taskInvocation(occurrence))
	);
	const queue = await harness!.runtime.runPromise(TaskQueue.Service);
	await harness!.runtime.runPromise(
		queue.settle(harness!.effectId(`settle-${serial}`), occurrence.taskId, occurrence.attempt, {
			_tag: 'Done',
			result: Schema.decodeUnknownSync(Schema.Json)(response.value)
		})
	);
};
const latestOccurrence = () => {
	const wake = harness!.tasks.requests.findLast(
		(request) => request._tag === 'Wake' && request.occurrence !== undefined
	);
	if (wake?._tag !== 'Wake' || wake.occurrence === undefined)
		throw new Error('Missing durable continuation');
	return wake.occurrence;
};

it.each(['resume', 'edit'] as const)(
	'the %s command runs the admitted continuation without another Send',
	async (action) => {
		const { ai, requests } = scriptedTranscript([
			assistantText('First answer.'),
			assistantText('Continuation answer.')
		]);
		harness = await makeBoltTestRuntime(undefined, { ai });
		await seedSession(harness, {
			token: 'continuation-token',
			user: 'continuation-user',
			team: 'admin',
			status: 'admin'
		});
		await command(
			'conversations.send',
			Schema.decodeUnknownSync(Schema.Json)({
				conversationId,
				submissionId: sendId,
				agentId: 'web',
				message: userAgentInput('Inspect the workspace.'),
				mode: 'agent',
				priority: 'normal'
			})
		);
		expect(requests).toHaveLength(0);
		await deliver(latestOccurrence());
		if (action === 'resume') {
			await command('conversations.control', { conversationId, action: 'stop' });
			await command('conversations.control', { conversationId, action: 'resume' });
		} else {
			await command(
				'conversations.editMessage',
				Schema.decodeUnknownSync(Schema.Json)({
					conversationId,
					messageId: sendId,
					message: userAgentInput('Inspect its schema instead.')
				})
			);
		}
		await deliver(latestOccurrence());
		expect(requests).toHaveLength(2);
		expect(
			await harness.database.query('select status from conversation where id=$1', [conversationId])
		).toEqual([{ status: 'done' }]);
	}
);

const seedAndSend = async (mode: 'agent' | 'plan' = 'agent') => {
	await seedSession(harness!, {
		token: 'continuation-token',
		user: 'continuation-user',
		team: 'admin',
		status: 'admin'
	});
	await command(
		'conversations.send',
		Schema.decodeUnknownSync(Schema.Json)({
			conversationId,
			submissionId: sendId,
			agentId: 'web',
			message: userAgentInput('Finish the authorized workspace change.'),
			mode,
			priority: 'normal'
		})
	);
};

it('recovers a lost admission wake, refuses forged claims, and checks changed membership before generation', async () => {
	const { ai, requests } = scriptedTranscript([
		assistantText('Must not execute under changed authority.')
	]);
	harness = await makeBoltTestRuntime(undefined, { ai });
	await seedAndSend();
	const original = latestOccurrence();
	await harness.database.query('delete from bolt_task where effect_id=$1', [original.taskId]);
	await harness.runtime.runPromise(AgentDriver.recover(harness.effectId('recover-admission')));
	const recovered = latestOccurrence();
	expect(recovered.taskId).toBe(original.taskId);
	await expect(deliver({ ...recovered, taskId: 'forged' })).rejects.toThrow(
		'exact durable task claim'
	);
	await harness.database.query(
		'update "user" set status=$1 where id=(select subject_id::uuid from conversation where id=$2)',
		['normal', conversationId]
	);
	await expect(deliver(recovered)).rejects.toThrow('Membership changed');
	expect(requests).toHaveLength(0);
	expect(
		await harness.database.query('select status from conversation where id=$1', [conversationId])
	).toEqual([{ status: 'attention' }]);
});

it.each(['agent', 'plan', 'child'] as const)(
	'recovers interrupted %s work without replaying its uncertain tool',
	async (scope) => {
		const entered = Promise.withResolvers<void>();
		let mutations = 0;
		const tool = scope === 'plan' ? 'workspace_read' : 'workspace_apply';
		const { ai, requests } = scriptedTranscript([
			...(scope === 'child'
				? [
						assistantToolCall(
							'subagent',
							{ action: 'spawn', agentId: 'web', instruction: 'Inspect the workspace.' },
							'spawn-recovery'
						),
						assistantText('Wait for the child.')
					]
				: []),
			assistantToolCall(tool, {}, 'uncertain-write'),
			...(scope === 'child'
				? [
						async () => {
							const [child] = await harness!.database.query(
								'select id,status from conversation where parent_id=$1',
								[conversationId]
							);
							expect(child?.status).toBe('failed');
							return assistantToolCall(
								'subagent',
								{ action: 'await', conversationId: String(child?.id) },
								'read-recovered-child'
							);
						}
					]
				: []),
			assistantText('Inspected the recovered state; finished.')
		]);
		const hostTools: FacilityBinding<HostToolRequest, HostToolResponse> = {
			call: async (_metadata, request, signal) => {
				if (request.tool === 'capability_catalog')
					return {
						_tag: 'Success',
						value: {
							output: {
								tools: [
									{
										name: tool,
										description: 'Fixture tool',
										inputSchema: { type: 'object', properties: {} },
										readOnly: scope === 'plan'
									}
								]
							}
						}
					};
				mutations++;
				entered.resolve();
				return await new Promise((_, reject) =>
					signal.addEventListener('abort', () => reject(new Error('Host interrupted')), {
						once: true
					})
				);
			}
		};
		harness = await makeBoltTestRuntime(undefined, { ai, hostTools });
		await seedAndSend(scope === 'plan' ? 'plan' : 'agent');
		const occurrence = latestOccurrence();
		const fiber = harness.runtime.runFork(dispatchInvocation(taskInvocation(occurrence)));
		await entered.promise;
		await harness.runtime.runPromise(Fiber.interrupt(fiber));
		expect(
			await harness.database.query('select status from conversation where id=$1', [conversationId])
		).toEqual([{ status: 'running' }]);
		await harness.database.query(
			"update bolt_task set lease_expires_at=now()-interval '1 second' where effect_id=$1",
			[occurrence.taskId]
		);
		const queue = await harness.runtime.runPromise(TaskQueue.Service);
		const discovery = await harness.runtime.runPromise(
			queue.discover(harness.effectId('restart'), Date.now(), 300_000)
		);
		const reclaimed = discovery.occurrences.find((row) => row.taskId === occurrence.taskId)!;
		expect(reclaimed.attempt).toBe(2);
		await deliver(reclaimed);
		expect(mutations).toBe(1);
		if (scope === 'plan')
			expect(
				await harness.database.query('select distinct mode from turn where conversation_id=$1', [
					conversationId
				])
			).toEqual([{ mode: 'plan' }]);
		expect(requests).toHaveLength(scope === 'child' ? 5 : 2);
		expect(requests.at(-1)?.modelId).toBe(requests[0]?.modelId);
		expect(JSON.stringify(requests.at(-1)?.messages)).toContain(
			scope === 'child' ? 'failed' : 'outcome is unknown'
		);
		expect(JSON.stringify(requests.at(-1)?.messages)).toContain(
			'Finish the authorized workspace change.'
		);
		expect(
			await harness.database.query('select status from conversation where id=$1', [conversationId])
		).toEqual([{ status: scope === 'plan' ? 'ready' : 'done' }]);
	}
);

it('defers a queued message behind a live driver without losing it or spending failure retries', async () => {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const twin = scriptedTranscript([
		assistantText('First finished.'),
		assistantText('Queued work finished.')
	]);
	let first = true;
	const ai: FacilityBinding<AIRequest, AIResponse> = {
		call: async (metadata, request, signal, onProgress) => {
			if (request._tag === 'Generate' && first) {
				first = false;
				entered.resolve();
				await release.promise;
			}
			return twin.ai.call(metadata, request, signal, onProgress);
		}
	};

	harness = await makeBoltTestRuntime(undefined, { ai });

	await seedAndSend();
	const firstOccurrence = latestOccurrence();
	releasePending = () => release.resolve();
	const running = deliver(firstOccurrence);
	await Promise.race([
		entered.promise,
		running.then(() => {
			throw new Error('Driver returned before generation');
		})
	]);
	try {
		await command(
			'conversations.send',
			Schema.decodeUnknownSync(Schema.Json)({
				conversationId,
				submissionId: '00000000-0000-4000-8000-000000000733',
				agentId: 'web',
				message: userAgentInput('Then report the receipt.'),
				mode: 'agent',
				priority: 'normal'
			})
		);
		const second = latestOccurrence();
		await deliver(second);
		expect(
			await harness.database.query(
				'select status,attempts,max_attempts from bolt_task where effect_id=$1',
				[second.taskId]
			)
		).toEqual([{ status: 'pending', attempts: 1, max_attempts: 13 }]);
	} finally {
		release.resolve();
		await running;
	}
	expect(twin.requests).toHaveLength(2);
	expect(
		await harness.database.query(
			"select count(*)::int as n from conversation_message where conversation_id=$1 and state='queued'",
			[conversationId]
		)
	).toEqual([{ n: 0 }]);
	const queue = await harness.runtime.runPromise(TaskQueue.Service);
	await harness.database.query(
		"update bolt_task set run_at=now()-interval '1 second' where status='pending'"
	);
	const later = await harness.runtime.runPromise(
		queue.discover(harness.effectId('later'), Date.now(), 300_000)
	);
	for (const occurrence of later.occurrences) await deliver(occurrence);
	expect(twin.requests).toHaveLength(2);
});
