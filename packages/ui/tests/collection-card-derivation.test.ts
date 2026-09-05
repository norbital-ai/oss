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
		subtitles: []
	});
});

test('a relationship badge cannot also become an inferred subtitle', () => {
	const model = deriveAutoCard(
		[
			...fields,
			{ name: 'supplier', kind: 'uuid', relation: { target: 'suppliers' } },
			{ name: 'category', kind: 'uuid', relation: { target: 'categories' } },
			{ name: 'description', kind: 'text' }
		],
		['title', 'supplier', 'category', 'description', 'status'],
		{ roles: { title: 'title', badge: 'supplier' } }
	);
	assert.deepEqual(model, {
		title: { kind: 'field', name: 'title' },
		subtitles: ['category', 'description'],
		badge: 'supplier'
	});
});

test('explicit repeated card roles render each field once', () => {
	assert.deepEqual(
		deriveAutoCard(fields, ['title', 'status'], {
			roles: { title: 'title', subtitle: ['status', 'title', 'status'], badge: 'status' }
		}),
		{ title: { kind: 'field', name: 'title' }, subtitles: [], badge: 'status' }
	);
});
