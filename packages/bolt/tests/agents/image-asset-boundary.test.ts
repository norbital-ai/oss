import { describe, expect, it } from 'vitest';
import { ImageAsset, TaskId } from '@norbital-ai/bolt-protocol';
import { taskAssetStorageKey } from '../../src/runtime/agents/agents.js';
import {
	assertGuestImageDescriptorsOnly,
	guestImageCommandHasNoBytes,
	imageAssetsFromMessage,
	stripImageFileParts,
	userMessageWithImages
} from '../../src/runtime/agents/image-descriptors.js';

describe('Task image asset boundary', () => {
	it('derives an opaque, Task-scoped storage key without a document command surface', () => {
		const first = TaskId.make('00000000-0000-4000-8000-000000000201');
		const second = TaskId.make('00000000-0000-4000-8000-000000000202');
		const key = taskAssetStorageKey(first, 'document-a', 'site-plan.png');

		expect(key).toMatch(/^agent-tasks\/[^/]+\/[^/]+\.png$/u);
		expect(key).not.toContain(first);
		expect(taskAssetStorageKey(second, 'document-a', 'site-plan.png')).not.toBe(key);
	});

	it('G5: guest turns carry descriptors only; host strips file parts before the facility wire', () => {
		const asset = ImageAsset.make({
			key: taskAssetStorageKey(
				TaskId.make('00000000-0000-4000-8000-000000000201'),
				'document-a',
				'site-plan.png'
			),
			name: 'site-plan.png',
			mimeType: 'image/png',
			size: 1_042_884
		});
		const message = userMessageWithImages('Inspect this site', [asset]);
		assertGuestImageDescriptorsOnly(message);
		expect(guestImageCommandHasNoBytes({ message })).toBe(true);
		expect(imageAssetsFromMessage(message)).toEqual([asset]);
		const stripped = stripImageFileParts(message);
		expect(JSON.stringify(stripped)).not.toContain('"type":"file"');
		expect(JSON.stringify(stripped)).toContain('Inspect this site');
	});
});
