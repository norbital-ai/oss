// @ts-nocheck -- executed directly by Node with --experimental-strip-types.
// Restored components (L-BOLT-773 NumberTuple, 708 avatar, 713 breadcrumb, 736 country picker, 746 feature colours).
import './dom.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
const { flushSync, mount, unmount } = await import('svelte');

function show(C, props) {
	const target = document.body.appendChild(document.createElement('div'));
	const app = mount(C, { target, props });
	flushSync();
	return { target, done: () => { unmount(app); target.remove(); } };
}

test('NumberTuple: a typed or pasted line fills the cells in order; one number edits its own cell', async () => {
	const { default: NumberTuple, splitNumbers } = await import('../src/kinds/number-tuple.svelte');
	assert.deepEqual(splitNumbers('62.4, 18.1; x 12.9'), ['62.4', '18.1', '12.9']);
	const seen = [];
	const v = show(NumberTuple, { segments: [{ name: 'l', label: 'L' }, { name: 'a', label: 'a' }, { name: 'b', label: 'b' }], value: { l: null, a: null, b: null }, onChange: (x) => seen.push(x) });
	const cells = v.target.querySelectorAll('input');
	assert.equal(cells.length, 3);
	cells[0].value = '62.4, 18.1';
	cells[0].dispatchEvent(new Event('input', { bubbles: true }));
	flushSync();
	assert.deepEqual(seen.at(-1), { l: 62.4, a: 18.1, b: null });
	cells[2].value = '12.9';
	cells[2].dispatchEvent(new Event('input', { bubbles: true }));
	assert.deepEqual(seen.at(-1), { l: null, a: null, b: 12.9 });   // value is controlled: the caller writes it back
	v.done();
});

test('internal primitives: avatar initials, breadcrumb current page, country flags and names', async () => {
	const { default: Avatar } = await import('../src/primitives/avatar/avatar.svelte');
	const a = show(Avatar, { name: 'Ada Lovelace' });
	assert.equal(a.target.textContent.trim(), 'AL');
	a.done();
	const { default: Breadcrumb } = await import('../src/primitives/breadcrumb/breadcrumb.svelte');
	const b = show(Breadcrumb, { items: [{ label: 'Sales', href: '/app/sales' }, { label: 'Quotes' }] });
	assert.equal(b.target.querySelector('a').getAttribute('href'), '/app/sales');
	assert.equal(b.target.querySelector('[aria-current=page]').textContent, 'Quotes');
	b.done();
	const { COUNTRY_CODES, flagOf } = await import('../src/primitives/country-picker/country-picker.svelte');
	assert.equal(COUNTRY_CODES.length, 249);
	assert.ok(COUNTRY_CODES.includes('SG') && COUNTRY_CODES.includes('MY'));
	assert.equal(flagOf('sg'), '🇸🇬');
});

test('feature colours cover every feature with literal classes', async () => {
	const { FEATURE_COLORS } = await import('../src/brand/feature-colors.ts');
	assert.equal(Object.keys(FEATURE_COLORS).length, 12);
	for (const [k, s] of Object.entries(FEATURE_COLORS)) assert.ok(s.icon && s.iconClass && s.iconWrapperClass && s.accentClass, k);
});
