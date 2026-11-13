// @vitest-environment happy-dom
import { expect, test } from 'vitest';
import { carried_contexts, open_record, remember_create, remembered_create } from '../src/record/navigation.ts';

test('opening a stacked record preserves its presets until the intended sheet takes them', () => {
	history.replaceState({}, '', '/?record=leave_catalog_entry/original');
	const contexts = new Map([[Symbol('preset'), { activity: 'REVERSAL' }]]);
	open_record('leave_catalog_entry', 'new', contexts);
	expect(carried_contexts('leave_catalog_entry', 'original')).toBeUndefined();
	expect(carried_contexts('leave_catalog_entry', 'new')).toBe(contexts);
	expect(carried_contexts('leave_catalog_entry', 'new')).toBeUndefined();
});

test("a create's prefill survives a reload of its history entry; the next opened record starts clean", () => {
	history.replaceState({}, '', '/?record=contacts/new');
	const party = '0199a000-0000-7000-8000-00000000000a';
	expect(remembered_create('contacts')).toEqual({});
	remember_create('contacts', { party, name: 'Desk' });
	// a reload keeps `history.state`, never the opener's contexts
	expect(remembered_create('contacts')).toEqual({ party, name: 'Desk' });
	expect(remembered_create('parties')).toEqual({});
	open_record('contacts', 'new');
	expect(remembered_create('contacts')).toEqual({});
});
