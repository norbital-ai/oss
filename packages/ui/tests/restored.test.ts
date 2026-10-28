import { browser, required } from './view-fixture.ts';
import { Effect } from 'effect';
// Restored components (L-BOLT-773 NumberTuple, 736 country picker, 746 feature colours).
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
