import { expect, it } from 'vitest';
import { attention, runTransitions } from '../src/shell/agent/chime.ts';
import type { AgentRow } from '../src/protocol/schema.ts';

const held: AgentRow = {
	id: 'approval',
	seq: 3,
	role: 'tool',
	text: null,
	state: 'confirm',
	tag: 'confirm'
};
it('sounds only for new approvals and a completed run, never history or chat switches', () => {
	const event = attention();
	expect(event('one', 'idle', [held])).toBeNull();
	expect(event('one', 'running', [held])).toBeNull();
	expect(event('one', 'running', [held, { ...held, id: 'new' }])).toBe('approval');
	expect(event('one', 'idle', [])).toBe('complete');
	expect(event('one', 'idle', [])).toBeNull();
	expect(event('two', 'idle', [held])).toBeNull();
	expect(event(null, 'idle', [])).toBeNull();
});
it('closed-chat completion only reacts to a running personal conversation that ends', () => {
	const ended = runTransitions();
	const row = { id: 'one', integration: null, status: 'idle' };
	expect(ended([row])).toEqual([]);
	expect(ended([{ ...row, status: 'running' }])).toEqual([]);
	expect(ended([row])).toEqual(['one']);
	expect(ended([row])).toEqual([]);
	ended([{ ...row, status: 'running', integration: 'whatsapp' }]);
	expect(ended([{ ...row, integration: 'whatsapp' }])).toEqual([]);
});
