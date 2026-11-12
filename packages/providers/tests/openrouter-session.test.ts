import { describe, expect, it } from 'vitest';
import { session_of } from '../src/openrouter/chat.ts';

const system = 'You are Norbius.';
const first = { role: 'user', content: 'Add a priority to notes' } as const;

describe('a conversation keeps one provider', () => {
	it('stays one session as its messages grow, and another conversation is another', () => {
		const at = session_of({ system, messages: [first] });
		expect(
			session_of({ system, messages: [first, { role: 'assistant', content: 'On it' }, first] })
		).toBe(at);
		expect(session_of({ system, messages: [{ role: 'user', content: 'Something else' }] })).not.toBe(
			at
		);
	});
});
