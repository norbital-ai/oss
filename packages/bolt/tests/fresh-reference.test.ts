// @vitest-environment happy-dom
import './setup-happy-dom.ts';
import { Deferred, Effect, Layer, ManagedRuntime, Queue, Stream } from 'effect';
import { expect, it, vi } from '@effect/vitest';
import { mount, unmount } from 'svelte';
import { mountEdge, run } from '@norbital-ai/ui/effect';
import Rows from './fresh-reference.svelte';

it('a live list re-renders on every frame even when the source reuses its array', async () => {
	const dispose = mountEdge(ManagedRuntime.make(Layer.empty));
	let emit: ((value: { id: string; value: number }[]) => void) | undefined;
	const ready = Deferred.makeUnsafe<void>();
	const source = Stream.callback<{ id: string; value: number }[]>((queue) =>
		Effect.sync(() => {
			emit = (value) => {
				Queue.offerUnsafe(queue, value);
			};
			Deferred.doneUnsafe(ready, Effect.void);
		})
	);
	const target = document.body.appendChild(document.createElement('div'));
	const view = mount(Rows, { target, props: { source } });
	try {
		await run(Deferred.await(ready));
		if (emit === undefined) throw new Error('The live source did not install its emitter');
		const rows = [{ id: 'r1', value: 1 }];
		emit(rows);
		await vi.waitFor(() => expect(target.querySelector('li')?.textContent).toBe('1'));
		if (rows[0] !== undefined) rows[0].value = 2;
		emit(rows);
		await vi.waitFor(() => expect(target.querySelector('li')?.textContent).toBe('2'));
	} finally {
		await unmount(view);
		await dispose();
		target.remove();
	}
});
