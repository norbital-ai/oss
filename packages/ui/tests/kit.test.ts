// @ts-nocheck -- executed directly by Node with --experimental-strip-types.
// The kit rules (owner, 2026-09-25): tab hierarchy, one non-modal sheet, the nav drawer, LogView, the client stylesheet.
import './dom.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { tabLevel } from '../src/primitives/tabs/level.ts';
import { escapes, navigates } from '../src/primitives/sheet/dismiss.ts';
import { filterLogs, wantsOlder } from '../src/views/logs.ts';
import { offsets, windowOf } from '../src/primitives/virtual/virtual.ts';
// after the DOM hook: static imports link before it registers
const { flushSync, mount, unmount } = await import('svelte');
const { default: Harness } = await import('./kit-harness.svelte');
const { reactive } = await import('./kit-state.svelte.js');

function show(props) {
	const target = document.createElement('div');
	document.body.append(target);
	const state = reactive(props);
	const app = mount(Harness, { target, props: state });
	flushSync();
	return { target, state, done: () => (unmount(app), target.remove()) };
}
const variants = (root) => [...root.querySelectorAll('[data-tabs-variant]')].map((e) => e.getAttribute('data-tabs-variant'));
const key = (k, init = {}) => new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });

test('tabs: segmented > underline > chips, levels inferred from nesting', () => {
	assert.deepEqual(tabLevel(undefined, undefined), { level: 1 });
	assert.deepEqual(tabLevel(1, undefined), { level: 2 });
	assert.deepEqual(tabLevel(2, 2).level, 2);
	assert.match(tabLevel(2, 2).warning, /expected level 3/);
	assert.match(tabLevel(undefined, 3).warning, /expected level 1 \(segmented\)/);
	assert.match(tabLevel(3, undefined).warning, /no fourth/);
	const v = show({ part: 'tabs' });
	assert.deepEqual(variants(v.target), ['segmented', 'underline', 'chips']);
	v.done();
});

test('tabs: an explicit level out of order warns in dev', () => {
	const warned = [];
	const warn = console.warn;
	console.warn = (m) => warned.push(m);
	try {
		const v = show({ part: 'tabs', innerLevel: 3 });
		assert.deepEqual(variants(v.target), ['segmented', 'chips', 'chips']);
		assert.equal(warned.length, 2); // the misplaced level, then the chips nested under it
		assert.match(warned[0], /expected level 2 \(underline\)/);
		v.done();
	} finally {
		console.warn = warn;
	}
});

test('sheet: non-modal on a wide screen, no backdrop, outside stays usable, new tab hierarchy', async () => {
	const v = show({ part: 'sheet', sheetOpen: true });
	const sheet = document.querySelector('[role=dialog]');
	assert.equal(sheet.getAttribute('aria-modal'), 'false');
	assert.equal(document.querySelectorAll('.fixed:not([data-sheet-scrim])').length, 1, 'the sheet is the only fixed layer on a wide screen: no backdrop');
	assert.ok(document.querySelector('[data-sheet-scrim]')!.classList.contains('md:hidden'), "a phone's drawer alone has a scrim, a tap on which dismisses it");
	assert.deepEqual(variants(v.target), ['segmented', 'segmented'], 'tabs in a sheet start at level 1');
	// outside click and typing: nothing closes it, focus goes where the user put it
	const outside = v.target.querySelector('[data-outside]');
	outside.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
	outside.click();
	outside.focus();
	outside.dispatchEvent(key('a'));
	flushSync();
	assert.equal(document.activeElement, outside);
	assert.ok(document.querySelector('[role=dialog]'), 'still open after outside interaction');
	// Esc dismisses, and consumes the key: one Esc closes one sheet
	const esc = key('Escape');
	window.dispatchEvent(esc);
	flushSync();
	assert.equal(esc.defaultPrevented, true);
	assert.equal(document.querySelector('[role=dialog]'), null);
	v.done();
});

test('sheet: the close button dismisses', () => {
	const v = show({ part: 'sheet', sheetOpen: true });
	document.querySelector('[data-sheet-close]').click();
	flushSync();
	assert.equal(document.querySelector('[role=dialog]'), null);
	v.done();
});

