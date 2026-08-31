import { afterEach, describe, expect, it } from 'vitest';
import type { AIRequest, AIResponse, FacilityBinding } from '@norbital-ai/bolt-protocol';
import * as Agents from '../../src/runtime/agents/agents.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	type BoltTestRuntime
} from '../support/bolt-test-layer.js';
import {
	assistantText,
	assistantToolCall,
	lastToolResult,
	modelCatalogResponse,
	modelMessages
} from './canonical-ai-fixture.js';

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

describe('agent stop and resume controls', () => {
	it('keeps inputs pending while stopped and resumes their compatible prefix in one run', async () => {
		let release!: () => void;
		const held = new Promise<void>((resolve) => (release = resolve));
		let started!: () => void;
		const providerStarted = new Promise<void>((resolve) => (started = resolve));
		const turns: Array<Extract<AIRequest, { readonly _tag: 'Turn' }>> = [];
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: async (_metadata, request) => {
				if (request._tag === 'Models') return modelCatalogResponse();
				if (request._tag !== 'Turn') throw new Error('expected a turn');
				turns.push(request);
				if (turns.length === 1) {
					started();
					await held;
				}
				return {
					_tag: 'Success',
					value: { output: assistantText(`answer-${turns.length}`, `resume-${turns.length}`) }
				};
			}
		};
		harness = await makeBoltTestRuntime(undefined, { ai });
		const agents = await harness.runtime.runPromise(Agents.Service);
		const conversationId = 'resume-compatible-prefix';
		const active = harness.runtime.runPromise(
			agents.enqueue(
				harness.effectId('active'),
				adminSubject,
				'web',
				conversationId,
				'active-input',
				Agents.userAgentInput('Initial work.')
			)
		);
		await providerStarted;
		await harness.runtime.runPromise(
			agents.stop(harness.effectId('stop'), adminSubject, conversationId)
		);
		release();
		expect((await active).status).toBe('failed');
		for (const [id, text] of [
			['first', 'First pending input.'],
			['second', 'Second pending input.']
		] as const) {
			expect(
				(
					await harness.runtime.runPromise(
						agents.enqueue(
							harness.effectId(`enqueue:${id}`),
							adminSubject,
							'web',
							conversationId,
							`${id}-input`,
							Agents.userAgentInput(text)
						)
					)
				).status
			).toBe('pending');
		}
		await harness.runtime.runPromise(
			agents.resume(harness.effectId('resume'), adminSubject, conversationId)
		);
		expect(turns).toHaveLength(2);
		expect(JSON.stringify(turns[1]?.messages)).toContain('First pending input.');
		expect(JSON.stringify(turns[1]?.messages)).toContain('Second pending input.');
		expect(
			await harness.database.query(
				`select status, disposition from agent_run where conversation_id = $1 order by generation`,
				[conversationId]
			)
		).toEqual([
			{ status: 'aborted', disposition: 'stopped' },
			{ status: 'completed', disposition: null }
		]);
	});

	it('awaits the exact named child without draining a sibling child', async () => {
		let parentRound = 0;
		let newer: Readonly<Record<string, unknown>> | undefined;
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: async (_metadata, request) => {
				if (request._tag === 'Models') return modelCatalogResponse();
				if (request._tag !== 'Turn') throw new Error('expected a turn');
				const messages = modelMessages(request);
				if (
					messages.some(
						(message) =>
							message.role === 'user' && String(message.content).includes('newer child task')
					)
				) {
					return {
						_tag: 'Success',
						value: { output: assistantText('newer child finished', 'newer-child-answer') }
					};
				}
				let output;
				if (parentRound === 0) output = assistantToolCall('spawn_agent', { task: 'older child task' }, 'spawn-older');
				else if (parentRound === 1) {
					output = assistantToolCall('spawn_agent', { task: 'newer child task' }, 'spawn-newer');
				} else if (parentRound === 2) {
					newer = lastToolResult(request);
					output = assistantToolCall(
						'await_agent',
						{ agentId: String(newer?.agentId), taskId: String(newer?.taskId) },
						'await-newer'
					);
				} else output = assistantText('parent joined newer child', 'parent-joined');
				parentRound += 1;
				return { _tag: 'Success', value: { output } };
			}
		};
		harness = await makeBoltTestRuntime(undefined, { ai });
		const agents = await harness.runtime.runPromise(Agents.Service);
		await harness.runtime.runPromise(
			agents.enqueue(
				harness.effectId('parent'),
				adminSubject,
				'web',
				'fifo-parent',
				'parent-input',
				Agents.userAgentInput('Join only the named child.')
			)
		);
		expect(newer?.agentId).toBeDefined();
		expect(
			await harness.database.query(
				`select session.conversation_id, run.status
				 from chat_session session join agent_run run on run.conversation_id = session.conversation_id
				 where session.parent_id = 'fifo-parent' order by session.conversation_id`
			)
		).toEqual([
			{ conversation_id: newer?.agentId, status: 'completed' },
			{ conversation_id: 'agent:spawn-older', status: 'running' }
		]);
	});

	it('executes each separately admitted user input under its own run boundary', async () => {
		const turns: Array<Extract<AIRequest, { readonly _tag: 'Turn' }>> = [];
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: async (_metadata, request) => {
				if (request._tag === 'Models') return modelCatalogResponse();
				if (request._tag === 'Turn') turns.push(request);
				return {
					_tag: 'Success',
					value: { output: assistantText(`answer-${turns.length}`, `separate-${turns.length}`) }
				};
			}
		};
		harness = await makeBoltTestRuntime(undefined, { ai });
		const agents = await harness.runtime.runPromise(Agents.Service);
		for (const id of ['first', 'second']) {
			await harness.runtime.runPromise(
				agents.enqueue(
					harness.effectId(`enqueue:${id}`),
					adminSubject,
					'web',
					'one-run-per-admission',
					`${id}-input`,
					Agents.userAgentInput(id)
				)
			);
		}
		expect(turns).toHaveLength(2);
		expect(
			await harness.database.query(
				`select status, input_boundary from agent_run
				 where conversation_id = $1 order by generation`,
				['one-run-per-admission']
			)
		).toEqual([
			expect.objectContaining({ status: 'completed', input_boundary: expect.any(Number) }),
			expect.objectContaining({ status: 'completed', input_boundary: expect.any(Number) })
		]);
	});

	it('reconstructs the durable canonical input when stopped work is resumed', async () => {
		let release!: () => void;
		const held = new Promise<void>((resolve) => (release = resolve));
		let started!: () => void;
		const providerStarted = new Promise<void>((resolve) => (started = resolve));
		const turns: Array<Extract<AIRequest, { readonly _tag: 'Turn' }>> = [];
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: async (_metadata, request) => {
				if (request._tag === 'Models') return modelCatalogResponse();
				if (request._tag !== 'Turn') throw new Error('expected a turn');
				turns.push(request);
				if (turns.length === 1) {
					started();
					await held;
				}
				return {
					_tag: 'Success',
					value: { output: assistantText('Continued from rows.', `durable-${turns.length}`) }
				};
			}
		};
		harness = await makeBoltTestRuntime(undefined, { ai });
		const agents = await harness.runtime.runPromise(Agents.Service);
		const conversationId = 'fresh-resume';
		const first = harness.runtime.runPromise(
			agents.enqueue(
				harness.effectId('enqueue'),
				adminSubject,
				'web',
				conversationId,
				'durable-input',
				Agents.userAgentInput('Continue this from durable history.')
			)
		);
		await providerStarted;
		await harness.runtime.runPromise(
			agents.stop(harness.effectId('stop'), adminSubject, conversationId)
		);
		release();
		await first;
		await harness.runtime.runPromise(
			agents.resume(harness.effectId('resume'), adminSubject, conversationId)
		);
		expect(turns).toHaveLength(2);
		expect(JSON.stringify(turns[1]?.messages)).toContain('Continue this from durable history.');
	});

	it('does not turn a failed provider invocation into an implicit retry ladder', async () => {
		let attempts = 0;
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: async (_metadata, request) => {
				if (request._tag === 'Models') return modelCatalogResponse();
				attempts += 1;
				return {
					_tag: 'Failure',
					error: {
						code: 'ai.unavailable',
						message: 'provider unavailable',
						retryable: true,
						outcome: 'known'
					}
				};
			}
		};
		harness = await makeBoltTestRuntime(undefined, { ai });
		const agents = await harness.runtime.runPromise(Agents.Service);
		const failed = await harness.runtime.runPromise(
			agents.enqueue(
				harness.effectId('enqueue'),
				adminSubject,
				'web',
				'failed-is-terminal',
				'failed-input',
				Agents.userAgentInput('Fail once.')
			)
		);
		expect(failed.status).toBe('failed');
		if (failed.runId === undefined) throw new Error('expected a failed run id');
		expect(
			await harness.runtime.runPromise(
				agents.execute(harness.effectId('execute:again'), failed.conversationId, failed.runId)
			)
		).toMatchObject({ status: 'failed' });
		expect(attempts).toBe(1);
	});
});
