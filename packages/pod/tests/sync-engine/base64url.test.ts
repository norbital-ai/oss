import { describe, expect, it } from 'vitest';
import { decodeBase64Url, encodeBase64Url } from '$lib/ui/sync/base64url.js';

describe('Base64URL UTF-8 codec', () => {
	it('round-trips non-Latin cursor values', () => {
		const cursor = JSON.stringify({
			v: 1,
			order: [
				{ field: 'name', direction: 'asc', value: 'PVC树脂 SG-5' },
				{ field: 'unit', direction: 'asc', value: '公斤' }
			]
		});

		const encoded = encodeBase64Url(cursor);

		expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(decodeBase64Url(encoded)).toBe(cursor);
		expect(Buffer.from(encoded, 'base64url').toString('utf8')).toBe(cursor);
		expect(decodeBase64Url(Buffer.from(cursor, 'utf8').toString('base64url'))).toBe(cursor);
	});
});
