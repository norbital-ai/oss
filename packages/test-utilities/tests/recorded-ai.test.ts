import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AIRequest, EffectId, InvocationId } from '@norbital-ai/bolt-protocol';
import { Schema } from 'effect';
import { recordedAi, type RecordedGenerated } from '../src/recorded-ai.ts';

const metadata = {
	invocationId: InvocationId.make('invocation-1'),
	effectId: EffectId.make('effect-1'),
	deadlineEpochMs: Number.MAX_SAFE_INTEGER,
	idempotencyKey: 'recorded-ai-1'
};

const signal = new AbortController().signal;

const recordedGenerated: RecordedGenerated = {
	_tag: 'Generated',
	result: {
		_tag: 'Message',
		message: { role: 'assistant', content: 'The filing changed.' }
	},
	observation: {
		callId: 'call-1',
		provider: 'fixture',
		model: 'provider/model',
		operation: 'language',
		charge: { currency: 'USD', coefficient: '125', scale: 6 },
		chargeSource: 'provider'
	}
};

const generateRequest = Schema.decodeUnknownSync(AIRequest)({
	_tag: 'Generate',
	callId: 'call-1',
	modelId: 'provider/model',
	messages: [{ role: 'user', content: 'Check the current filing.' }],
	maxOutputTokens: 1_024,
	output: { _tag: 'Message' }
});

describe('recordedAi', () => {
	it('returns Catalog for catalog and the next Generated payload for Generate', async () => {
		const ai = recordedAi([recordedGenerated]);
		const catalog = await ai.call(metadata, { _tag: 'Catalog' }, signal);
		assert.equal(catalog._tag, 'Success');
		if (catalog._tag !== 'Success') throw new Error('expected Catalog success');
		assert.equal(catalog.value._tag, 'Catalog');
		assert.deepEqual(catalog.value.languageModels, [{ id: 'test/language' }]);
		assert.equal(catalog.value.defaultLanguageModelId, 'test/language');

		const generated = await ai.call(metadata, generateRequest, signal);
		assert.equal(generated._tag, 'Success');
		if (generated._tag !== 'Success') throw new Error('expected Generated success');
		assert.equal(generated.value._tag, 'Generated');
		assert.deepEqual(generated.value.result, recordedGenerated.result);
		assert.equal(generated.value.observation.provider, 'fixture');
		assert.equal(generated.value.observation.operation, 'language');
	});
});
