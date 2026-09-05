// @ts-nocheck -- executed directly by Node with --experimental-strip-types.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const formSource = readFileSync(
	new URL('../src/collection-form/collection-form.svelte', import.meta.url),
	'utf8'
);
const formState = readFileSync(new URL('../src/form/form_state.svelte.ts', import.meta.url), 'utf8');

test('semantic validation issues prevent CollectionForm from calling the mutation', () => {
	assert.match(formSource, /applySemanticValidation/);
	assert.match(formSource, /issues\.length > 0 \? \{ issues \} : \{ value: candidate \}/);
	assert.match(formState, /if \(Array\.isArray\(issues\)\) \{/);
	assert.match(formState, /this\.submissionState = \{ status: 'idle' \}/);
	assert.match(formState, /return null;/);
	assert.match(formState, /const remoteFn = this\._remoteFnConfig\(\)/);
});
