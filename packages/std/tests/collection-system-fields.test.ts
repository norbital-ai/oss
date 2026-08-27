import assert from 'node:assert/strict';
import test from 'node:test';
import { isSystemCollectionField } from '../src/collection/system-fields.ts';

test('does not treat authored identity columns as compiler-owned', () => {
	assert.equal(isSystemCollectionField('norbital_id'), false);
	assert.equal(isSystemCollectionField('identity'), false);
});
