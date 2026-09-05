import { describe, expect, it } from 'vitest';
import { AgentId, DirectiveMode, DirectivePriority, TaskId } from '@norbital-ai/bolt-protocol';
import { authoredHooks } from '../src/authoring/contracts-schema.js';
import { refuse } from '../src/authoring/refusal.js';
import { emptyAuthoredRuntime } from '../src/runtime/collections/authored.js';
import * as Agents from '../src/runtime/agents/agents.js';
import { adminSubject, makeBoltTestRuntime } from './support/bolt-test-layer.js';
import {
	assistantText,
	assistantToolCalls,
	lastToolFailure,
	scriptedTranscript
} from './agents-canonical-ai-fixture.js';

describe('agent mutation failures', () => {
	for (const phase of ['prepare', 'settle'] as const)
		it(`preserves the ${phase} refusal and whether the write committed`, async () => {
			const personId = '00000000-0000-4000-8000-000000000471';
			const taskId = TaskId.make('00000000-0000-4000-8000-000000000472');
			const message =
				phase === 'prepare' ? 'An account is required.' : 'Follow-up processing failed.';
			const { ai } = scriptedTranscript([
				assistantToolCalls([
					{
						name: 'write_collection',
						input: {
							collection: 'people',
							operation: 'create',
							id: personId,
							values: { name: 'Ada' }
						}
					}
				]),
				(request) => {
					const failure = lastToolFailure(request)?.failure;
					expect(failure).toMatchObject({ phase, committed: phase === 'settle' ? [personId] : [] });
					expect(String(failure?.message)).toContain(message);
					if (phase === 'settle') expect(String(failure?.message)).toMatch(/do not retry/i);
					return assistantText('Reported the failure without repeating the write.');
				}
			]);
			const handler = () => refuse(message);
			const harness = await makeBoltTestRuntime(undefined, {
				ai,
				authored: {
					...emptyAuthoredRuntime,
					hooks: {
						people: authoredHooks({
							mutate: {
								perRecord:
									phase === 'prepare'
										? { before: { description: 'Requires an account.', handler } }
										: { after: { description: 'Fails after the write commits.', handler } }
							}
						})
					}
				}
			});
			try {
				const agents = await harness.runtime.runPromise(Agents.Service);
				await harness.runtime.runPromise(
					agents.submit(harness.effectId('submit'), adminSubject, {
						taskId,
						agentId: AgentId.make('web'),
						message: Agents.userAgentInput('Create Ada.'),
						mode: DirectiveMode.make('agent'),
						priority: DirectivePriority.make('normal')
					})
				);
				await harness.runtime.runPromise(
					agents.execute(harness.effectId('execute'), adminSubject, taskId)
				);
				expect(await harness.database.query('select id from people')).toEqual(
					phase === 'settle' ? [{ id: personId }] : []
				);
			} finally {
				await harness.dispose();
			}
		});
});
