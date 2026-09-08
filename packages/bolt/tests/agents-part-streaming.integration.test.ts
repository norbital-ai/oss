import { afterEach, expect, it } from 'vitest';
import { Schema } from 'effect';
import { Prompt } from 'effect/unstable/ai';
import { AgentId, DirectiveMode, DirectivePriority, ConversationId } from '@norbital-ai/bolt-protocol';
import * as Agents from '../src/runtime/agents/agents.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	type BoltTestRuntime
} from './support/bolt-test-layer.js';
import { assistantText, modelCatalogResponse } from './agents-canonical-ai-fixture.js';

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

it('commits each part boundary before the provider finishes, then retains one complete assistant message', async () => {
	const conversationId = ConversationId.make('00000000-0000-4000-8000-000000000119');
	const encode = Schema.encodeSync(Prompt.Message);
	// The provider streams a reasoning part first, then text. Every part is kept, so what persists at
	// each boundary is the snapshot the provider sent, unedited, with its own active-part indexes.
	// The point of the row is the *boundaries*: each one is committed and visible to a reader before
	// the provider call has returned.
	const snapshots = [
		{
			message: encode(Prompt.assistantMessage({ content: [Prompt.reasoningPart({ text: '' })] })),
			activeParts: [0]
		},
		{
			message: encode(
				Prompt.assistantMessage({
					content: [Prompt.reasoningPart({ text: 'Reasoning finished.' })]
				})
			),
			activeParts: []
		},
		{
			message: encode(
				Prompt.assistantMessage({
					content: [
						Prompt.reasoningPart({ text: 'Reasoning finished.' }),
						Prompt.textPart({ text: '' })
					]
				})
			),
			activeParts: [1]
		},
		{
			message: encode(
				Prompt.assistantMessage({
					content: [
						Prompt.reasoningPart({ text: 'Reasoning finished.' }),
						Prompt.textPart({ text: 'Hello.' })
					]
				})
			),
			activeParts: []
		}
	];
	// Nothing is filtered between the provider and the row, so this is the snapshot list itself.
	const persisted = snapshots;
	const observed: unknown[] = [];
	harness = await makeBoltTestRuntime(undefined, {
		ai: {
			call: async (_metadata, request, _signal, onProgress) => {
				if (request._tag === 'Catalog') return modelCatalogResponse();
				if (request._tag !== 'Generate') throw new Error('Generate required');
				expect(onProgress).toBeTypeOf('function');
				for (const [sequence, snapshot] of snapshots.entries()) {
					await onProgress!(
						Schema.decodeUnknownSync(Schema.Json)({ callId: request.callId, sequence, ...snapshot })
					);
					await onProgress!(
						Schema.decodeUnknownSync(Schema.Json)({ callId: request.callId, sequence, ...snapshot })
					);
					const rows = await harness!.database.query(
						"select message, annotation from conversation_message where conversation_id = $1 and message->>'role' = 'assistant'",
						[conversationId]
					);
					expect(rows).toHaveLength(1);
					expect(rows[0]?.message).toEqual(persisted[sequence]!.message);
					expect(rows[0]?.annotation).toMatchObject({
						tag: 'generation',
						activeParts: persisted[sequence]!.activeParts,
						sequence
					});
					observed.push(rows[0]);
				}
				return {
					_tag: 'Success',
					value: {
						_tag: 'Generated',
						result: { _tag: 'Message', message: snapshots[3]!.message },
						observation: {
							callId: request.callId,
							provider: 'fixture',
							model: request.modelId,
							operation: 'language'
						}
					}
				};
			}
		}
	});
	const agents = await harness.runtime.runPromise(Agents.Service);
	await harness.runtime.runPromise(
		agents.submit(harness.effectId('submit'), adminSubject, {
			conversationId,
			agentId: AgentId.make('web'),
			message: Agents.userAgentInput('hi'),
			mode: DirectiveMode.make('agent'),
			priority: DirectivePriority.make('normal')
		})
	);
	harness.database.forget();
	await harness.runtime.runPromise(
		agents.execute(harness.effectId('execute'), adminSubject, conversationId)
	);
	expect(observed).toHaveLength(4);

	/**
	 * Eight part boundaries cost this turn no more reads than two would.
	 *
	 * This is the property the streaming path turns on, and this is the only place in the suite that
	 * can show it: every other turn streams two parts, so a count taken there cannot tell "once per
	 * turn" apart from "once per part". Here the provider sends each of four snapshots twice and the
	 * turn reads exactly what `agents-turn-write-cost.integration.test.ts` pins for an ordinary
	 * two-part reply. None of those reads belongs to a part: every part after the first continues a
	 * row the turn already holds and reads nothing at all.
	 *
	 * Before the turn kept a ledger this was two reads of up to 500 rows *per boundary*, inside the
	 * provider call. The number to watch is not seven; it is that seven does not move when the
	 * boundaries do.
	 */
	const transcriptReads = harness.database.statements.filter(
		(statement) => statement.startsWith('select "d0"."id"') && statement.includes('"conversation_message"')
	);
	expect(transcriptReads).toHaveLength(7);
	const rows = await harness.database.query(
		"select message, annotation from conversation_message where conversation_id = $1 and message->>'role' = 'assistant'",
		[conversationId]
	);
	expect(rows).toEqual([{ message: persisted[3]!.message, annotation: null }]);
	// The settled row is the whole reply the provider produced, reasoning included.
	expect(JSON.stringify(rows)).toContain('Reasoning finished.');
});

