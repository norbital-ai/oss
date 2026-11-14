import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { keys_port } from '../src/node/keys.ts';

describe('keys_port', () => {
	it('refuses an envelope whose tag was truncated', async () => {
		const keys = keys_port(randomBytes(32)),
			aad = new Uint8Array([1]),
			signal = new AbortController().signal;
		const sealed = await keys.seal(new Uint8Array(), aad, signal);
		expect(await keys.open(sealed, aad, signal)).toEqual(new Uint8Array());
		expect(await keys.open(sealed.subarray(0, 16), aad, signal)).toBeNull();
	});
});
