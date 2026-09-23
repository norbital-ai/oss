import { describe, expect, it } from 'vitest';
import { ImageAsset, ConversationId } from '@norbital-ai/bolt-protocol';
import { boundedAttachments } from '../src/runtime/agents/agents.js';
import {
	attachmentAssetsFromMessage,
	conversationAssetStorageKey,
	renderAttachmentDescriptors,
	userMessageWithAttachments
} from '../src/runtime/agents/image-descriptors.js';

describe('Task image asset boundary', () => {
	it('separates document descriptors from image inputs without putting document bytes on the wire', () => {
		const file = {
			key: 'agent-tasks/ZmlsZQ/ZG9j.pdf',
			name: 'resin.pdf',
			mimeType: 'application/pdf',
			size: 1200
		};
		const message = userMessageWithAttachments('Inspect the datasheet', [file]);
		expect(attachmentAssetsFromMessage(message)).toEqual([file]);
	});
	it('derives an opaque, Task-scoped storage key without a document command surface', () => {
		const first = ConversationId.make('00000000-0000-4000-8000-000000000201');
		const second = ConversationId.make('00000000-0000-4000-8000-000000000202');
		const key = conversationAssetStorageKey(first, 'document-a', 'site-plan.png');

		expect(key).toMatch(/^agent-tasks\/[^/]+\/[^/]+\.png$/u);
		expect(key).not.toContain(first);
		expect(conversationAssetStorageKey(second, 'document-a', 'site-plan.png')).not.toBe(key);
	});

	it('G5: guest turns carry descriptors only; the host renders them as text before the wire', () => {
		const asset = ImageAsset.make({
			key: conversationAssetStorageKey(
				ConversationId.make('00000000-0000-4000-8000-000000000201'),
				'document-a',
				'site-plan.png'
			),
			name: 'site-plan.png',
			mimeType: 'image/png',
			size: 1_042_884
		});
		const message = userMessageWithAttachments('Inspect this site', [asset]);
		const rendered = renderAttachmentDescriptors(message);
		// No bytes and no file part: the key is what the reader tool is called with.
		expect(JSON.stringify(rendered)).not.toContain('"type":"file"');
		expect(JSON.stringify(rendered)).toContain('Inspect this site');
		expect(JSON.stringify(rendered)).toContain(asset.key);
		expect(JSON.stringify(rendered)).toContain('site-plan.png');
		expect(JSON.stringify(rendered)).toContain('1042884 bytes');
	});

	it('keeps tool-role content as a tool-part array after rendering files', () => {
		const rendered = renderAttachmentDescriptors({
			role: 'tool',
			content: [
				{
					type: 'tool-result',
					id: 'call_1',
					name: 'search',
					isFailure: false,
					result: { ok: true },
					providerExecuted: false
				}
			]
		});
		expect(rendered.role).toBe('tool');
		expect(Array.isArray(rendered.content)).toBe(true);
	});
});

describe('Task attachment boundary', () => {
	const attachment = (index: number, size = 16) =>
		ImageAsset.make({
			key: conversationAssetStorageKey(
				ConversationId.make('00000000-0000-4000-8000-000000000201'),
				`attachment-${index}`,
				'photo.jpg'
			),
			name: `photo-${index}.jpg`,
			mimeType: 'image/jpeg',
			size
		});

	it('carries the newest attachments that fit, oldest dropped first', () => {
		const kept = boundedAttachments(Array.from({ length: 10 }, (_, index) => attachment(index)));
		expect(kept.map((entry) => entry.name)).toEqual(
			[2, 3, 4, 5, 6, 7, 8, 9].map((index) => `photo-${index}.jpg`)
		);
	});

	it('drops what does not fit rather than failing the turn', () => {
		expect(boundedAttachments([attachment(0)])).toEqual([attachment(0)]);
		// A single attachment over the byte boundary leaves the turn with none, not with an error.
		expect(boundedAttachments([attachment(0, 21 * 1024 * 1024)])).toEqual([]);
		const heavy = boundedAttachments([
			attachment(0, 12 * 1024 * 1024),
			attachment(1, 12 * 1024 * 1024)
		]);
		expect(heavy.map((entry) => entry.name)).toEqual(['photo-1.jpg']);
	});
});
