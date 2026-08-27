// @ts-nocheck -- executed directly by Node with --experimental-strip-types.
import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveAutoCard } from '../src/collection-surface/collection-surface-model.ts';

const fields = [
	{ name: 'id', kind: 'uuid', nullable: false },
	{ name: 'title', kind: 'text', nullable: false },
	{ name: 'status', kind: 'enum', nullable: false, values: ['open', 'closed'] }
];

test('automatic cards use only explicitly declared non-system fields', () => {
	assert.deepEqual(deriveAutoCard(fields, [], { roles: {} }), {
		title: { kind: 'collection' },
		subtitles: []
	});
	assert.deepEqual(deriveAutoCard(fields, ['id', 'status'], { roles: {} }), {
		title: { kind: 'field', name: 'status' },
		subtitles: [],
		badge: 'status'
	});
});
