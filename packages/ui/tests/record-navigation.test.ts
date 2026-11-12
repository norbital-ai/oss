// @vitest-environment happy-dom
import { expect, test } from 'vitest';
import { carried_contexts, open_record } from '../src/record/navigation.ts';

test('opening a stacked record preserves its presets until the intended sheet takes them', () => {
	history.replaceState({}, '', '/?record=leave_catalog_entry/original');
	const contexts = new Map([[Symbol('preset'), { activity: 'REVERSAL' }]]);
	open_record('leave_catalog_entry', 'new', contexts);
	expect(carried_contexts('leave_catalog_entry', 'original')).toBeUndefined();
	expect(carried_contexts('leave_catalog_entry', 'new')).toBe(contexts);
	expect(carried_contexts('leave_catalog_entry', 'new')).toBeUndefined();
});
