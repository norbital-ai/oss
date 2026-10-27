// The kit controls: non-modal sheets, navigation drawers, virtualized logs and record navigation.
import './dom.ts';
import assert from 'node:assert/strict';
import { it, afterEach } from '@effect/vitest';
import { vi } from 'vitest';
import { Effect } from 'effect';
import { browser, required } from './view-fixture.ts';
import { element } from './elements.ts';
import type { ComponentProps } from 'svelte';
import { escapes, navigates } from '../src/primitives/sheet/dismiss.ts';
import { filterLogs, wantsOlder, type LogLine } from '../src/logs/logs.ts';
import { offsets, windowOf } from '../src/primitives/virtual/virtual.ts';

// The in-app question itself is a real-browser concern (bolt tests/sheet-discard.browser.test.ts); here it is a queue the
// test answers, so happy-dom never runs bits-ui's dialog layers.
const dialog = vi.hoisted(() => ({
	pending: [] as { title: string; answer: (confirmed: boolean) => void }[]
}));
vi.mock('../src/primitives/dialog/confirm.ts', async () => {
	const { Effect } = await import('effect');
	return {
		confirmAction: (options: { title: string }) =>
			Effect.callback<boolean>((resume) => {
				dialog.pending.push({
					title: options.title,
					answer: (confirmed) => resume(Effect.succeed(confirmed))
				});
			})
	};
});
// after the DOM hook: static imports link before it registers
const { flushSync, mount, unmount } = await import('svelte');
const { default: Harness } = await import('./kit-harness.svelte');
const { reactive } = await import('./kit-state.svelte.js');

const mounted: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const done of mounted.splice(0).reverse()) await done();
});
function show(props: ComponentProps<typeof Harness>) {
	const target = document.createElement('div');
	document.body.append(target);
	const state = reactive(props);
	const app = mount(Harness, { target, props: state });
	flushSync();
	let closed = false;
	const done = async () => {
		if (!closed) {
			closed = true;
			await unmount(app);
			target.remove();
		}
	};
	mounted.push(done);
	return { target, state, done };
}
const key = (k: string, init: KeyboardEventInit = {}) =>
	new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });

it.live('sheet: outside interaction keeps it open and Escape dismisses it', () =>
	browser(async () => {
		const v = show({ part: 'sheet', sheetOpen: true });
		const sheet = element(document, '[role=dialog]');
		assert.equal(sheet.getAttribute('aria-modal'), 'false');
		// outside click and typing: nothing closes it, focus goes where the user put it
		const outside = element<HTMLInputElement>(v.target, '[data-outside]');
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
		await v.done();
	})
);

it.live('sheet: the close button dismisses', () =>
	browser(async () => {
		const v = show({ part: 'sheet', sheetOpen: true });
		element<HTMLButtonElement>(document, '[data-sheet-close]').click();
		flushSync();
		assert.equal(document.querySelector('[role=dialog]'), null);
		await v.done();
	})
);

it.live('sheet: blocked session storage does not prevent opening or resizing', () =>
	browser(async () => {
		const read = vi.spyOn(sessionStorage, 'getItem').mockImplementation(() => {
			throw new DOMException('Storage blocked', 'SecurityError');
		});
		const write = vi.spyOn(sessionStorage, 'setItem').mockImplementation(() => {
			throw new DOMException('Storage blocked', 'SecurityError');
		});
		vi.stubGlobal('innerWidth', 1024);
		try {
			const v = show({ part: 'sheet', sheetOpen: true });
			const sheet = element<HTMLElement>(v.target, '[role=dialog]');
			vi.spyOn(sheet, 'offsetWidth', 'get').mockReturnValue(400);
			element(v.target, '[data-sheet-resize]').dispatchEvent(key('ArrowRight'));
			flushSync();
			assert.ok(read.mock.calls.length > 0, 'the blocked preference read was exercised');
			assert.ok(write.mock.calls.length > 0, 'the blocked preference write was exercised');
			assert.ok(v.target.querySelector('[role=dialog]'), 'the sheet remains usable after resizing');
			window.dispatchEvent(key('Escape'));
			flushSync();
			assert.equal(v.target.querySelector('[role=dialog]'), null);
			await v.done();
		} finally {
			vi.restoreAllMocks();
			vi.unstubAllGlobals();
		}
	})
);

