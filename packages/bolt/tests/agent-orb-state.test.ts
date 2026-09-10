import { describe, expect, it } from 'vitest';
import { ConversationStatus } from '@norbital-ai/bolt-protocol';
import { agentOrbState, agentOrbStatusKey } from '../src/client/ui/agent/agent-orb-state.js';

/**
 * The projection used to fold six statuses into three, and two of those folds said something
 * untrue: an agent parked on an approval wore the failure mark, and a finished or halted turn wore
 * the idle one. What this file actually guards is that no two statuses share a mark again.
 */
describe('agent orb state', () => {
	it('gives every conversation status its own mark', () => {
		const marks = ConversationStatus.literals.map((status) => agentOrbState({ status }));
		expect(new Set(marks).size).toBe(ConversationStatus.literals.length);
	});

	it('separates waiting on a person from failing', () => {
		expect(agentOrbState({ status: 'attention' })).toBe('waiting');
		expect(agentOrbState({ status: 'failed' })).toBe('error');
	});

	it('separates a finished turn and a stopped one from idle', () => {
		expect(agentOrbState({ status: 'done' })).toBe('done');
		expect(agentOrbState({ status: 'stopped' })).toBe('stopped');
		expect(agentOrbState({ status: 'ready' })).toBe('ready');
	});

	it('lets a caller override with what it knows about a turn it just dispatched', () => {
		// No status has been written for this turn yet; `pending` is the surface's own knowledge.
		expect(agentOrbState({ pending: true })).toBe('working');
		// A caller-reported failure outranks whatever the last written status was.
		expect(agentOrbState({ failed: true, status: 'running' })).toBe('error');
	});

	it('names every mark', () => {
		for (const status of ConversationStatus.literals) {
			expect(agentOrbStatusKey(agentOrbState({ status }))).toMatch(/^bolt\./);
		}
	});
});
