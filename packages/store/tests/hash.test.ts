import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { sha256_hex, to_hex } from '../src/hash.ts';

/** The module as a browser or cell loads it: no Node builtins, so it selects its scalar fallback. */
const scalar_module = async () => {
	vi.resetModules();
	vi.stubGlobal('process', { ...process, getBuiltinModule: undefined });
	try {
		return await import('../src/hash.ts');
	} finally {
		vi.unstubAllGlobals();
	}
};

describe('SHA-256 native and scalar adapters', () => {
	it('matches Node across padding boundaries, offset byte views and UTF-8 text', async () => {
		const scalar = await scalar_module();
		for (const length of [0, 1, 55, 56, 63, 64, 65, 119, 120, 127, 128, 129, 1024]) {
			const bytes = Uint8Array.from({ length }, (_, i) => (i * 37 + 211) & 255);
			const backing = new Uint8Array(length + 16).fill(255);
			backing.set(bytes, 7);
			const input = backing.subarray(7, 7 + length);
			const expected = createHash('sha256').update(bytes).digest('hex');
			const actual = scalar.sha256_hex(input);
			expect(actual).toBe(expected);
			expect(sha256_hex(input)).toBe(expected);
			expect(input).toEqual(bytes);
			expect(backing.subarray(0, 7)).toEqual(new Uint8Array(7).fill(255));
			expect(backing.subarray(7 + length)).toEqual(new Uint8Array(9).fill(255));
		}
		for (const input of ['', 'abc', 'Norbius · 雪 🌌', 'a'.repeat(65)]) {
			const expected = createHash('sha256').update(input).digest('hex');
			const actual = scalar.sha256_hex(input);
			expect(actual).toBe(expected);
			expect(sha256_hex(input)).toBe(expected);
		}
	});

	it('encodes every byte as two lowercase hexadecimal digits', () => {
		const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
		expect(to_hex(bytes)).toBe(Buffer.from(bytes).toString('hex'));
	});
});
