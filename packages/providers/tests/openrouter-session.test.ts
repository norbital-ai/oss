import { describe, expect, it } from 'vitest';
import { sessionOf } from '../src/openrouter/chat.ts';

const system = 'You are Norbius.';
const first = { role: 'user', content: 'Add a priority to notes' } as const;

describe('a conversation keeps one provider', () => {
	it('stays one session as its messages grow, and another conversation is another', () => {
		const at = sessionOf({ system, messages: [first] });
		expect(
			sessionOf({ system, messages: [first, { role: 'assistant', content: 'On it' }, first] })
		).toBe(at);
		expect(sessionOf({ system, messages: [{ role: 'user', content: 'Something else' }] })).not.toBe(
			at
		);
	});
});
