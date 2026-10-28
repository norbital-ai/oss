// The cell's kernel side (compute model §14) over a synthetic bundle: every entry is metered to its unit, an entry
// past its unit's budget fails `cpuBudget`, and a bundle on another ABI is refused.
import { describe, expect, it } from 'vitest';
import { bootCell, type CellOptions } from '../src/node/cell-host.ts';
import { CELL_ABI_VERSION } from '../src/protocol/membrane.ts';

const options = (
	metered: { unit: string; nanos: bigint }[],
	budgetMs: number
): CellOptions => ({
	memoryMiB: 32,
	slot: async () => () => undefined,
	meter: (unit, nanos) => void metered.push({ unit, nanos }),
	entryTimeoutMs: () => budgetMs
});

describe('the cell kernel', () => {
	it('meters the bundle evaluation to boot and refuses another ABI', async () => {
		const metered: { unit: string; nanos: bigint }[] = [];
		await expect(
			bootCell(
				`globalThis.__bolt_cell = { abi: ${CELL_ABI_VERSION + 1}, open() {} };`,
				options(metered, 1_000)
			)
		).rejects.toThrow(/ABI/);
		expect(metered.map(({ unit }) => unit)).toEqual(['boot']);
		expect(metered[0]?.nanos).toBeGreaterThan(0n);
	});

	it('fails an entry past its unit budget as cpuBudget', async () => {
		await expect(bootCell('for (;;) {}', options([], 5))).rejects.toMatchObject({
			_tag: 'HostFailure',
			code: 'cpuBudget'
		});
	});
});
