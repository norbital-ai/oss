// @vitest-environment happy-dom
import { expect, test } from 'vitest';
import { carriedContexts, openRecord } from '../src/record/navigation.ts';

test('opening a stacked record preserves its presets until the intended sheet takes them', () => {
	history.replaceState({}, '', '/?record=leave_catalog_entry/original');
	const contexts = new Map([[Symbol('preset'), { activity: 'REVERSAL' }]]);
	openRecord('leave_catalog_entry', 'new', contexts);
	expect(carriedContexts('leave_catalog_entry', 'original')).toBeUndefined();
	expect(carriedContexts('leave_catalog_entry', 'new')).toBe(contexts);
	expect(carriedContexts('leave_catalog_entry', 'new')).toBeUndefined();
});
