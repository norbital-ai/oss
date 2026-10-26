import * as node from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
	fromBase64,
	fromHex,
	hmacSha256,
	sha1,
	timingSafeEqual,
	toBase64,
	toBase64url
} from '../src/engine/crypto.ts';
import { sha256, toHex } from '@norbital-ai/store';

// every length around the 55/56/64-byte padding seams, then random sizes up to a few MiB
const lengths = [
	...Array.from({ length: 130 }, (_, i) => i),
	1000,
	4095,
	65536,
	...Array.from({ length: 8 }, () => Math.floor(Math.random() * 3_000_000))
];
const inputs = lengths.map((n) => new Uint8Array(node.randomBytes(n)));
const digest = (algorithm: string, data: Uint8Array) =>
	new Uint8Array(node.createHash(algorithm).update(data).digest());

describe('engine crypto matches node:crypto', () => {
	it('sha1 and sha256', () => {
		for (const data of inputs) {
			expect(sha1(data)).toEqual(digest('sha1', data));
			expect(sha256(data)).toEqual(digest('sha256', data));
		}
		const text = 'grüße, 世界 🌍';
		expect(toHex(sha256(text))).toBe(node.createHash('sha256').update(text).digest('hex'));
		expect(toHex(sha1(''))).toBe(node.createHash('sha1').update('').digest('hex'));
	});

	it('hmacSha256 with short, block-sized and long keys', () => {
		for (const keyLength of [0, 1, 32, 63, 64, 65, 200]) {
			const key = new Uint8Array(node.randomBytes(keyLength));
			for (const data of inputs.slice(0, 134))
				expect(hmacSha256(key, data)).toEqual(
					new Uint8Array(node.createHmac('sha256', key).update(data).digest())
				);
		}
		expect(toHex(hmacSha256('secret', 'body'))).toBe(
			node.createHmac('sha256', 'secret').update('body').digest('hex')
		);
	});

	it('timingSafeEqual', () => {
		const a = new Uint8Array(node.randomBytes(32));
		expect(timingSafeEqual(a, a.slice())).toBe(true);
		expect(timingSafeEqual(new Uint8Array(0), new Uint8Array(0))).toBe(true);
		const b = a.slice();
		b[31] = b[31]! ^ 1;
		expect(timingSafeEqual(a, b)).toBe(false);
		expect(timingSafeEqual(a, a.subarray(1))).toBe(false);
	});

	it('hex and base64', () => {
		for (const data of inputs) {
			const buffer = Buffer.from(data);
			expect(toHex(data)).toBe(buffer.toString('hex'));
			// byte arrays compare as buffers: a deep equal of megabytes is the test's own cost, not the code's
			expect(buffer.equals(fromHex(buffer.toString('hex')))).toBe(true);
			expect(toBase64(data)).toBe(buffer.toString('base64'));
			expect(toBase64url(data)).toBe(buffer.toString('base64url'));
			expect(buffer.equals(fromBase64(buffer.toString('base64')))).toBe(true);
			expect(buffer.equals(fromBase64(buffer.toString('base64url')))).toBe(true);
		}
		expect(fromBase64('aGVs\nbG8')).toEqual(new Uint8Array(Buffer.from('hello')));
	});
});
