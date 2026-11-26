// The resource benchmark's deterministic half (`bench/resources.ts`): counts and retained bytes, never
// time. Timing is the benchmark's, judged against `bench/budget.json` on its own runner.
import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import {
	churn,
	consumer,
	delivered,
	holding,
	judge,
	sampled,
	workspace
} from '../bench/resources.ts';

const COUNTS = { warmup: 2, samples: 4 } as const;
const most = (samples: readonly { readonly statements: number }[]) =>
	Math.max(...samples.map((sample) => sample.statements));

describe('live resources', () => {
	it.live(
		'a one-row edit costs the same statements for one page or five, and the same bytes at 25 rows or 250',
		() =>
			Effect.gen(function* () {
				const small = yield* workspace(25);
				const page = yield* small.view(false);
				const one = yield* holding(small, 1, page, (cs) => sampled(small, cs, small.edit, COUNTS));
				// other titles than the first pass wrote: an edit that changes nothing writes nothing
				const five = yield* holding(small, 5, page, (cs) =>
					sampled(small, cs, (i) => small.edit(i + 100), COUNTS)
				);
				expect(most(five.samples)).toBe(most(one.samples));
				const large = yield* workspace(250);
				const wide = yield* holding(large, 1, yield* large.view(false), (cs) =>
					sampled(large, cs, large.edit, COUNTS)
				);
				// ten times the rows, the same delta: only a version's digits may differ
				const bytes = (samples: readonly { readonly bytes: number }[]) =>
					Math.max(...samples.map((sample) => sample.bytes));
				expect(Math.abs(bytes(wide.samples) - bytes(one.samples))).toBeLessThanOrEqual(8);
				expect(most(wide.samples)).toBe(most(one.samples));
			}).pipe(Effect.scoped),
		120_000
	);

	it.live(
		'opening and closing a page leaves no retained answer, fiber or handle behind',
		() =>
			Effect.gen(function* () {
				const f = yield* workspace(25);
				const result = yield* churn(f, yield* f.view(true), { warmup: 3, cycles: 12 });
				expect(result.retained_after).toBe(0);
				expect(result.fibers_after).toBeLessThanOrEqual(0);
				expect(result.handles_after).toBeLessThanOrEqual(0);
			}).pipe(Effect.scoped),
		120_000
	);

	it.live(
		'a workspace with a page open sends nothing while nothing happens',
		() =>
			Effect.gen(function* () {
				const f = yield* workspace(25);
				const page = yield* consumer(f.live, f.clerk.authority);
				yield* page.open('page', yield* f.view(false));
				yield* delivered(f, [page]);
				const before = { statements: f.sent.statements, bytes: page.state.bytes };
				yield* Effect.sleep('1500 millis');
				expect({ statements: f.sent.statements, bytes: page.state.bytes }).toEqual(before);
				yield* page.close;
			}).pipe(Effect.scoped),
		60_000
	);

	it('judge refuses a scenario without a budget, a budget without a scenario and a metric over its ceiling', () => {
		expect(judge({ a: { statements: 7 } }, { a: { statements: 7 } })).toEqual([]);
		expect(judge({ a: { statements: 8 } }, { a: { statements: 7 } })).toEqual([
			'a.statements: 8 over 7'
		]);
		expect(judge({ a: { statements: 1 } }, {})).toEqual(['a: no budget']);
		expect(judge({}, { a: { statements: 1 } })).toEqual(['a: a budget without a scenario']);
		expect(judge({ a: {} }, { a: { statements: 1 } })).toEqual(['a.statements: undefined over 1']);
	});
});