test('sheet: closing over an unsaved draft asks first; a clean sheet closes at once', () => {
	const asked: string[] = [];
	let answer = false;
	const confirm = globalThis.confirm;
	globalThis.confirm = (message?: string) => (asked.push(String(message)), answer);
	try {
		let dirty = true;
		const v = show({ part: 'guarded', sheetOpen: true, dirty: () => dirty });
		window.dispatchEvent(key('Escape'));
		flushSync();
		assert.deepEqual(asked, ['Discard your unsaved changes?']);
		assert.ok(document.querySelector('[role=dialog]'), 'kept: the person said no');
		answer = true;
		document.querySelector<HTMLButtonElement>('[data-sheet-close]')!.click();
		flushSync();
		assert.equal(document.querySelector('[role=dialog]'), null, 'closed once the person agreed');
		v.done();
		dirty = false;
		asked.length = 0;
		const clean = show({ part: 'guarded', sheetOpen: true, dirty: () => dirty });
		window.dispatchEvent(key('Escape'));
		flushSync();
		assert.deepEqual(asked, [], 'nothing unsaved: no question');
		assert.equal(document.querySelector('[role=dialog]'), null);
		clean.done();
	} finally {
		globalThis.confirm = confirm;
	}
});

test('sheet: Esc closes only the topmost, never a handled or composing key', () => {
	const a = {}, b = {};
	assert.equal(escapes({ key: 'Escape', defaultPrevented: false, isComposing: false }, b, [a, b]), true);
	assert.equal(escapes({ key: 'Escape', defaultPrevented: false, isComposing: false }, a, [a, b]), false);
	assert.equal(escapes({ key: 'Escape', defaultPrevented: true, isComposing: false }, b, [a, b]), false);
	assert.equal(escapes({ key: 'Escape', defaultPrevented: false, isComposing: true }, b, [a, b]), false);
	assert.equal(escapes({ key: 'Enter', defaultPrevented: false, isComposing: false }, b, [a, b]), false);
});

test('drawer: closes on a nav tap and on a route change, not on other clicks', async () => {
	const plain = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false };
	assert.equal(navigates({ ...plain, metaKey: true, target: { closest: () => ({ getAttribute: () => null }) } }), false);
	const v = show({ part: 'drawer', drawerOpen: true });
	const open = () => document.querySelector('[role=dialog]') !== null;
	document.querySelector('[data-text]').click();
	document.querySelector('[data-blank]').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
	flushSync();
	assert.ok(open(), 'a non-link click or a new-tab link keeps it open');
	// the page's router, not the test DOM, navigates
	const stop = (e) => e.preventDefault();
	document.addEventListener('click', stop);
	document.querySelector('[data-link]').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
	document.removeEventListener('click', stop);
	flushSync();
	assert.ok(!open(), 'a nav tap closes it');
	v.done();
	// a route change (back button, programmatic navigation)
	const r = show({ part: 'drawer', drawerOpen: true, path: '/a' });
	assert.ok(open());
	r.state.path = '/b';
	flushSync();
	assert.ok(!open(), 'a route change closes it');
	r.done();
});

test('logs: level + text filter; a virtual window; older pages near the top', () => {
	const rows = [
		{ id: '1', at: 0, level: 'info', message: 'boot' },
		{ id: '2', at: 1, level: 'error', message: 'DB timeout', source: 'sync' },
		{ id: '3', at: 2, level: 'debug', message: 'tick' }
	];
	assert.deepEqual(filterLogs(rows, { debug: true }, '').map((r) => r.id), ['1', '2']);
	assert.deepEqual(filterLogs(rows, {}, 'sync').map((r) => r.id), ['2']);
	assert.deepEqual(filterLogs(rows, {}, 'db').map((r) => r.id), ['2']);
	const offs = offsets([20, 60, 20, 20, 20]); // row 1 wrapped to three lines
	assert.deepEqual(offs, [0, 20, 80, 100, 120, 140]);
	assert.deepEqual(windowOf(offs, 70, 20, 0), { start: 1, end: 3 });
	assert.deepEqual(windowOf(offs, 0, 1000, 2), { start: 0, end: 5 });
	assert.equal(wantsOlder(100, true, false), true);
	assert.equal(wantsOlder(100, true, true), false);
	assert.equal(wantsOlder(900, true, false), false);
	assert.equal(wantsOlder(0, false, false), false);
});