it.live(
	'sheet: closing over an unsaved draft asks first, in-app; a clean sheet closes at once',
	() =>
		browser(async () => {
			// a WebView answers `window.confirm` false at once: the sheet must never depend on it
			const native = vi.fn(() => false);
			vi.stubGlobal('confirm', native);
			const asking = () => dialog.pending[0];
			const answer = async (accept: boolean) => {
				await vi.waitFor(() => assert.ok(asking()));
				dialog.pending.shift()!.answer(accept);
				flushSync();
			};
			try {
				let dirty = true;
				const v = show({ part: 'guarded', sheetOpen: true, dirty: () => dirty });
				window.dispatchEvent(key('Escape'));
				flushSync();
				await vi.waitFor(() => assert.ok(asking()));
				assert.equal(asking()!.title, 'Discard your unsaved changes?');
				await answer(false);
				assert.ok(document.querySelector('[role=dialog]'), 'kept: the person said no');
				element<HTMLButtonElement>(document, '[data-sheet-close]').click();
				flushSync();
				await answer(true);
				assert.equal(
					document.querySelector('[role=dialog]'),
					null,
					'closed once the person agreed'
				);
				await v.done();
				dirty = false;
				const clean = show({ part: 'guarded', sheetOpen: true, dirty: () => dirty });
				window.dispatchEvent(key('Escape'));
				flushSync();
				assert.equal(asking(), undefined, 'nothing unsaved: no question');
				assert.equal(document.querySelector('[role=dialog]'), null);
				await clean.done();
				assert.equal(native.mock.calls.length, 0);
			} finally {
				vi.unstubAllGlobals();
			}
		})
);

it.live('sheet: Esc closes only the topmost, never a handled or composing key', () =>
	browser(async () => {
		const a = {},
			b = {};
		assert.equal(
			escapes({ key: 'Escape', defaultPrevented: false, isComposing: false }, b, [a, b]),
			true
		);
		assert.equal(
			escapes({ key: 'Escape', defaultPrevented: false, isComposing: false }, a, [a, b]),
			false
		);
		assert.equal(
			escapes({ key: 'Escape', defaultPrevented: true, isComposing: false }, b, [a, b]),
			false
		);
		assert.equal(
			escapes({ key: 'Escape', defaultPrevented: false, isComposing: true }, b, [a, b]),
			false
		);
		assert.equal(
			escapes({ key: 'Enter', defaultPrevented: false, isComposing: false }, b, [a, b]),
			false
		);
	})
);

it.live('drawer: closes on a nav tap and on a route change, not on other clicks', () =>
	browser(async () => {
		const plain = {
			button: 0,
			metaKey: false,
			ctrlKey: false,
			shiftKey: false,
			altKey: false,
			defaultPrevented: false
		};
		const link = document.createElement('a');
		link.href = '/b';
		assert.equal(navigates({ ...plain, metaKey: true, target: link }), false);
		const v = show({ part: 'drawer', drawerOpen: true });
		const open = () => document.querySelector('[role=dialog]') !== null;
		// the page's router, not the test DOM, navigates
		const stop = (e: Event) => e.preventDefault();
		document.addEventListener('click', stop);
		try {
			element<HTMLElement>(document, '[data-text]').click();
			element(document, '[data-blank]').dispatchEvent(
				new MouseEvent('click', { bubbles: true, cancelable: true })
			);
			flushSync();
			assert.ok(open(), 'a non-link click or a new-tab link keeps it open');
			element(document, '[data-link]').dispatchEvent(
				new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
			);
		} finally {
			document.removeEventListener('click', stop);
		}
		flushSync();
		assert.ok(!open(), 'a nav tap closes it');
		await v.done();
		// a route change (back button, programmatic navigation)
		const r = show({ part: 'drawer', drawerOpen: true, path: '/a' });
		assert.ok(open());
		r.state.path = '/b';
		flushSync();
		assert.ok(!open(), 'a route change closes it');
		await r.done();
	})
);

it.live('logs: level + text filter; a virtual window; older pages near the top', () =>
	browser(async () => {
		const rows: LogLine[] = [
			{ id: '1', at: 0, level: 'info', message: 'boot' },
			{ id: '2', at: 1, level: 'error', message: 'DB timeout', source: 'sync' },
			{ id: '3', at: 2, level: 'debug', message: 'tick' }
		];
		assert.deepEqual(
			filterLogs(rows, { debug: true }, '').map((r) => r.id),
			['1', '2']
		);
		assert.deepEqual(
			filterLogs(rows, {}, 'sync').map((r) => r.id),
			['2']
		);
		assert.deepEqual(
			filterLogs(rows, {}, 'db').map((r) => r.id),
			['2']
		);
		const offs = offsets([20, 60, 20, 20, 20]); // row 1 wrapped to three lines
		assert.deepEqual(offs, [0, 20, 80, 100, 120, 140]);
		assert.deepEqual(windowOf(offs, 70, 20, 0), { start: 1, end: 3 });
		assert.deepEqual(windowOf(offs, 0, 1000, 2), { start: 0, end: 5 });
		assert.equal(wantsOlder(100, true, false), true);
		assert.equal(wantsOlder(100, true, true), false);
		assert.equal(wantsOlder(900, true, false), false);
		assert.equal(wantsOlder(0, false, false), false);
	})
);

