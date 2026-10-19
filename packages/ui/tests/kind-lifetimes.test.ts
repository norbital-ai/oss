import './dom.ts';
import assert from 'node:assert/strict';
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { flushSync, mount, tick, unmount } from 'svelte';
import Harness from './json-schema-harness.svelte';

it.live('unmounting a point editor interrupts its in-flight geocoder', () =>
	Effect.gen(function* () {
		let started = false,
			interrupted = false;
		const target = document.body.appendChild(document.createElement('div'));
		const app = mount(Harness, {
			target,
			props: {
				kind: { kind: 'point' },
				initial: null,
				changed: () => {},
				host: {
					geocoder: {
						search: () =>
							Effect.sync(() => {
								started = true;
							}).pipe(
								Effect.flatMap(() => Effect.never),
								Effect.onInterrupt(() =>
									Effect.sync(() => {
										interrupted = true;
									})
								)
							)
					}
				}
			}
		});
		try {
			flushSync();
			yield* Effect.promise(() => tick());
			const trigger = target.querySelector<HTMLButtonElement>('[data-point-picker]');
			assert.ok(trigger);
			trigger.click();
			flushSync();
			const input = document.querySelector<HTMLInputElement>(
				'[data-point-options] input[role=combobox]'
			);
			assert.ok(input);
			input.value = 'Singapore';
			input.dispatchEvent(new Event('input', { bubbles: true }));
			yield* Effect.sleep(400);
			assert.equal(started, true);
		} finally {
			yield* Effect.promise(() => unmount(app));
			target.remove();
		}
		yield* Effect.sleep(0);
		assert.equal(interrupted, true);
	})
);
