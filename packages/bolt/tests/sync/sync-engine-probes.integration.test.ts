import { describe, expect, it } from 'vitest';
import { runNodeTestProbe } from '../support/node-test-probe.js';

/**
 * The fifteen PGlite probes behind RFC §0.5, executed rather than hashed.
 *
 * `sync-engine-receipt.test.ts` pins these bytes; this file proves the pinned bytes still pass. The
 * child boots `@electric-sql/pglite` fifteen times, which is what puts this file in the integration
 * suite: it is database-backed in a child process rather than in this one, and the ten seconds it
 * costs belong on the integration schedule, not on every push.
 */
describe('sync engine Phase 0 PGlite probes', () => {
	it(
		're-runs the fifteen PGlite probes from the pinned source',
		async () => {
			const { pass, fail, cases } = await runNodeTestProbe(
				new URL('./sync-engine-pglite-probes.test.mjs', import.meta.url),
				110_000
			);
			expect({ pass, fail }).toEqual({ pass: 15, fail: 0 });
			expect(cases.filter((name) => name.startsWith('ok '))).toHaveLength(15);
		},
		120_000
	);
});
