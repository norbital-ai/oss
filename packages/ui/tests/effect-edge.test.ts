// The ui edge (D9): `run` rejects with the tagged failure, `fork` needs `onFailure` when the effect can fail, unmounting
// the edge interrupts every fiber it runs, and `live` hands Svelte a fresh reference per value.
import './dom.ts';
import assert from 'node:assert/strict';
import { it } from '@effect/vitest';
import { browser } from './view-fixture.ts';
import { Effect, Layer, ManagedRuntime, Schema, Stream } from 'effect';
// after `./dom.ts`: the edge's `runed` and the harness share svelte's client runtime
const { attach, fork, mountEdge, run, runningFibers } = await import('../src/effect/index.ts');
const { flushSync, mount, unmount } = await import('svelte');
const { default: Harness } = await import('./effect-live-harness.svelte');
const { default: AttachHarness } = await import('./effect-attach-harness.svelte');

class Nope extends Schema.TaggedError<Nope>()('Nope', { why: Schema.String }) {}
const edge = () => mountEdge(ManagedRuntime.make(Layer.empty));
const settle = () => new Promise((r) => setTimeout(r, 0));

it.live('attachments track factory inputs and do not track reads inside their Effect', () =>
	browser(async () => {
		const unmountEdge = edge();
		const seen: { event: 'start' | 'stop'; selected: number; value: number }[] = [];
		const target = document.createElement('div');
		document.body.append(target);
		const app = mount(AttachHarness, {
			target,
			props: {
				seen: (event: 'start' | 'stop', selected: number, value: number) =>
					seen.push({ event, selected, value })
			}
		});
		try {
			flushSync();
			assert.deepEqual(seen, [{ event: 'start', selected: 0, value: 0 }]);
			target.querySelectorAll('button')[0]?.click();
			flushSync();
			await settle();
			assert.deepEqual(seen, [{ event: 'start', selected: 0, value: 0 }]);
			target.querySelectorAll('button')[1]?.click();
			flushSync();
			await settle();
			assert.deepEqual(
				seen.filter(({ event }) => event === 'start'),
				[
					{ event: 'start', selected: 0, value: 0 },
					{ event: 'start', selected: 1, value: 1 }
				]
			);
			assert.equal(seen.filter(({ event }) => event === 'stop').length, 1);
		} finally {
			await unmount(app);
			target.remove();
			await unmountEdge();
		}
		assert.equal(seen.filter(({ event }) => event === 'stop').length, 2);
	})
);

it.live('run resolves with the success and rejects with the tagged failure', () =>
	browser(async () => {
		const unmountEdge = edge();
		try {
			assert.equal(await run(Effect.succeed(2)), 2);
			await assert.rejects(
				run(Effect.fail(new Nope({ why: 'x' }))),
				(e) => e instanceof Nope && e._tag === 'Nope' && e.why === 'x'
			);
		} finally {
			await unmountEdge();
		}
	})
);

it.live('fork hands a failure to onFailure, and requires it when the effect can fail', () =>
	browser(async () => {
		const unmountEdge = edge();
		try {
			const seen: string[] = [];
			fork(Effect.fail(new Nope({ why: 'y' })), (e) => seen.push(e.why));
			await settle();
			assert.deepEqual(seen, ['y']);
			// @ts-expect-error a failing effect without `onFailure`
			const unhandled = () => fork(Effect.fail(new Nope({ why: 'z' })));
			void unhandled;
		} finally {
			await unmountEdge();
		}
	})
);

it.live('unmounting the edge interrupts its forked and attached fibers', () =>
	browser(async () => {
		const before = runningFibers();
		const unmountEdge = edge();
		let interrupted = 0;
		const stop = Effect.onInterrupt(() =>
			Effect.sync(() => {
				interrupted++;
			})
		);
		fork(Effect.never.pipe(stop));
		attach(() => Effect.never.pipe(stop))(document.createElement('div'));
		assert.equal(runningFibers(), before + 2);
		await unmountEdge();
		assert.equal(interrupted, 2);
		assert.equal(runningFibers(), before);
	})
);

it.live('live emits a fresh array per value and interrupts its stream on teardown', () =>
	browser(async () => {
		const unmountEdge = edge();
		const same = [1, 2];
		let released = false;
		const stream = Stream.make(same, same).pipe(
			Stream.concat(Stream.never),
			Stream.ensuring(
				Effect.sync(() => {
					released = true;
				})
			)
		);
		const seen: (readonly number[] | undefined)[] = [];
		const target = document.createElement('div');
		document.body.append(target);
		const app = mount(Harness, {
			target,
			props: {
				source: () => stream,
				seen: (v: readonly number[] | undefined) => {
					seen.push(v);
				}
			}
		});
		try {
			flushSync();
			await settle();
			flushSync();
			const values = seen.filter((v) => v !== undefined);
			assert.equal(values.length, 2);
			assert.notEqual(values[0], same);
			assert.notEqual(values[0], values[1]);
			assert.deepEqual(values[1], same);
			assert.equal(target.querySelector('output')?.textContent, '2');
		} finally {
			await unmount(app);
			target.remove();
		}
		await settle();
		assert.equal(released, true);
		await unmountEdge();
	})
);
