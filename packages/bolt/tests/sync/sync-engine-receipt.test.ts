import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { runNodeTestProbe } from '../support/node-test-probe.js';

const pgliteProbes = new URL('./sync-engine-pglite-probes.test.mjs', import.meta.url);
const prefixModelProbes = new URL('./sync-engine-prefix-model.test.mjs', import.meta.url);

const receipts = [
	{
		url: pgliteProbes,
		hash: '2247c0191f417ba34341f5ef3a1acf9582029d706e6aee63e96737e401be04d7',
		cases: 15
	},
	{
		url: prefixModelProbes,
		hash: '2d4f451897b3631892eb2db7148eaf28daf39cfa7fcbd7e7651f952a15da8ac2',
		cases: 6
	}
] as const;

describe('sync engine Phase 0 receipt', () => {
	it('keeps the reviewed 21 probe sources byte-identical and durable', async () => {
		let cases = 0;
		for (const receipt of receipts) {
			const source = await readFile(receipt.url);
			expect(createHash('sha256').update(source).digest('hex')).toBe(receipt.hash);
			const declared = source.toString('utf8').match(/^test\(/gmu)?.length ?? 0;
			expect(declared).toBe(receipt.cases);
			cases += declared;
		}
		expect(cases).toBe(21);
	});

	// A hash over a file nobody runs pins a fossil, not a receipt. The six pure model properties
	// carry no database, so the merge path can afford them: they run here, in the unit suite, from
	// the same bytes the hash above just pinned. The fifteen PGlite probes cost ten seconds of
	// Postgres and run under `sync-engine-probes.integration.test.ts` instead.
	it('re-runs the six pure prefix-model properties from the pinned source', async () => {
		const { pass, fail, cases } = await runNodeTestProbe(prefixModelProbes, 10_000);
		expect({ pass, fail }).toEqual({ pass: 6, fail: 0 });
		expect(cases.filter((name) => name.startsWith('ok '))).toHaveLength(6);
	});
});
