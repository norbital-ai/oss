import './dom.ts';
import assert from 'node:assert/strict';
import { it } from '@effect/vitest';
import { Deferred, Effect, Layer, ManagedRuntime, Stream } from 'effect';
import { browser, streamSource } from './view-fixture.ts';
const { mountEdge, runningFibers } = await import('../src/effect/index.ts');
const { flushSync, mount, tick, unmount } = await import('svelte');
const { default: QueryHarness } = await import('./query-harness.svelte');
const { default: LiveHarness } = await import('./query-live-harness.svelte');
const { reactive } = await import('./kit-state.svelte.js');
const settle = async () => {
	flushSync();
	await tick();
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
	flushSync();
};
const edge = () =>
	Effect.acquireRelease(
		Effect.sync(() => mountEdge(ManagedRuntime.make(Layer.empty))),
		(dispose) => browser(dispose).pipe(Effect.orDie)
	);
const text = (target: HTMLElement, selector: string) => target.querySelector(selector)?.textContent;

it.live('one-shot query owns loading, typed errors, refetch and current getter reactivity', () =>
	Effect.gen(function* () {
		yield* edge();
		const answer = yield* Deferred.make<string | undefined, Error>();
		let reads = 0;
		const state = reactive({
			source: (): Effect.Effect<string | undefined, Error> | null =>
				Effect.sync(() => {
					reads++;
				}).pipe(Effect.andThen(Deferred.await(answer)))
		});
		const target = document.body.appendChild(document.createElement('div'));
		yield* Effect.acquireRelease(
			Effect.sync(() => mount(QueryHarness, { target, props: state })),
			(app) =>
				browser(async () => {
					await unmount(app);
					target.remove();
				}).pipe(Effect.orDie)
		);
		yield* browser(settle);
		assert.equal(text(target, '[data-loading]'), 'true');
		assert.equal(reads, 1);
		yield* Deferred.succeed(answer, 'first');
		yield* browser(settle);
		assert.equal(text(target, 'output'), 'first');
		assert.equal(text(target, '[data-loading]'), 'false');
		target.querySelector('button')?.click();
		yield* browser(settle);
		assert.equal(reads, 2);
		state.source = () => Effect.fail(new Error('No access'));
		yield* browser(settle);
		assert.equal(text(target, 'output'), 'empty');
		assert.equal(text(target, '[data-error]'), 'No access');
		assert.equal(text(target, '[data-tag]'), 'Failure');
		state.source = () => Effect.succeed(undefined);
		yield* browser(settle);
		assert.equal(text(target, '[data-tag]'), 'Success');
		assert.equal(text(target, '[data-error]'), '');
		assert.equal(text(target, '[data-loading]'), 'false');
		state.source = () => Effect.interrupt;
		yield* browser(settle);
		assert.equal(text(target, '[data-tag]'), 'Initial');
		assert.equal(text(target, '[data-loading]'), 'false');
		state.source = () => null;
		yield* browser(settle);
		assert.equal(text(target, '[data-tag]'), 'Initial');
		assert.equal(text(target, '[data-loading]'), 'false');
	}).pipe(Effect.scoped)
);

it.live(
	'query scope changes cannot publish a late uninterruptible answer or its initial seed',
	() =>
		Effect.gen(function* () {
			const before = runningFibers();
			yield* edge();
			const old = yield* Deferred.make<string, Error>();
			const next = yield* Deferred.make<string, Error>();
			const state = reactive({ source: () => Deferred.await(old).pipe(Effect.uninterruptible) });
			const target = document.body.appendChild(document.createElement('div'));
			yield* Effect.acquireRelease(
				Effect.sync(() =>
					mount(QueryHarness, {
						target,
						props: { source: () => state.source(), options: { initial: 'server' } }
					})
				),
				(app) =>
					browser(async () => {
						await unmount(app);
						target.remove();
					}).pipe(Effect.orDie)
			);
			yield* browser(settle);
			assert.equal(text(target, 'output'), 'server');
			state.source = () => Deferred.await(next);
			yield* browser(settle);
			assert.equal(text(target, 'output'), 'empty');
			yield* Deferred.succeed(next, 'new');
			yield* browser(settle);
			yield* Deferred.succeed(old, 'stale');
			yield* browser(settle);
			assert.equal(text(target, 'output'), 'new');
			assert.equal(text(target, '[data-loading]'), 'false');
			assert.equal(runningFibers(), before);
		}).pipe(Effect.scoped)
);

it.live('stream query clears previous data on failure and settles finite empty sources', () =>
	Effect.gen(function* () {
		yield* edge();
		const first = streamSource<string | undefined, Error>();
		const state = reactive({
			source: (): Stream.Stream<string | undefined, Error> | null => first.stream
		});
		const target = document.body.appendChild(document.createElement('div'));
		yield* Effect.acquireRelease(
			Effect.sync(() => mount(LiveHarness, { target, props: state })),
			(app) =>
				browser(async () => {
					await unmount(app);
					target.remove();
				}).pipe(Effect.orDie)
		);
		yield* browser(settle);
		first.emit('private');
		yield* browser(settle);
		assert.equal(text(target, 'output'), 'private');
		assert.equal(text(target, '[data-loading]'), 'false');
		first.fail(new Error('forbidden'));
		yield* browser(settle);
		assert.equal(text(target, 'output'), 'empty');
		assert.equal(text(target, '[data-error]'), 'forbidden');
		state.source = () => Stream.empty;
		yield* browser(settle);
		assert.equal(text(target, '[data-tag]'), 'Initial');
		assert.equal(text(target, '[data-loading]'), 'false');
		assert.equal(text(target, '[data-error]'), '');
		assert.equal(first.listeners.size, 0);
	}).pipe(Effect.scoped)
);
