import { describe, expect, it } from 'vitest';
import { isClientMintedRecordId } from '../src/runtime/collections/write/declarative-prepare.js';

/**
 * Which existing rows a browser may update at all.
 *
 * This predicate gates every browser-originated update: the payload carries the row's own id, so a
 * version this refuses makes the record permanently un-editable from the UI. It once accepted only
 * versions 1–5, which silently locked every UUIDv7 row — the entire BCA seed — behind
 * "must carry a valid client-minted UUID", while the command itself still answered 200.
 */
describe('a client-minted record id', () => {
	it('accepts every UUID version RFC 9562 defines, v7 included', () => {
		const accepted = [
			['v1', 'c232ab00-9414-11ec-b3c8-9f6bdeced846'],
			['v4', '9f1a4e2c-6b7d-4a1e-8c3f-2d5e7a9b0c14'],
			['v5', '2ed6657d-e927-568b-95e1-2665a8aea6a2'],
			// The shape the platform actually seeds with, and the one that was refused.
			['v7', '019f6f10-2000-7000-8000-000000000023'],
			['v8', '019f6f10-2000-8000-9000-000000000023']
		] as const;
		for (const [version, id] of accepted) {
			expect(isClientMintedRecordId(id), version).toBe(true);
		}
	});

	it('refuses values that are not a UUID at all', () => {
		for (const value of [
			'',
			'not-a-uuid',
			'019f6f10-2000-7000-8000',
			'019f6f10-2000-0000-8000-000000000023', // version nibble 0
			'019f6f10-2000-7000-7000-000000000023', // variant nibble outside 8–b
			42,
			null,
			undefined,
			{}
		]) {
			expect(isClientMintedRecordId(value), String(value)).toBe(false);
		}
	});
});
