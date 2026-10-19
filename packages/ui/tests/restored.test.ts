import { required, textOf } from './view-fixture.ts';
import { element } from './elements.ts';
import { browser } from './view-fixture.ts';
import { Effect } from 'effect';
// Restored components (L-BOLT-773 NumberTuple, 708 avatar, 713 breadcrumb, 736 country picker, 746 feature colours).
import './dom.ts';
import assert from 'node:assert/strict';
import type { Component } from 'svelte';
import type { NumberTupleValue } from '../src/kinds/number-tuple.svelte';
import { it } from '@effect/vitest';
const { flushSync, mount, unmount } = await import('svelte');

function show<P extends Record<string, unknown>>(C: Component<P>, props: P) {
	const target = document.body.appendChild(document.createElement('div'));
	const app = mount(C, { target, props });
	flushSync();
	return {
		target,
		done: async () => {
			await unmount(app);
			target.remove();
		}
	};
}

it.live(
	'NumberTuple: a typed or pasted line fills the cells in order; one number edits its own cell',
	() =>
		Effect.gen(function* () {
			const { default: NumberTuple, splitNumbers } = yield* browser(
				() => import('../src/kinds/number-tuple.svelte')
			);
			assert.deepEqual(splitNumbers('62.4, 18.1; x 12.9'), ['62.4', '18.1', '12.9']);
			const seen: NumberTupleValue[] = [];
			const v = show(NumberTuple, {
				segments: [
					{ name: 'l', label: 'L' },
					{ name: 'a', label: 'a' },
					{ name: 'b', label: 'b' }
				],
				value: { l: null, a: null, b: null },
				onChange: (x: NumberTupleValue) => seen.push(x)
			});
			const cells = v.target.querySelectorAll<HTMLInputElement>('input');
			assert.equal(cells.length, 3);
			required(cells[0]).value = '62.4, 18.1';
			required(cells[0]).dispatchEvent(new Event('input', { bubbles: true }));
			flushSync();
			assert.deepEqual(seen.at(-1), { l: 62.4, a: 18.1, b: null });
			required(cells[2]).value = '12.9';
			required(cells[2]).dispatchEvent(new Event('input', { bubbles: true }));
			assert.deepEqual(seen.at(-1), { l: null, a: null, b: 12.9 }); // value is controlled: the caller writes it back
			yield* browser(v.done);
		})
);

it.live(
	'internal primitives: avatar initials, breadcrumb current page, country flags and names',
	() =>
		Effect.gen(function* () {
			const { default: Avatar } = yield* browser(
				() => import('../src/primitives/avatar/avatar.svelte')
			);
			const a = show(Avatar, { name: 'Ada Lovelace' });
			assert.equal(textOf(a.target).trim(), 'AL');
			yield* browser(a.done);
			const { default: Breadcrumb } = yield* browser(
				() => import('../src/primitives/breadcrumb/breadcrumb.svelte')
			);
			const b = show(Breadcrumb, {
				items: [{ label: 'Sales', href: '/app/sales' }, { label: 'Quotes' }]
			});
			assert.equal(element<HTMLAnchorElement>(b.target, 'a').getAttribute('href'), '/app/sales');
			assert.equal(textOf(element<HTMLElement>(b.target, '[aria-current=page]')), 'Quotes');
			yield* browser(b.done);
			const { COUNTRY_CODES, flagOf } = yield* browser(
				() => import('../src/primitives/country-picker/country-picker.svelte')
			);
			assert.equal(COUNTRY_CODES.length, 249);
			assert.ok(COUNTRY_CODES.includes('SG') && COUNTRY_CODES.includes('MY'));
			assert.equal(flagOf('sg'), '🇸🇬');
		})
);

it.live('feature colours cover every feature with literal classes', () =>
	Effect.gen(function* () {
		const { FEATURE_COLORS } = yield* browser(() => import('../src/brand/feature-colors.ts'));
		assert.equal(Object.keys(FEATURE_COLORS).length, 12);
		for (const [k, s] of Object.entries(FEATURE_COLORS))
			assert.ok(s.icon && s.iconClass && s.iconWrapperClass && s.accentClass, k);
	})
);