it('keeps interrupted parts for display but excludes incomplete tool calls from the next conversation turn', async () => {
	const conversationId = ConversationId.make('00000000-0000-4000-8000-000000000121');
	let calls = 0;
	const unfinished = Schema.encodeSync(Prompt.Message)(
		Prompt.assistantMessage({
			content: [
				Prompt.reasoningPart({ text: 'unfinished-output' }),
				Prompt.toolCallPart({
					id: 'unfinished-call',
					name: 'write_collection',
					params: {},
					providerExecuted: false
				})
			]
		})
	);
	harness = await makeBoltTestRuntime(undefined, {
		ai: {
			call: async (_metadata, request, _signal, onProgress) => {
				if (request._tag === 'Catalog') return modelCatalogResponse();
				if (request._tag !== 'Generate') throw new Error('Generate required');
				if (calls++ === 0) {
					await onProgress!(
						Schema.decodeUnknownSync(Schema.Json)({
							callId: request.callId,
							sequence: 0,
							message: unfinished,
							activeParts: [1]
						})
					);
					throw new Error('Connection lost during tool arguments');
				}
				expect(JSON.stringify(request.messages)).not.toContain('unfinished-output');
				expect(JSON.stringify(request.messages)).not.toContain('unfinished-call');
				return {
					_tag: 'Success',
					value: {
						_tag: 'Generated',
						result: { _tag: 'Message', message: assistantText('Conversation continued.') },
						observation: {
							callId: request.callId,
							provider: 'fixture',
							model: request.modelId,
							operation: 'language'
						}
					}
				};
			}
		}
	});
	const agents = await harness.runtime.runPromise(Agents.Service);
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
	await submit('Start');
	await expect(
		harness.runtime.runPromise(agents.execute(harness.effectId('first'), adminSubject, conversationId))
	).rejects.toThrow(/Connection lost/);
	const stored = await harness.database.query(
		"select * from conversation_message where conversation_id = $1 and annotation->>'tag' = 'generation'",
		[conversationId]
	);
	expect(stored).toHaveLength(1);
	await submit('Continue after that connection failure');
	expect(
		await harness.runtime.runPromise(
			agents.execute(harness.effectId('second'), adminSubject, conversationId)
		)
	).toMatchObject({ status: 'done' });
	expect(
		await harness.database.query(
			"select * from conversation_message where conversation_id = $1 and annotation->>'tag' = 'generation'",
			[conversationId]
		)
	).toEqual(stored);
	expect(calls).toBe(2);
});

it.each(['skip', 'rewrite', 'reopen', 'invalid-index', 'unfinished-final'] as const)(
	'refuses %s progress without rewriting persisted completed parts',
	async (fault) => {
		const conversationId = ConversationId.make('00000000-0000-4000-8000-000000000122');
		const complete = assistantText('Original completed part');
		harness = await makeBoltTestRuntime(undefined, {
			ai: {
				call: async (_metadata, request, _signal, onProgress) => {
					if (request._tag === 'Catalog') return modelCatalogResponse();
					if (request._tag !== 'Generate') throw new Error('Generate required');
					await onProgress!(
						Schema.decodeUnknownSync(Schema.Json)({
							callId: request.callId,
							sequence: 0,
							message: complete,
							activeParts: []
						})
					);
					if (fault === 'unfinished-final')
						return {
							_tag: 'Success',
							value: {
								_tag: 'Generated',
								result: { _tag: 'Message', message: assistantText('Unreported change') },
								observation: {
									callId: request.callId,
									provider: 'fixture',
									model: request.modelId,
									operation: 'language'
								}
							}
						};
					await onProgress!(
						Schema.decodeUnknownSync(Schema.Json)({
							callId: request.callId,
							sequence: fault === 'skip' ? 2 : 1,
							message: fault === 'rewrite' ? assistantText('Changed completed part') : complete,
							activeParts: fault === 'invalid-index' ? [5] : fault === 'reopen' ? [0] : []
						})
					);
					throw new Error('Invalid progress was accepted');
				}
			}
		});
		const agents = await harness.runtime.runPromise(Agents.Service);
		await harness.runtime.runPromise(
			agents.submit(harness.effectId('submit'), adminSubject, {
				conversationId,
				agentId: AgentId.make('web'),
				message: Agents.userAgentInput('hi'),
				mode: DirectiveMode.make('agent'),
				priority: DirectivePriority.make('normal')
			})
		);
		await expect(
			harness.runtime.runPromise(agents.execute(harness.effectId('execute'), adminSubject, conversationId))
		).rejects.toThrow(/boundary|immutable|indexes|Final response/);
		expect(
			await harness.database.query(
				"select message from conversation_message where conversation_id = $1 and author->>'kind' = 'agent'",
				[conversationId]
			)
		).toEqual([{ message: complete }]);
	}
);
