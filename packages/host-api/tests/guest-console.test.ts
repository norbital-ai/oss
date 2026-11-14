import { describe, expect, it } from 'vitest';
import { console_hook, GUEST_CONSOLE, type GuestSaid } from '../src/node/guest-hooks.ts';

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
});
