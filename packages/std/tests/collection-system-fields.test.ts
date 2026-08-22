import assert from 'node:assert/strict';
import test from 'node:test';
import {
	isSystemCollectionField,
	SYSTEM_COLLECTION_FIELD_NAMES
} from '../src/collection/system-fields.ts';

test('classifies exactly the compiler-owned collection fields', () => {
	for (const name of SYSTEM_COLLECTION_FIELD_NAMES) {
		assert.equal(isSystemCollectionField(name), true);
	}
	assert.equal(isSystemCollectionField('norbital_id'), false);
	assert.equal(isSystemCollectionField('identity'), false);
});
