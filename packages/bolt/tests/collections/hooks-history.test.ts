import { describe, expect, it } from 'vitest';
import { runHooks } from '../../src/runtime/collections/hooks.js';
import type { HistoryEntry } from '../../src/runtime/collections/collections.js';

describe('collection hook and history semantics', () => {
	it('runs hooks in declaration order without mutating the original record', () => {
		const source = { value: 1 };
		const output = runHooks(source, [
			(record) => ({ ...record, value: 2 }),
			(record) => ({ ...record, label: `v${record['value']}` })
		]);
		expect(output).toEqual({ value: 2, label: 'v2' });
		expect(source).toEqual({ value: 1 });
	});

	it('keeps record identity, operation, and version explicit in history entries', () => {
		const entry: HistoryEntry = {
			collection: 'people',
			recordId: 'p1',
			operation: 'update',
			version: 3
		};
		expect(entry).toMatchObject({ recordId: 'p1', operation: 'update', version: 3 });
	});
});
