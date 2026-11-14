// The `decision.made` attributes: the state the decider received is recorded, every text leaf clipped, so the
// panel's raw-context tab can show exactly what triage/filter/author was given without one event growing unbounded.
import { describe, expect, it } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import { Logs } from '../src/engine/ports.ts';
import type { DecisionRequest, DecisionResult, LogEvent } from '@norbital-ai/host-api';
import { decisionEvent, decisionUsage } from '../src/engine/decision.ts';

const request: DecisionRequest = {
	state: {
		directive: 'x'.repeat(1000),
		assistant: 'Norbius',
		conversation: 'envoy DM',
		pending: [{ from: 'Kim', text: 'the pump, see photo' }],
		earlier: [{ from: 'assistant', text: 'old' }]
	},
	questions: {
		m0: {
			type: 'choice',
			instructions: 'answer it?',
			criteria: { yes: 'now', no: 'never', delay: 'later' }
		}
	}
};
const answered: DecisionResult = {
	answers: { m0: { type: 'choice', choice: 'yes', confidence: 0.9, probabilities: { yes: 0.9 } } },
	cost_usd: 0,
	provider: 'test'
};

describe('the decision.made attributes', () => {
	it.effect('records decisions through the same ai.call resource stream as inference', () =>
		Effect.gen(function* () {
			const records: LogEvent[] = [];
			const logs = Logs.of({
				write: (event) =>
					Effect.sync(() => {
						records.push(event);
					}),
				query: () => Effect.succeed([])
			});
			yield* decisionUsage(
				logs,
				'filter',
				request,
				{
					...answered,
					call: 'decision:gen-1',
					model: 'jev',
					cost_usd: 0.002,
					tokens: { input: 120, output: 2 }
				},
				{ invocation: 'invocation', run: null, conversation: null, turn: null, duration_ms: 37 }
			);
			expect(records).toHaveLength(1);
			expect(records[0]).toMatchObject({
				event: 'ai.call',
				attributes: {
					system: 1,
					category: 'decisions',
					use: 'filter',
					model: 'jev',
					input: 120,
					output: 2,
					cost: 0.002,
					duration_ms: 37,
					questionCount: 1,
					settlement: 'pending',
					call: 'decision:gen-1'
				}
			});
			expect(records[0]?.attributes['requestBytes']).toBeGreaterThan(0);
		})
	);
	it('record the request state with every string leaf clipped to 600 characters', () => {
		const e = Schema.decodeUnknownSync(Schema.Struct({
			use: Schema.String, questions: Schema.Array(Schema.String),
			state: Schema.Struct({ directive: Schema.String, pending: Schema.Array(Schema.Struct({ from: Schema.String, text: Schema.String })) }),
			answers: Schema.Json
		}))(decisionEvent('triage', request, answered));
		expect(e.use).toBe('triage');
		expect(e.questions).toEqual(['m0']);
		expect(e.answers).toEqual(answered.answers);
		expect(e.state.pending).toEqual([{ from: 'Kim', text: 'the pump, see photo' }]);
		expect(e.state.directive).toHaveLength(600);
		expect(e.state.directive.endsWith('…')).toBe(true);
	});

	it('record the state on a failure too, beside the typed error', () => {
		const e = Schema.decodeUnknownSync(Schema.Struct({ error: Schema.String, state: Schema.Json }))(decisionEvent('filter', request, { kind: 'upstream', message: 'down' }));
		expect(e.error).toBe('upstream');
		expect(e.state).toBeDefined();
	});
});