it.live('logs: 10k rows render a window and load an older page on scroll to top', () =>
	browser(async () => {
		const rows = Array.from({ length: 10_000 }, (_, i): LogLine => ({
			id: String(i),
			at: i * 1000,
			level: i % 7 ? 'info' : 'warn',
			message: `line ${i}`
		}));
		let calls = 0;
		const v = show({
			part: 'logs',
			rows,
			hasOlder: true,
			loadOlder: () =>
				Effect.sync(() => {
					calls++;
					v.state.rows = [
						{ id: 'old', at: -1, level: 'info', message: 'older' },
						...required(v.state.rows)
					];
				})
		});
		const { target } = v;
		const lines = target.querySelectorAll('[data-log-level]');
		assert.ok(
			lines.length > 0 && lines.length < 100,
			`virtualized: ${lines.length} rows in the DOM`
		);
		const port = element<HTMLElement>(target, '[role=log]');
		port.scrollTop = 0;
		port.dispatchEvent(new Event('scroll'));
		await new Promise((r) => setTimeout(r, 10));
		flushSync();
		assert.equal(calls, 1);
		assert.equal(required(v.state.rows).length, 10_001);
		await v.done();
	})
);

it.live("openRecord writes the shell's one record link, ?record=<model>/<id|new>", () =>
	browser(async () => {
		const { openRecord } = await import('../src/record/navigation.ts');
		history.replaceState(null, '', '/app/sales/list?q=a');
		openRecord('customers', 'new');
		openRecord('customers', 'c1'); // the created record replaces its create sheet
		assert.equal(location.search, '?q=a&record=customers%2Fc1');
		openRecord('orders', 'o1'); // opened from the sheet: stacks
		assert.equal(location.search, '?q=a&record=customers%2Fc1&record=orders%2Fo1');
		openRecord('customers', 'c1'); // one already open becomes the top
		assert.equal(location.search, '?q=a&record=customers%2Fc1');
	})
);

it.live("openRecord carries the opener's contexts to the shell's sheet for that record only", () =>
	browser(async () => {
		const { carriedContexts, openRecord } = await import('../src/record/navigation.ts');
		const scope = new Map([[Symbol('page.create_scope'), { employmentId: () => 'e1' }]]);
		openRecord('leave_entries', 'new', scope);
		assert.equal(carriedContexts('leave_entries', 'new'), scope);
		assert.equal(carriedContexts('leave_entries', 'x1'), undefined);
		openRecord('leave_entries', 'x1');
		assert.equal(carriedContexts('leave_entries', 'new'), undefined);
	})
);

it.live('an instant at hour precision snaps to :00:00 in the viewer zone', () =>
	browser(async () => {
		const { dateText, dateValue, snapHour } = await import('../src/kinds/date-input.svelte');
		const out = new Date(
			required(
				dateText(
					'instant',
					snapHour(required(dateValue('instant', '2026-09-24T06:37:12.345Z')), 'hour')
				)
			)
		);
		assert.deepEqual([out.getMinutes(), out.getSeconds(), out.getMilliseconds()], [0, 0, 0]);
		assert.equal(out.getHours(), new Date('2026-09-24T06:37:12.345Z').getHours());
		assert.equal(
			dateText(
				'instant',
				snapHour(required(dateValue('instant', '2026-09-24T06:37:12.345Z')), 'minute')
			),
			'2026-09-24T06:37:12.345Z'
		);
		// bits-ui's default placeholder is an unzoned CalendarDateTime: read in the viewer zone, never null
		const { CalendarDateTime } = await import('@internationalized/date');
		const typed = new Date(
			required(dateText('instant', snapHour(new CalendarDateTime(2026, 9, 24, 14, 5), 'hour')))
		);
		assert.deepEqual(
			[
				typed.getFullYear(),
				typed.getMonth(),
				typed.getDate(),
				typed.getHours(),
				typed.getMinutes()
			],
			[2026, 8, 24, 14, 0]
		);
	})
);
