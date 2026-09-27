// @ts-nocheck -- executed directly by Node with --experimental-strip-types.
// The command menu's text model and the event calendar's grid arithmetic (the restored editors and calendar).
import assert from 'node:assert/strict';
import test from 'node:test';
import { applyItem, filterItems, findTrigger } from '../src/editors/command-menu.ts';
import { lanes, monthGrid, step } from '../src/event-calendar/calendar.ts';

const slash = { char: '/', start: 'line', items: () => [] };
const agent = { char: '/', start: 'text', items: () => [] };
const at = { char: '@', start: 'word', items: () => [] };

test('a trigger owns the caret only where it counts', () => {
	assert.deepEqual(findTrigger('intro\n/he', 9, [slash]), { trigger: slash, start: 6, query: 'he' });
	assert.equal(findTrigger('a /he', 5, [slash]), null, 'a mid-line slash is prose');
	assert.equal(findTrigger('x /plan', 7, [agent]), null, 'an agent command is only the first character');
	assert.equal(findTrigger('mail a@b.co', 11, [at]), null, 'an email is not a mention');
	assert.equal(findTrigger('hi @ali tan', 11, [at]), null, 'whitespace ends the query');
	assert.deepEqual(findTrigger('see @employees/al', 17, [slash, at]), { trigger: at, start: 4, query: 'employees/al' });
});

test('picking rewrites the trigger and its query, keeping the text after the caret', () => {
	const found = findTrigger('/pl rest', 3, [agent]);
	assert.deepEqual(applyItem('/pl rest', found, 3, { id: 'plan', label: 'plan', run() {} }), { text: ' rest', caret: 0 });
	const m = findTrigger('hi @ac', 6, [at]);
	assert.deepEqual(applyItem('hi @ac', m, 6, { id: 'a', label: 'Acme' }), { text: 'hi @Acme ', caret: 9 });
	assert.deepEqual(filterItems([{ id: 'a', label: 'Heading 1' }, { id: 'b', label: 'Quote' }], 'head').map((i) => i.id), ['a']);
});

test('overlapping events share lanes by cluster; a month is whole Monday-first weeks', () => {
	const e = (id, h0, h1) => ({ id, title: id, start: new Date(2026, 0, 5, h0), end: new Date(2026, 0, 5, h1) });
	const l = lanes([e('a', 9, 11), e('b', 10, 12), e('c', 13, 14)]);
	assert.deepEqual([l.get('a'), l.get('b'), l.get('c')], [{ lane: 0, of: 2 }, { lane: 1, of: 2 }, { lane: 0, of: 1 }]);
	const grid = monthGrid(new Date(2026, 1, 10));
	assert.equal(grid.length % 7, 0);
	assert.equal(grid[0].getDay(), 1);
	assert.equal(step('month', new Date(2026, 0, 31), 1).getMonth(), 1, 'Jan 31 + a month is February, not March');
});
