// @ts-nocheck -- executed directly by Node with --experimental-strip-types.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
	fileRefFromFileValue,
	fileValueFromFileRef
} from '../src/data-renderer/file/file.types.ts';

test('a stored file key is passed unchanged to the host URL capability', () => {
	const seen: string[] = [];
	const value = fileValueFromFileRef(
		{
			storage_key: 'evidence/zone a/photo #1.jpg',
			file_name: 'photo #1.jpg',
			file_size: 42,
			mime_type: 'image/jpeg'
		},
		(key) => {
			seen.push(key);
			return `opaque-host-url:${key}`;
		}
	);

	assert.deepEqual(seen, ['evidence/zone a/photo #1.jpg']);
	assert.equal(value.url, 'opaque-host-url:evidence/zone a/photo #1.jpg');
});

test('a fresh upload persists its storage key rather than its UI upload id', () => {
	assert.deepEqual(
		fileRefFromFileValue({
			id: 'upload-71',
			storageKey: 'upload-71.jpg',
			name: 'inspection.jpg',
			size: 71,
			type: 'image/jpeg',
			url: 'opaque-host-url:upload-71.jpg'
		}),
		{
			storage_key: 'upload-71.jpg',
			file_name: 'inspection.jpg',
			file_size: 71,
			mime_type: 'image/jpeg'
		}
	);
});

test('a hydrated file value falls back to its storage-key id', () => {
	assert.equal(
		fileRefFromFileValue({
			id: 'persisted/document.pdf',
			name: 'document.pdf',
			size: 17,
			type: 'application/pdf',
			url: 'opaque-host-url:persisted/document.pdf'
		}).storage_key,
		'persisted/document.pdf'
	);
});
