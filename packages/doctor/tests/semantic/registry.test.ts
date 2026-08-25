/**
 * Provider resolution: credential plumbing, custom function wrapping, and the failure texts users
 * act on. The environment is mutated here because the contract is literally "read this variable";
 * save/restore keeps the mutation invisible to sibling processes, which node:test isolates per
 * file anyway.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveEmbedder } from '../../build/semantic/provider/registry.js';

const CREDENTIAL = 'NORBITAL_AI_CREDENTIAL';

test('a missing or empty credential fails with the actionable message', () => {
	const previous = process.env[CREDENTIAL];
	delete process.env[CREDENTIAL];
	try {
		assert.throws(
			() => resolveEmbedder({ provider: 'openrouter' }),
			/set NORBITAL_AI_CREDENTIAL \(an openrouter API key\) to run the semantic tier/
		);
		process.env[CREDENTIAL] = '';
		assert.throws(
			() => resolveEmbedder({ provider: 'openrouter' }),
			/set NORBITAL_AI_CREDENTIAL/
		);
	} finally {
		if (previous !== undefined) process.env[CREDENTIAL] = previous;
	}
});

test('a named alternative credential variable is honoured', () => {
	const previous = process.env['MY_DOCTOR_KEY'];
	delete process.env['MY_DOCTOR_KEY'];
	try {
		assert.throws(
			() => resolveEmbedder({ provider: 'openrouter', credential: 'MY_DOCTOR_KEY' }),
			/set MY_DOCTOR_KEY \(an openrouter API key\) to run the semantic tier/
		);
		process.env['MY_DOCTOR_KEY'] = 'secret';
		const embedder = resolveEmbedder({
			provider: 'openrouter',
			credential: 'MY_DOCTOR_KEY',
			dimensions: 8,
			endpoint: 'http://127.0.0.1:1'
		});
		assert.equal(embedder.id.startsWith('openrouter:'), true);
		assert.equal(embedder.dimensions, 8);
	} finally {
		if (previous !== undefined) process.env['MY_DOCTOR_KEY'] = previous;
		else delete process.env['MY_DOCTOR_KEY'];
	}
});

test('an unknown named provider lists the names that exist', () => {
	assert.throws(
		() => resolveEmbedder({ provider: 'voyage' as never }),
		/unknown embed provider "voyage"; known providers are openrouter/
	);
});

function myVectors(): Promise<Array<Array<number>>> {
	return Promise.resolve([]);
}

test('an inline function provider wraps under a custom id and validates its rows', async () => {
	const embedder = resolveEmbedder({
		provider: myVectors,
		dimensions: 8
	});
	assert.equal(embedder.id, 'custom:myVectors:8');
	assert.equal(embedder.dimensions, 8);

	const faceless = async () => [[0.1, 0.2]];
	// Name inference would call this property `provider`; strip it to exercise the anonymous id.
	Object.defineProperty(faceless, 'name', { value: '' });
	const anonymous = resolveEmbedder({
		provider: faceless,
		dimensions: 2
	});
	assert.equal(anonymous.id, 'custom:anonymous:2');

	const vectors = await anonymous.embed(['x'], 'document');
	const row = vectors[0] ?? [];
	// Float32 storage perturbs 0.1/0.2 slightly; compare with an epsilon.
	assert.equal(Math.abs((row[0] ?? 0) - 0.1) < 1e-6, true);
	assert.equal(Math.abs((row[1] ?? 0) - 0.2) < 1e-6, true);

	const lying = resolveEmbedder({
		provider: async () => [[1, 2, 3]],
		dimensions: 2
	});
	await assert.rejects(
		lying.embed(['x'], 'document'),
		/norbital-doctor: custom embed provider returned 3 dimensions for text 0, declared 2/
	);

	const nonFinite = resolveEmbedder({
		provider: async () => [[Number.NaN, 1]],
		dimensions: 2
	});
	await assert.rejects(
		nonFinite.embed(['x'], 'document'),
		/norbital-doctor: custom embed provider returned a non-finite value/
	);
});

test('a function provider without declared dimensions cannot be resolved', () => {
	assert.throws(
		() => resolveEmbedder({ provider: async () => [] }),
		/declare dimensions for a function embed provider/
	);
});
