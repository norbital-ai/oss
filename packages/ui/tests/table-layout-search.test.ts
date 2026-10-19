import { required, textOf } from './view-fixture.ts';
import { element } from './elements.ts';
import { browser } from './view-fixture.ts';
import { Effect } from 'effect';
import './dom.ts';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { it, vi } from '@effect/vitest';
const { flushSync, mount, tick, unmount } = await import('svelte');
const { default: Harness } = await import('./local-table-edit-harness.svelte');
const settle = async () => {
	for (let i = 0; i < 3; i++) {
		flushSync();
		await tick();
		await setImmediate();
	}
	flushSync();
};
const initial = [
	{ id: 'b', name: 'Beta', amount: 2 },
	{ id: 'a', name: 'Alpha', amount: 1 }
];
const key = 'ui.table.local-edit';
const storageWith = (
	storage: Storage,
	methods: Partial<Pick<Storage, 'getItem' | 'setItem'>>
): Storage => ({
	get length() {
		return storage.length;
	},
	clear: storage.clear.bind(storage),
	key: storage.key.bind(storage),
	removeItem: storage.removeItem.bind(storage),
	getItem: methods.getItem ?? storage.getItem.bind(storage),
	setItem: methods.setItem ?? storage.setItem.bind(storage)
});

for (const condition of ['saved', 'invalid', 'denied', 'wrong-shape'] as const)
	it.live(`layout is read once per mount with ${condition} storage`, () =>
		Effect.gen(function* () {
			const saved = JSON.stringify({
				pinned: ['amount'],
				widths: { amount: 180 },
				size: 200,
				order: ['amount', 'name'],
				hidden: ['name']
			});
			const raw = condition === 'saved' ? saved : condition === 'wrong-shape' ? 'null' : '{bad';
			localStorage.setItem(key, raw);
			const read = localStorage.getItem.bind(localStorage);
			const reads = vi.fn((name: string) => {
				if (condition === 'denied') throw new Error('Storage denied');
				return read(name);
			});
			vi.stubGlobal('localStorage', storageWith(localStorage, { getItem: reads }));
			const target = document.body.appendChild(document.createElement('div'));
			const app = mount(Harness, { target, props: { initial, changed: () => {} } });
			try {
				yield* browser(() => settle());
				assert.equal(reads.mock.calls.filter((call) => call[0] === key).length, 1);
				const amount = element<HTMLElement>(target, '[data-column="amount"]');
				assert.ok(amount);
				if (condition === 'saved') {
					assert.equal(target.querySelector('[data-column="name"]'), null);
					assert.equal(amount.style.width, '180px');
					assert.equal(amount.style.left, '0px');
				} else {
					assert.ok(element<HTMLElement>(target, '[data-column="name"]'));
					assert.equal(amount.style.width, '');
					assert.equal(amount.style.left, '');
				}
			} finally {
				yield* browser(() => unmount(app));
				target.remove();
				vi.unstubAllGlobals();
				vi.restoreAllMocks();
				localStorage.clear();
				history.replaceState(null, '', '/');
			}
		})
	);

it.live('search waits300ms, supersedes earlier input and cancels pending work on unmount', () =>
	Effect.gen(function* () {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		const target = document.body.appendChild(document.createElement('div'));
		const app = mount(Harness, { target, props: { initial, search: true, changed: () => {} } });
		let mounted = true;
		try {
			yield* browser(() => settle());
			const toggle = element<HTMLElement>(target, '[data-search-toggle]');
			assert.ok(toggle instanceof HTMLButtonElement);
			toggle.click();
			yield* browser(() => settle());
			const input = element<HTMLInputElement>(document, 'input[data-search]');
			assert.ok(input);
			const names = () =>
				Array.from(target.querySelectorAll<HTMLElement>('tbody tr')).map(
					(row) => row.querySelector('input')?.value
				);
			const type = async (text: string) => {
				input.value = text;
				input.dispatchEvent(new Event('input', { bubbles: true }));
				await settle();
			};
			yield* browser(() => type('Al'));
			yield* browser(() => vi.advanceTimersByTimeAsync(299));
			yield* browser(() => settle());
			assert.deepEqual(names(), ['Beta', 'Alpha']);
			yield* browser(() => type('Be'));
			yield* browser(() => vi.advanceTimersByTimeAsync(299));
			yield* browser(() => settle());
			assert.deepEqual(names(), ['Beta', 'Alpha']);
			yield* browser(() => vi.advanceTimersByTimeAsync(1));
			yield* browser(() => settle());
			assert.deepEqual(names(), ['Beta']);
			assert.equal(new URLSearchParams(location.search).get('local-edit.q'), 'Be');
			yield* browser(() => type('Al'));
			yield* browser(() => unmount(app));
			mounted = false;
			const before = location.href;
			yield* browser(() => vi.advanceTimersByTimeAsync(300));
			yield* browser(() => settle());
			assert.equal(location.href, before);
			assert.equal(target.childElementCount, 0);
		} finally {
			if (mounted) yield* browser(() => unmount(app));
			target.remove();
			vi.useRealTimers();
			localStorage.clear();
			history.replaceState(null, '', '/');
		}
	})
);

it.live('a refused layout write keeps the current interactive layout in memory', () =>
	Effect.gen(function* () {
		const saved = JSON.stringify({ pinned: ['amount'] });
		localStorage.setItem(key, saved);
		assert.equal(localStorage.getItem(key), saved);
		const target = document.body.appendChild(document.createElement('div'));
		const app = mount(Harness, { target, props: { initial, changed: () => {} } });
		try {
			yield* browser(() => settle());
			assert.equal(element<HTMLElement>(target, '[data-column="amount"]').style.left, '0px');
			const writes = vi.fn((_name: string, _value: string) => {
				throw new Error('Quota refused');
			});
			vi.stubGlobal('localStorage', storageWith(localStorage, { setItem: writes }));
			const menu = element<HTMLElement>(target, '[data-column-menu="amount"]');
			assert.ok(menu instanceof HTMLButtonElement);
			menu.click();
			yield* browser(() => settle());
			const unpin = yield* browser(() =>
				vi.waitFor(() => {
					const button = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
						(button) => textOf(button).includes('Unpin column')
					);
					assert.ok(button, 'The column menu exposes its current pinned state');
					return button;
				})
			);
			unpin.click();
			yield* browser(() => settle());
			assert.equal(target.querySelector<HTMLElement>('[data-column="amount"]')?.style.left, '');
			assert.equal(localStorage.getItem(key), saved);
			assert.equal(writes.mock.calls.filter((call) => call[0] === key).length, 1);
		} finally {
			yield* browser(() => unmount(app));
			target.remove();
			vi.unstubAllGlobals();
			vi.restoreAllMocks();
			localStorage.clear();
			history.replaceState(null, '', '/');
		}
	})
);
