import { afterEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { AgentId, DirectiveMode, DirectivePriority, ConversationId } from '@norbital-ai/bolt-protocol';
import type { AIRequest, AIResponse, FacilityBinding } from '@norbital-ai/bolt-protocol';
import * as Agents from '../src/runtime/agents/agents.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	testWorkspace,
	type BoltTestRuntime
} from './support/bolt-test-layer.js';
import { cassetteTranscript, readCassetteFile } from '@norbital-ai/test-utilities';

const cassette = (name: string) =>
	readCassetteFile(fileURLToPath(new URL(`./assets/${name}.cassette.json`, import.meta.url)));

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

describe('steering admitted during an active run', () => {
	it('delivers steering at the next model step in the same run without consuming a normal queued message', async () => {
		let releaseGeneration!: () => void;
		const generationHeld = new Promise<void>((resolve) => {
			releaseGeneration = resolve;
		});
		let announceGeneration!: () => void;
		const generationStarted = new Promise<void>((resolve) => {
			announceGeneration = resolve;
		});
		// Timing stays in the test (hold the first turn until steer + follow-up land);
		// content replays from the cassette.
		const twin = cassetteTranscript(cassette('agents-steering'));
		const requests = twin.requests;
		let held = false;
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: (metadata, request, signal, onProgress) => {
				if (request._tag === 'Generate' && !held) {
					held = true;
					announceGeneration();
					return generationHeld.then(() => twin.ai.call(metadata, request, signal, onProgress));
				}
				return twin.ai.call(metadata, request, signal, onProgress);
			}
		};
		harness = await makeBoltTestRuntime(testWorkspace(), { ai });
		const agents = await harness.runtime.runPromise(Agents.Service);
		const conversationId = ConversationId.make('00000000-0000-4000-8000-000000000c01');
		const submit = (name: string, text: string, priority: 'normal' | 'steer' = 'normal') =>
			harness!.runtime.runPromise(
				agents.submit(harness!.effectId(`submit:${name}`), adminSubject, {
					conversationId,
					agentId: AgentId.make('web'),
					message: Agents.userAgentInput(text),
					mode: DirectiveMode.make('agent'),
					priority: DirectivePriority.make(priority)
				})
			);
		await submit('first', 'Start the work.');
		const execution = harness.runtime.runPromise(
			agents.execute(harness.effectId('execute:first'), adminSubject, conversationId)
		);
		await generationStarted;
		try {
			await submit('follow-up', 'Include the newly queued detail.');
			await submit('steer', 'Do the steered thing first.', 'steer');
		} finally {
			releaseGeneration();
		}
		// The steer was taken mid-run; the normal follow-up is still waiting for a turn of its own,
		// and no work occurrence was minted to remember that — the queue is the transcript.
		expect((await execution).status).toBe('idle');
		expect(
			await harness.database.query('select status from conversation where id = $1', [conversationId])
		).toEqual([{ status: 'ready' }]);
		expect(
			await harness.database.query('select command from bolt_task where input->>\'conversationId\' = $1', [
				conversationId
			])
		).toEqual([]);
		// The first generation was already running; the next model step receives only the steer.
		expect(requests[0] && JSON.stringify(requests[0])).not.toContain('steered thing');

		expect(requests).toHaveLength(2);
		const steerTranscript = JSON.stringify(requests[1]);
		expect(steerTranscript).toContain('Do the steered thing first.');
		expect(steerTranscript).not.toContain('Include the newly queued detail.');
		await harness.runtime.runPromise(
			agents.execute(harness.effectId('execute:follow-up'), adminSubject, conversationId)
		);
		const followUpTranscript = JSON.stringify(requests[2]);
		expect(followUpTranscript).toContain('Include the newly queued detail.');
		expect(followUpTranscript).toContain('Do the steered thing first.');

		expect(
			await harness.database.query(
				`select sequence, priority, state from conversation_message where conversation_id = $1 and state is not null order by sequence`,
				[conversationId]
			)
		).toEqual([
			{ sequence: 1, priority: 'normal', state: 'consumed' },
			{ sequence: 2, priority: 'normal', state: 'consumed' },
			{ sequence: 3, priority: 'steer', state: 'consumed' }
		]);
		const claimed = await harness.database.query(
			`select sequence, turn_id from conversation_message where conversation_id = $1 and state is not null order by sequence`,
			[conversationId]
		);
		expect(claimed[2]?.['turn_id']).toBe(claimed[0]?.['turn_id']);
		expect(claimed[1]?.['turn_id']).not.toBe(claimed[0]?.['turn_id']);
	});
});
