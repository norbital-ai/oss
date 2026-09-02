// @ts-nocheck -- executed directly by Node with --experimental-strip-types.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const formSource = readFileSync(
	new URL('../src/collection-form/collection-form.svelte', import.meta.url),
	'utf8'
);

test('A3: approval-gated submit stays open and names Submitted for approval', () => {
	assert.match(formSource, /form\.submittedForApproval/);
	assert.match(formSource, /lastSubmissionKind === 'pendingApproval' \? 'none' : 'commit'/);
	assert.match(formSource, /submission\.kind === 'pendingApproval'/);
	assert.doesNotMatch(formSource, /onAfterSubmit\?\.\(\).*pendingApproval/);
});
