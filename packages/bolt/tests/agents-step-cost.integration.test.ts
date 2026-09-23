import { afterEach, expect, it } from 'vitest';
import { Schema } from 'effect';
import { Prompt } from 'effect/unstable/ai';
import {
	AgentId,
	ConversationId,
	DirectiveMode,
	DirectivePriority,
	type AIRequest,
	type AIResponse,
	type FacilityBinding
} from '@norbital-ai/bolt-protocol';
import * as Agents from '../src/runtime/agents/agents.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	recordId,
	type BoltTestRuntime
} from './support/bolt-test-layer.js';
import { modelCatalogResponse } from './agents-canonical-ai-fixture.js';

/**
 * What the platform spends between two model calls, as numbers.
 *
 * The turn Norbius runs for "update the job with this photo": the model streams a little text and
 * a read, then streams a write, then answers. Everything the person waits on between the end of one
 * provider stream and the start of the next is the platform's — each statement is ~10 ms on Neon and
 * each host commit a guest dispatch — so both are counted per phase and bounded. Ratchets: lower a
 * bound when the cost drops; a bound that has to rise is a regression to explain.
 */

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

const encode = Schema.encodeSync(Prompt.Message);
const json = Schema.decodeUnknownSync(Schema.Json);

/** The streamed snapshots of one step: text opens, text closes, then the tool call lands. */
const step = (text: string, call?: { id: string; name: string; params: unknown }) => {
	const textPart = (value: string) => Prompt.textPart({ text: value });
	const done = [
		textPart(text),
		...(call === undefined ? [] : [Prompt.toolCallPart({ ...call, providerExecuted: false })])
	];
	return [
		{ message: encode(Prompt.assistantMessage({ content: [textPart('')] })), activeParts: [0] },
		{ message: encode(Prompt.assistantMessage({ content: [textPart(text)] })), activeParts: [] },
		...(call === undefined
			? []
			: [{ message: encode(Prompt.assistantMessage({ content: done })), activeParts: [] }])
	];
};

it('bounds the statements and host commits between model calls', async () => {
	const steps = [
		step('Finding the person.', {
			id: 'read-1',
			name: 'read_collection',
			params: { collection: 'people', limit: 5 }
		}),
		step('Updating them.', {
			id: 'write-1',
			name: 'write_collection',
			params: {
				collection: 'people',
				operation: 'create',
				id: recordId('step-cost-person'),
				values: { name: 'Ada' }
			}
		}),
		step('Done.')
	];
	let commits = 0;
	/** Statement and commit counters at every boundary the provider stub passes. */
	const marks: Array<{ label: string; statements: number; commits: number }> = [];
	const mark = (label: string) =>
		marks.push({ label, statements: harness!.database.statements.length, commits });
	let call = 0;
	const ai: FacilityBinding<AIRequest, AIResponse> = {
		call: async (_metadata, request, _signal, onProgress) => {
			if (request._tag === 'Catalog') return modelCatalogResponse();
			if (request._tag !== 'Generate') throw new Error('Generate required');
			const snapshots = steps[call++]!;
			mark(`start:${call}`);
			for (const [sequence, snapshot] of snapshots.entries()) {
				await onProgress!(json({ callId: request.callId, sequence, ...snapshot }));
				mark(`part:${call}:${sequence}`);
			}
			mark(`end:${call}`);
			return {
				_tag: 'Success',
				value: {
					_tag: 'Generated',
					result: { _tag: 'Message', message: snapshots.at(-1)!.message },
					observation: {
						callId: request.callId,
						provider: 'fixture',
						model: request.modelId,
						operation: 'language'
					}
				}
			};
		}
	};
	harness = await makeBoltTestRuntime(undefined, {
		ai,
		syncCommit: {
			call: async () => {
				commits += 1;
				return { _tag: 'Success', value: {} };
			}
		}
	});
	const agents = await harness.runtime.runPromise(Agents.Service);
	const conversationId = ConversationId.make(recordId('step-cost'));
	await harness.runtime.runPromise(
		agents.submit(harness.effectId('submit'), adminSubject, {
			conversationId,
			agentId: AgentId.make('web'),
			message: Agents.userAgentInput('Update the job with this photo.'),
			mode: DirectiveMode.make('agent'),
			priority: DirectivePriority.make('normal')
		})
	);
	harness.database.forget();
	commits = 0;
	mark('execute');
	const result = await harness.runtime.runPromise(
		agents.execute(harness.effectId('execute'), adminSubject, conversationId)
	);
	mark('settled');
	expect(result.status).toBe('done');
	expect(call).toBe(3);

	const at = (label: string) => marks.find((entry) => entry.label === label)!;
	const between = (from: string, to: string) => ({
		statements: at(to).statements - at(from).statements,
		commits: at(to).commits - at(from).commits
	});
	const parts = marks
		.filter(({ label }) => label.startsWith('part:'))
		.map((entry, index, all) => {
			const previous = index === 0 ? undefined : all[index - 1];
			const origin =
				previous !== undefined && previous.label.split(':')[1] === entry.label.split(':')[1]
					? previous
					: at(`start:${entry.label.split(':')[1]}`);
			return {
				statements: entry.statements - origin.statements,
				commits: entry.commits - origin.commits
			};
		});
	const cost = {
		beforeFirstCall: between('execute', 'start:1'),
		afterRead: between('end:1', 'start:2'),
		afterWrite: between('end:2', 'start:3'),
		settle: between('end:3', 'settled'),
		worstPart: {
			statements: Math.max(...parts.map(({ statements }) => statements)),
			commits: Math.max(...parts.map(({ commits }) => commits))
		}
	};
	console.info('[step-cost]', JSON.stringify(cost));
	/**
	 * Measured 2026-09-24. A part is its write — the first one of a call also reads the next
	 * sequence — and one host commit. Between calls: usage, the finished assistant row, one fence and
	 * one queue check for the batch, the tool, its result (fence, sequence, write), then the next
	 * iteration's fence and one queue read for Plan revision and steering. No transcript read: the
	 * ledger carries it unless steering wrote outside it. Every write is still two statements — the
	 * engine's existing-row read and the write — which is the next floor to lower.
	 */
	expect(cost.worstPart).toEqual({ statements: 3, commits: 1 });
	expect(cost.afterRead).toEqual({ statements: 13, commits: 3 });
	expect(cost.afterWrite).toEqual({ statements: 14, commits: 4 });
});
