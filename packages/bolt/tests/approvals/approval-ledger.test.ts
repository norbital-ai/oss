import { describe, expect, it } from 'vitest';
import {
	inheritLedger,
	rollbackPlan,
	type LedgerEntry
} from '../../src/runtime/approvals/approval-ledger.js';

const entry = (
	record_id: string,
	first_sequence: number,
	base_sequence: number | null,
	collection_name = 'payslips'
): LedgerEntry => ({ collection_name, record_id, first_sequence, base_sequence });

/**
 * The ledger is derived from history, so these are the rules that survive derivation.
 */
describe('rollback plan', () => {
	it('restores to the version from before the request, not the previous write', () => {
		const plan = rollbackPlan([entry('a1', 20, 7)]);
		expect(plan).toEqual([{ kind: 'restore', entry: entry('a1', 20, 7), toSequence: 7 }]);
	});

	it('deletes a record that did not exist before the request', () => {
		expect(rollbackPlan([entry('b4', 31, null)])).toEqual([
			{ kind: 'delete', entry: entry('b4', 31, null) }
		]);
	});

	it('orders every deletion before every restoration', () => {
		const kinds = rollbackPlan([
			entry('b1', 21, 7),
			entry('a1', 20, null),
			entry('b2', 22, 9)
		]).map(({ kind }) => kind);
		expect(kinds.lastIndexOf('delete')).toBeLessThan(kinds.indexOf('restore'));
	});

	it('undoes the newest write first within each group', () => {
		const plan = rollbackPlan([entry('b1', 21, null), entry('b2', 25, null)]);
		expect(plan.map(({ entry: e }) => e.record_id)).toEqual(['b2', 'b1']);
	});

	it('is empty for a request that wrote nothing', () => {
		expect(rollbackPlan([])).toEqual([]);
	});
});

describe('supersession', () => {
	it('keeps the earliest touch, so the replacement cannot bake in the original change', () => {
		const inherited = inheritLedger([entry('a1', 10, 3)], [entry('a1', 40, 30)]);
		expect(inherited).toHaveLength(1);
		expect(inherited[0]?.base_sequence).toBe(3);
		expect(inherited[0]?.first_sequence).toBe(10);
	});

	it('carries across records only one of the requests touched', () => {
		const inherited = inheritLedger([entry('a1', 10, 3)], [entry('b1', 40, null)]);
		expect(inherited.map(({ record_id }) => record_id).toSorted()).toEqual(['a1', 'b1']);
	});
});
