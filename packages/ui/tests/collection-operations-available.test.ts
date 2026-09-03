// @ts-nocheck -- executed directly by Node with --experimental-strip-types.
import assert from 'node:assert/strict';
import test from 'node:test';
import { collectionOperationsAvailable } from '../src/collection-toolbar/collection-operations-available.ts';

test('collection operations are unavailable when nothing is configured', () => {
	assert.equal(collectionOperationsAvailable({}), false);
	assert.equal(
		collectionOperationsAvailable({
			exportCount: 0,
			importCount: 0,
			integrationCount: 0,
			deletion: false
		}),
		false
	);
});

test('collection operations are available for export, import, integrations, or deletion', () => {
	assert.equal(collectionOperationsAvailable({ exportCount: 1 }), true);
	assert.equal(collectionOperationsAvailable({ importCount: 2 }), true);
	assert.equal(collectionOperationsAvailable({ integrationCount: 1 }), true);
	assert.equal(collectionOperationsAvailable({ deletion: true }), true);
});
