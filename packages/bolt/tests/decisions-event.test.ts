// The `decision.made` attributes (§5.12): the state the decider received is recorded, every text leaf clipped, so the
// panel's raw-context tab can show exactly what triage/filter/author was given without one event growing unbounded.
import { describe, expect, it } from 'vitest';
import { decisionEvent, type DecisionRequest, type DecisionResult } from '../src/engine/decisions/index.ts';

const request: DecisionRequest = {
	state: { directive: 'x'.repeat(1000), assistant: 'Norbius', conversation: 'envoy DM', pending: [{ from: 'Kim', text: 'the pump, see photo' }], earlier: [{ from: 'assistant', text: 'old' }] },
	questions: { m0: { type: 'choice', instructions: 'answer it?', criteria: { yes: 'now', no: 'never', delay: 'later' } } },
};
const answered: DecisionResult = { answers: { m0: { type: 'choice', choice: 'yes', confidence: 0.9, probabilities: { yes: 0.9 } } }, costUsd: 0, provider: 'test' };

describe('the decision.made attributes', () => {
	it('record the request state with every string leaf clipped to 600 characters', () => {
		const e = decisionEvent('triage', request, answered) as { use: string; questions: string[]; state: { directive: string; pending: { text: string }[] }; answers: unknown };
		expect(e.use).toBe('triage');
		expect(e.questions).toEqual(['m0']);
		expect(e.answers).toEqual(answered.answers);
		expect(e.state.pending).toEqual([{ from: 'Kim', text: 'the pump, see photo' }]);
		expect(e.state.directive).toHaveLength(600);
		expect(e.state.directive.endsWith('…')).toBe(true);
	});

	it('record the state on a failure too, beside the typed error', () => {
		const e = decisionEvent('filter', request, { kind: 'upstream', message: 'down' }) as { error: string; state: unknown };
		expect(e.error).toBe('upstream');
		expect(e.state).toBeDefined();
	});
});