test('logs: 10k rows render a window, wrap under the message column, and load an older page on scroll to top', async () => {
	const rows = Array.from({ length: 10_000 }, (_, i) => ({ id: String(i), at: i * 1000, level: i % 7 ? 'info' : 'warn', message: `line ${i}` }));
	let calls = 0;
	const v = show({ part: 'logs', rows, hasOlder: true, loadOlder: async () => { calls++; v.state.rows = [{ id: 'old', at: -1, level: 'info', message: 'older' }, ...v.state.rows]; } });
	const { target } = v;
	const lines = target.querySelectorAll('[data-log-level]');
	assert.ok(lines.length > 0 && lines.length < 100, `virtualized: ${lines.length} rows in the DOM`);
	assert.match(lines[0].lastElementChild.className, /whitespace-pre-wrap/);
	assert.equal(lines[0].children.length, 3, 'time · level · message');
	const port = target.querySelector('[role=log]');
	port.scrollTop = 0;
	port.dispatchEvent(new Event('scroll'));
	await new Promise((r) => setTimeout(r, 10));
	flushSync();
	assert.equal(calls, 1);
	assert.equal(v.state.rows.length, 10_001);
	v.done();
});

test('the stylesheet is exported: tokens + Tailwind over every ui component', () => {
	const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
	assert.equal(pkg.exports['./base.css'], './build/base.css');
	const css = readFileSync(new URL('../src/base.css', import.meta.url), 'utf8');
	assert.match(css, /@import 'tailwindcss'/);
	assert.match(css, /@source '\.\/';/);
});

test('openRecord writes the shell\'s one record link, ?record=<collection>/<id|new>', async () => {
	const { openRecord } = await import('../src/views/bolt.ts');
	history.replaceState(null, '', '/app/sales/list?q=a');
	openRecord('customers', 'new');
	openRecord('customers', 'c1'); // the created record replaces its create sheet
	assert.equal(location.search, '?q=a&record=customers%2Fc1');
	openRecord('orders', 'o1'); // opened from the sheet: stacks
	assert.equal(location.search, '?q=a&record=customers%2Fc1&record=orders%2Fo1');
	openRecord('customers', 'c1'); // one already open becomes the top
	assert.equal(location.search, '?q=a&record=customers%2Fc1');
});

test('openRecord carries the opener\'s contexts to the shell\'s sheet for that record only', async () => {
	const { carriedContexts, openRecord } = await import('../src/views/bolt.ts');
	const scope = new Map([[Symbol('page.create_scope'), { employmentId: () => 'e1' }]]);
	openRecord('leave_entries', 'new', scope);
	assert.equal(carriedContexts('leave_entries', 'new'), scope);
	assert.equal(carriedContexts('leave_entries', 'x1'), undefined);
	openRecord('leave_entries', 'x1');
	assert.equal(carriedContexts('leave_entries', 'new'), undefined);
});

test('an instant at hour precision snaps to :00:00 in the viewer zone', async () => {
	const { dateText, dateValue, snapHour } = await import('../src/kinds/date-input.svelte');
	const out = new Date(dateText('instant', snapHour(dateValue('instant', '2026-09-24T06:37:12.345Z'), 'hour')));
	assert.deepEqual([out.getMinutes(), out.getSeconds(), out.getMilliseconds()], [0, 0, 0]);
	assert.equal(out.getHours(), new Date('2026-09-24T06:37:12.345Z').getHours());
	assert.equal(dateText('instant', snapHour(dateValue('instant', '2026-09-24T06:37:12.345Z'), 'minute')), '2026-09-24T06:37:12.345Z');
	// bits-ui's default placeholder is an unzoned CalendarDateTime: read in the viewer zone, never null
	const { CalendarDateTime } = await import('@internationalized/date');
	const typed = new Date(dateText('instant', snapHour(new CalendarDateTime(2026, 9, 24, 14, 5), 'hour')));
	assert.deepEqual([typed.getFullYear(), typed.getMonth(), typed.getDate(), typed.getHours(), typed.getMinutes()], [2026, 8, 24, 14, 0]);
});
