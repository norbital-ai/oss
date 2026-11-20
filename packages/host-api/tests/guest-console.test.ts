import { describe, expect, it } from 'vitest';
import {
	console_hook,
	digest,
	digest_hook,
	GUEST_CONSOLE,
	GUEST_CRYPTO,
	random_stream,
	type GuestSaid
} from '../src/node/guest-hooks.ts';

describe('the host side of a guest console', () => {
	it('bounds what it keeps whatever the guest sends', () => {
		const said: GuestSaid = { lines: [], chars: 0, dropped: 0 };
		const say = console_hook(said);
		// a guest that replaced String.prototype.slice sends its lines unclipped
		const huge = 'x'.repeat(1_000_000);
		for (let i = 0; i < 1000; i++) say('log', huge);
		say('log', { toString: () => huge });
		expect(said.lines.every(([, line]) => line.length <= GUEST_CONSOLE.lineChars)).toBe(true);
		expect(said.lines.reduce((n, [, line]) => n + line.length, 0)).toBeLessThanOrEqual(GUEST_CONSOLE.chars);
		expect(said.chars).toBeLessThanOrEqual(GUEST_CONSOLE.chars);
		expect(said.dropped).toBe(1001 - said.lines.length);
	});

	it('caps guest digest and random_stream bytes per call and per invocation while staying deterministic', () => {
		expect(() => digest('SHA-256', new Uint8Array(GUEST_CRYPTO.maxDigestBytes + 1))).toThrow(
			/at most/
		);
		const d = digest_hook(1024);
		expect(d('SHA-256', new Uint8Array(512)).byteLength).toBe(32);
		expect(d('SHA-256', new Uint8Array(512)).byteLength).toBe(32);
		expect(() => d('SHA-256', new Uint8Array(1))).toThrow(/invocation limit/);

		const a = random_stream('seed-1', 128);
		const b = random_stream('seed-1', 128);
		expect(a(64)).toEqual(b(64));
		expect(a(64)).toEqual(b(64));
		expect(() => a(1)).toThrow(/invocation limit/);
	});
});
