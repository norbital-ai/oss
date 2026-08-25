import { Effect } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import * as Agents from '../../src/runtime/agents/agents.js';
import { chatDocumentStorageKey } from '../../src/runtime/agents/chat-messages.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	type BoltTestRuntime
} from '../support/bolt-test-layer.js';

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

describe('chat session document ownership', () => {
	it('binds every upload to one session and refuses both foreign and generic keys', async () => {
		harness = await makeBoltTestRuntime();
		const service = await harness.runtime.runPromise(Agents.Service);
		await harness.runtime.runPromise(
			Effect.all([
				service.open(harness.effectId('open:a'), adminSubject, 'web', 'conversation-a'),
				service.open(harness.effectId('open:b'), adminSubject, 'web', 'conversation-b')
			])
		);
		const storageKey = chatDocumentStorageKey('conversation-a', 'document-a', 'site-plan.pdf');
		const file = {
			storage_key: storageKey,
			file_name: 'site-plan.pdf',
			file_size: 128,
			mime_type: 'application/pdf'
		};
		await harness.runtime.runPromise(
			service.bindDocument(harness.effectId('bind:a'), adminSubject, 'conversation-a', file)
		);
		expect(
			await harness.runtime.runPromise(
				service.resolveDocument(
					harness.effectId('resolve:a'),
					adminSubject,
					'conversation-a',
					storageKey
				)
			)
		).toEqual(file);
		await expect(
			harness.runtime.runPromise(
				service.resolveDocument(
					harness.effectId('resolve:b'),
					adminSubject,
					'conversation-b',
					storageKey
				)
			)
		).rejects.toThrow(/not owned by this chat session/i);
		await expect(
			harness.runtime.runPromise(
				service.bindDocument(harness.effectId('bind:generic'), adminSubject, 'conversation-a', {
					...file,
					storage_key: 'uploads/site-plan.pdf'
				})
			)
		).rejects.toThrow(/outside this chat session namespace/i);
	});
});
