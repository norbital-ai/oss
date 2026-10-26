// The ui edge (D9): `run` rejects with the tagged failure, `fork` needs `onFailure` when the effect can fail, unmounting
// the edge interrupts every fiber it runs, and `live` hands Svelte a fresh reference per value.
import './dom.ts';
import assert from 'node:assert/strict';
import { it } from '@effect/vitest';
import { vi } from 'vitest';
import { browser } from './view-fixture.ts';
import { Effect, Layer, ManagedRuntime, Schema, Stream, SubscriptionRef } from 'effect';
// after `./dom.ts`: the edge's `runed` and the harness share svelte's client runtime
const { attach, fork, mountEdge, reactiveQuery, run, runningFibers } =
	await import('../src/effect/index.ts');
const { flushSync, mount, unmount } = await import('svelte');
const { default: Harness } = await import('./effect-live-harness.svelte');
const { default: AttachHarness } = await import('./effect-attach-harness.svelte');
const { default: QueryHarness } = await import('./reactive-query-harness.svelte');
const { default: ClockHarness } = await import('./reactive-clock-harness.svelte');
const { default: AsyncQueryHarness } = await import('./reactive-query-async-harness.svelte');

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

it.live('Query awaits and yields one read without starting a live subscription', () =>
	browser(async () => {
		const dispose = edge();
		let reads = 0,
			subscriptions = 0;
		const query = reactiveQuery(
			Effect.sync(() => ++reads),
			Stream.suspend(() => {
				subscriptions++;
				return Stream.never;
			})
		);
		try {
			assert.equal(await query, 1);
			assert.equal(
				await run(
					Effect.gen(function* () {
						return yield* query;
					})
				),
				2
			);
			assert.equal(subscriptions, 0);
		} finally {
			await dispose();
		}
	})
);

it.live(
	'Query component reads receive live answers and release their subscription on teardown',
	() =>
		browser(async () => {
			const dispose = edge();
			const values = await run(SubscriptionRef.make(1));
			let released = false,
				reads = 0;
			const target = document.createElement('div');
			document.body.append(target);
			const app = mount(QueryHarness, {
				target,
				props: {
					once: Effect.sync(() => ++reads),
					stream: SubscriptionRef.changes(values).pipe(
						Stream.ensuring(
							Effect.sync(() => {
								released = true;
							})
						)
					)
				}
			});
			try {
				flushSync();
				await settle();
				flushSync();
				assert.equal(target.querySelector('output')?.textContent, '1');
				await run(SubscriptionRef.set(values, 2));
				flushSync();
				await settle();
				flushSync();
				assert.equal(target.querySelector('output')?.textContent, '2');
				assert.equal(reads, 0);
			} finally {
				await unmount(app);
				target.remove();
				await settle();
				await dispose();
			}
			assert.equal(released, true);
		})
);

it.live('a day clock crosses workspace midnight while a snapshot stays fixed', () =>
	browser(async () => {
		vi.useFakeTimers();
		let at = new Date('2026-10-24T15:59:59.999Z');
		const target = document.createElement('div');
		document.body.append(target);
		const now = () => at;
		const live = mount(ClockHarness, {
			target,
			props: { unit: 'day', zone: 'Asia/Singapore', now }
		});
		const fixed = mount(ClockHarness, { target, props: { zone: 'Asia/Singapore', now } });
		try {
			flushSync();
			assert.deepEqual(
				[...target.querySelectorAll('output')].map((o) => o.textContent),
				[at.toISOString(), at.toISOString()]
			);
			at = new Date('2026-10-24T16:00:00.000Z');
			await vi.advanceTimersByTimeAsync(1);
			flushSync();
			assert.deepEqual(
				[...target.querySelectorAll('output')].map((o) => o.textContent),
				[at.toISOString(), '2026-10-24T15:59:59.999Z']
			);
		} finally {
			await unmount(live);
			await unmount(fixed);
			target.remove();
			vi.useRealTimers();
		}
	})
);

it.live('Query awaited in a derived and markup follows live answers through one subscription', () =>
	browser(async () => {
		const dispose = edge();
		const values = await run(SubscriptionRef.make(1));
		let reads = 0,
			subscriptions = 0,
			released = 0;
		const stream = Stream.suspend(() => {
			subscriptions++;
			return SubscriptionRef.changes(values).pipe(
				Stream.ensuring(
					Effect.sync(() => {
						released++;
					})
				)
			);
		});
		const target = document.createElement('div');
		document.body.append(target);
		const app = mount(AsyncQueryHarness, {
			target,
			props: { once: Effect.sync(() => ++reads), stream }
		});
		try {
			flushSync();
			await settle();
			flushSync();
			await settle();
			flushSync();
			assert.deepEqual(
				[...target.querySelectorAll('output')].map((o) => o.textContent),
				['1', '1']
			);
			await run(SubscriptionRef.set(values, 2));
			flushSync();
			await settle();
			flushSync();
			await settle();
			flushSync();
			assert.deepEqual(
				[...target.querySelectorAll('output')].map((o) => o.textContent),
				['2', '2']
			);
			assert.equal(reads, 0);
			assert.equal(subscriptions, 1);
		} finally {
			await unmount(app);
			target.remove();
			await settle();
			await dispose();
		}
		assert.equal(released, 1);
	})
);
