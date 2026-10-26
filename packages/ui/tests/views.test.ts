import './dom.ts';
import { required, textOf, browser } from './view-fixture.ts';
import assert from 'node:assert/strict';
import { it, vi } from '@effect/vitest';
import { and, compact } from '../src/filter/scope.ts';
import { countOf } from '../src/read/results.ts';
import { flat } from '../src/read/aggregate.ts';
import { label, msg } from '../src/text/messages.ts';
import { like } from '../src/cell/value.ts';
import { matrixCells, cellKey } from '../src/matrix/cells.ts';
import { pivotGrid } from '../src/pivot/grid.ts';
import { progressOf, runFiles } from '../src/runs/facts.ts';
import { rangeText, searchRows, readTableState, writeTableState } from '../src/table/model.ts';
import { readState, failed } from '../src/read/state.ts';
import { rowsOps } from '../src/relations/operations.ts';
import { series } from '../src/chart/series.ts';
import type { Page } from '../src/collection/types.ts';
import type { Query } from '../src/client/contract.ts';
import { reactive } from './kit-state.svelte.js';
import { heavySelect, listSelect, unref, refOf } from '../src/relations/select.ts';
import { Deferred, Effect, Queue } from 'effect';
import { Decimal } from '@norbital-ai/std/decimal';
import { formatValue as show } from '../src/kinds/kind.ts';
import { viewFixture } from './view-fixture.ts';
import type { KindsHost } from '../src/kinds/context.ts';
import type { Json } from '@norbital-ai/std/wire';
import type { Clip } from '../src/capture/capture.ts';
import { audioClip, guided, narrator, observe, HOLD_MS, target } from '../src/capture/capture.ts';

const bolt = { t: (k: string) => k };

it.effect('no grant is a state of its own, never an empty page', () =>
	Effect.sync(() => {
		assert.deepEqual(readState(undefined, Object.assign(new Error('x'), { code: 'forbidden' })), {
			kind: 'noAccess'
		});
		assert.deepEqual(readState({ rows: [], next: null }, undefined), {
			kind: 'ready',
			value: { rows: [], next: null }
		});
		assert.deepEqual(readState(undefined, undefined), { kind: 'loading' });
		assert.deepEqual(readState(undefined, undefined, false), { kind: 'empty' });
		assert.deepEqual(readState(null, undefined, false), { kind: 'ready', value: null });
		assert.equal(
			readState(undefined, Object.assign(new Error('big'), { code: 'tooLarge' })).kind,
			'error'
		);
		assert.deepEqual(failed(Object.assign(new Error('no'), { code: 'forbidden' })), {
			kind: 'noAccess'
		});
	})
);

it.effect('table cursor and search round-trip through the URL', () =>
	Effect.sync(() => {
		const p = writeTableState(new URLSearchParams('other=1'), 'quotes', { after: 'c1', q: 'acme' });
		assert.equal(p.get('other'), '1');
		assert.deepEqual(readTableState(p, 'quotes'), { after: 'c1', q: 'acme' });
		assert.equal(writeTableState(p, 'quotes', { after: null, q: '' }).toString(), 'other=1');
		assert.equal(and(undefined, {}, null), undefined);
		assert.deepEqual(and({ a: { eq: 1 } }, { b: { eq: 2 } }), {
			and: [{ a: { eq: 1 } }, { b: { eq: 2 } }]
		});
		assert.deepEqual(compact({ a: 1, b: undefined }), { a: 1 });
		assert.equal(like(3, '7'), 7);
		assert.deepEqual(
			searchRows(
				[
					{ id: 'a', name: 'Acme' },
					{ id: 'b', name: 'Beta' }
				],
				'ac',
				['name']
			).map((r) => r.id),
			['a']
		);
	})
);

it.live('a later page stays live through Query state; a restored cursor reads once', () =>
	Effect.gen(function* () {
		const lived: Json[] = [];
		const { bolt } = yield* browser(() =>
			viewFixture({
				read: (_collection, options) =>
					options.after === undefined
						? {
								rows: Array.from({ length: options.limit ?? 0 }, (_, i) => ({ id: String(i) })),
								next: 'n'
							}
						: { rows: [{ id: 'once' }], next: null },
				changes: (read) => {
					const options = read.a[1];
					assert.ok(options !== undefined);
					lived.push(options);
					return () => {};
				}
			})
		);
		const { flushSync, mount, tick, unmount } = yield* browser(() => import('svelte'));
		const { default: Harness } = yield* browser(() => import('./paging-harness.svelte'));
		const settle = async () => {
			for (let i = 0; i < 5; i++) {
				flushSync();
				await tick();
				await new Promise((resolve) => setTimeout(resolve, 0));
			}
		};
		const state = reactive<{
			read(limit: number, after?: string): Query<Page>;
			index: number | null;
			after: string | null;
		}>({
			read: (limit: number, after?: string) =>
				bolt.query<Page>('c', after === undefined ? { limit } : { limit, after }),
			index: 0,
			after: null
		});
		const target = document.body.appendChild(document.createElement('div'));
		const app = mount(Harness, { target, props: state });
		const shown = () => textOf(target.querySelector('output'));
		try {
			yield* browser(settle);
			assert.equal(shown(), Array.from({ length: 25 }, (_, i) => String(i)).join(','));
			state.index = 2;
			state.after = 'c2';
			yield* browser(settle);
			assert.deepEqual(lived.at(-1), { limit: 75 });
			assert.equal(shown(), Array.from({ length: 25 }, (_, i) => String(50 + i)).join(','));
			state.index = null;
			state.after = 'c9';
			yield* browser(settle);
			assert.equal(lived.length, 2);
			assert.equal(shown(), 'once');
		} finally {
			yield* browser(() => unmount(app));
			target.remove();
		}
	})
);

it.effect('range and count', () =>
	Effect.sync(() => {
		assert.equal(rangeText(bolt, 25, 25, 312), 'rows 26–50 of 312');
		assert.equal(rangeText(bolt, 0, 0, null), 'No rows');
		assert.equal(rangeText(bolt, 0, 1, 0), 'rows 1–1'); // a live row ahead of the 30 s count
		assert.equal(countOf([{ count: 12 }]), 12);
		assert.equal(countOf({ count: '7' }), 7);
		assert.equal(
			msg({ t: (k) => (k === 'ui.table.next' ? 'Suivant' : k) }, 'table.next', 'Next'),
			'Suivant'
		);
		assert.equal(label(bolt, 'leave_entries', 'start_part'), 'Start part');
	})
);

it.effect('values display by shape; masks are locked', () =>
	Effect.sync(() => {
		assert.equal(show({ $masked: true }), '•••');
		assert.equal(show(Decimal.of('1234.5'), 'en'), '1,234.5');
		assert.equal(show({ from: '2026-01-01', to: null }), '2026-01-01 – …');
		assert.equal(show({ id: 'f', name: 'a.pdf', mime: 'application/pdf' }), 'a.pdf');
		// `$bolt` decodes the wire: std's Decimal (no own fields, `toJSON` its `{ $dec }`, `String` its text) and an instant's ISO text
		const dec = Decimal.of('1234.5');
		assert.equal(show(dec, 'en'), '1,234.5');
		assert.equal(
			pivotGrid([{ key: { k: 'a' }, sum: { amount: dec } }], 'k', undefined, { sum: 'amount' })
				.total,
			1234.5
		);
		assert.equal(
			show('2026-01-02T03:04:05.000Z', 'en'),
			new Date('2026-01-02T03:04:05.000Z').toLocaleString('en', {
				dateStyle: 'medium',
				timeStyle: 'short'
			})
		);
	})
);

it.effect('Rows sends explicit ops; a delete is only what the viewer removed', () =>
	Effect.sync(() => {
		const loaded = [
			{ id: '1', qty: 1 },
			{ id: '2', qty: 2 },
			{ id: '3', qty: 3 }
		];
		const current: Parameters<typeof rowsOps>[1] = [
			{ id: '1', qty: 5 },
			{ id: '3', qty: 3 },
			{ qty: 9 }
		];
		assert.deepEqual(rowsOps(loaded, current, ['2']), {
			create: [{ qty: 9 }],
			update: [{ target: '1', set: { qty: 5 } }],
			delete: ['2']
		});
		assert.deepEqual(rowsOps(loaded, current, []), {
			create: [{ qty: 9 }],
			update: [{ target: '1', set: { qty: 5 } }]
		});
	})
);

it.effect('Rows ignores reordered object keys while preserving decimal and array edits', () =>
	Effect.sync(() => {
		const loaded = [{ id: '1', details: { amount: Decimal.of('1.20'), tags: ['a', 'b'] } }];
		const current = [{ id: '1', details: { tags: ['a', 'b'], amount: Decimal.of('1.20') } }];
		assert.deepEqual(rowsOps(loaded, current, []), {});
		current[0]!.details.amount = Decimal.of('2.00');
		assert.deepEqual(rowsOps(loaded, current, []), {
			update: [{ target: '1', set: { details: current[0]!.details } }]
		});
		current[0]!.details.amount = Decimal.of('1.20');
		assert.deepEqual(rowsOps(loaded, current, []), {});
		current[0]!.details.tags.reverse();
		assert.deepEqual(rowsOps(loaded, current, []), {
			update: [{ target: '1', set: { details: current[0]!.details } }]
		});
	})
);

it.effect('a heavy column widens the list read to the default row plus it', () =>
	Effect.sync(() => {
		const ex: NonNullable<KindsHost['catalog']>[string] = {
			label: ['name'],
			fields: {
				name: { kind: 'text' },
				doc: { kind: 'file', accept: ['*/*'], max: '20MiB' },
				raw: { kind: 'json' },
				'a.b': { kind: 'int' }
			},
			relations: { owner: { targets: ['people'] } }
		};
		assert.equal(heavySelect(ex, ['name']), undefined);
		assert.equal(heavySelect(undefined, ['doc']), undefined);
		assert.deepEqual(heavySelect(ex, ['created_at', 'doc']), {
			name: true,
			owner: true,
			created_at: true,
			doc: true
		});
	})
);

it.effect('a FK column reads its target label in the page read and shows it beside the id', () =>
	Effect.sync(() => {
		const cat: NonNullable<KindsHost['catalog']> = {
			orders: {
				label: ['no'],
				fields: { no: { kind: 'text' }, customer: { kind: 'text' }, spec: { kind: 'json' } },
				relations: { customer: { targets: ['customers'] }, arc: { targets: ['a', 'b'] } }
			},
			customers: {
				label: ['name', 'code', 'secret'],
				fields: { name: { kind: 'text' }, code: { kind: 'text' } }
			}
		};
		assert.equal(listSelect(cat, 'orders', ['no', 'arc']), undefined); // an arc keeps the plain read
		assert.deepEqual(listSelect(cat, 'orders', ['no', 'customer']), {
			no: true,
			customer: { select: { name: true, code: true } },
			arc: true
		});
		assert.deepEqual(listSelect(cat, 'orders', ['customer'], []), undefined); // an authored cell keeps the id
		const projected = unref(
			cat,
			'orders',
			['customer'],
			[
				{ id: 'o1', customer: { id: 'c1', name: 'Acme', code: 'A1' } },
				{ id: 'o2', customer: null }
			]
		);
		const a = required(projected[0]),
			b = required(projected[1]);
		assert.equal(a.customer, 'c1');
		assert.deepEqual(refOf(a, 'customer'), { of: 'customers', text: 'Acme · A1' });
		assert.equal(b.customer, null);
		assert.equal(refOf(b, 'customer'), undefined);
	})
);

it.effect('Matrix buckets items per row and column; a relation column reads its id', () =>
	Effect.sync(() => {
		const cells = matrixCells(
			[
				{ id: 'i1', employee: 'e1', day: '2026-09-01' },
				{ id: 'i2', employee: 'e1', day: '2026-09-01' },
				{ id: 'i3', employee: { collection: 'employees', id: 'e2' }, day: '2026-09-02' }
			],
			'employee',
			'day'
		);
		assert.deepEqual(
			cells.get(cellKey('e1', '2026-09-01'))?.map((r) => r.id),
			['i1', 'i2']
		);
		assert.deepEqual(
			cells.get(cellKey('e2', '2026-09-02'))?.map((r) => r.id),
			['i3']
		);
	})
);

it.effect('Pivot and Chart read aggregate rows', () =>
	Effect.sync(() => {
		const agg = [
			{ key: { region: 'N', stage: 'won' }, sum: { amount: Decimal.of('10') } },
			{ key: { region: 'N', stage: 'lost' }, sum: { amount: Decimal.of('5') } },
			{ key: { region: 'S', stage: 'won' }, sum: { amount: Decimal.of('2.5') } }
		];
		const flattened = flat(required(agg[0])),
			amount = flattened['sum.amount'];
		assert.ok(amount instanceof Decimal);
		assert.deepEqual(
			{ ...flattened, 'sum.amount': Number(String(amount)) },
			{ region: 'N', stage: 'won', 'sum.amount': 10 }
		);
		const g = pivotGrid(agg, 'region', 'stage', { sum: 'amount' });
		assert.deepEqual(
			[g.rowKeys, g.colKeys, g.at('S', 'lost'), g.rowTotal('N'), g.colTotal('won'), g.total],
			[['N', 'S'], ['won', 'lost'], 0, 15, 12.5, 17.5]
		);
		assert.deepEqual(
			series({ rows: [{ key: { month: '2026-01-01' }, count: 4 }], next: null }, 'month', [
				'count'
			]),
			[{ month: '2026-01-01', count: 4 }]
		);
	})
);

it.effect('run progress and returned files', () =>
	Effect.sync(() => {
		assert.equal(progressOf({ progress: { done: 1, total: 4 } }), 0.25);
		assert.equal(progressOf({ progress: 50 }), 0.5);
		assert.equal(progressOf({}), null);
		const f = { id: 'f1', name: 'bank.csv', mime: 'text/csv' };
		assert.deepEqual(runFiles({ result: { files: [f], count: 1 } }), [f]);
		assert.deepEqual(runFiles({ result: f }), [f]);
	})
);

it.effect('guided capture takes a pose only after a steady hold with a descriptor', () =>
	Effect.sync(() => {
		let s = guided(['straight', 'left']);
		const straight = { angle: { yaw: 0, pitch: 0 }, embedding: true };
		s = observe(s, straight, 0).state;
		assert.equal(observe(s, straight, HOLD_MS - 1).capture, null);
		assert.equal(observe(s, { ...straight, embedding: false }, HOLD_MS).state.heldSince, null);
		const step = observe(s, straight, HOLD_MS);
		assert.equal(step.capture, 'straight');
		assert.equal(target(step.state), 'left');
		// the person's left is negative yaw
		const left = observe(
			observe(step.state, { angle: { yaw: -0.4, pitch: 0 }, embedding: true }, 0).state,
			{ angle: { yaw: -0.4, pitch: 0 }, embedding: true },
			HOLD_MS
		);
		assert.equal(left.capture, 'left');
		assert.equal(target(left.state), null);
	})
);

it.effect(
	'the narrator plays one clip at a time, skips missing clips, and evicts old phrases',
	() =>
		Effect.gen(function* () {
			const played: string[] = [];
			const clips: ((status: 'played' | 'missing' | 'stopped') => void)[] = [];
			const started = yield* Queue.unbounded<string>();
			let drained = yield* Deferred.make<void>();
			const play = (url: string): Effect.Effect<Clip> =>
				Effect.gen(function* () {
					const clip = yield* Deferred.make<'played' | 'missing' | 'stopped'>();
					played.push(url);
					yield* Queue.offer(started, url);
					clips.push((status) => {
						Deferred.doneUnsafe(clip, Effect.succeed(status));
					});
					return {
						done: Deferred.await(clip),
						stop: Deferred.succeed(clip, 'stopped').pipe(Effect.asVoid)
					};
				});
			yield* Effect.scoped(
				Effect.gen(function* () {
					const n = yield* narrator(
						play,
						{
							a: { en: 'a.mp3' },
							b: { en: 'b.mp3' },
							c: { en: 'c.mp3' },
							d: { en: 'd.mp3' },
							get nothing() {
								Deferred.doneUnsafe(drained, Effect.void);
								return {};
							}
						},
						() => 'en'
					);
					yield* n.say('a');
					assert.equal(yield* Queue.take(started), 'a.mp3');
					for (const phrase of ['a', 'b', 'c', 'd', 'nothing']) yield* n.say(phrase);
					assert.deepEqual(played, ['a.mp3']);
					const first = clips[0];
					assert.ok(first);
					first('played');
					assert.equal(yield* Queue.take(started), 'd.mp3');
					assert.deepEqual(played, ['a.mp3', 'd.mp3']);
					const second = clips[1];
					assert.ok(second);
					second('missing');
					yield* Deferred.await(drained);
					drained = yield* Deferred.make<void>();
					yield* n.say('d');
					yield* n.say('nothing');
					yield* Deferred.await(drained);
					assert.deepEqual(played, ['a.mp3', 'd.mp3']);
					assert.ok(n.missing.has('d.mp3'));
				})
			);
		})
);

const audioProbe = (play: () => Promise<void>) =>
	Effect.acquireRelease(
		Effect.sync(() => {
			class AudioProbe extends EventTarget {
				static readonly instances: AudioProbe[] = [];
				pauses = 0;
				constructor(_url: string) {
					super();
					AudioProbe.instances.push(this);
				}
				play() {
					return play();
				}
				pause() {
					this.pauses++;
				}
			}
			vi.stubGlobal('Audio', AudioProbe);
			return AudioProbe;
		}),
		() => Effect.sync(() => vi.unstubAllGlobals())
	);

it.effect('audio completion removes both event listeners and settles exactly once', () =>
	Effect.scoped(
		Effect.gen(function* () {
			const started = yield* Deferred.make<void>();
			const Audio = yield* audioProbe(() => {
				Deferred.doneUnsafe(started, Effect.void);
				return Promise.resolve();
			});
			const clip = yield* audioClip('prompt.mp3');
			yield* Deferred.await(started);
			const audio = required(Audio.instances[0]);
			const removed = yield* Effect.acquireRelease(
				Effect.sync(() => vi.spyOn(audio, 'removeEventListener')),
				(spy) => Effect.sync(() => spy.mockRestore())
			);
			audio.dispatchEvent(new Event('ended'));
			audio.dispatchEvent(new Event('error'));
			yield* clip.stop;
			assert.equal(yield* clip.done, 'played');
			assert.equal(audio.pauses, 1);
			assert.deepEqual(removed.mock.calls.map(([event]) => event).sort(), ['ended', 'error']);
		})
	)
);

it.effect('an autoplay refusal is stopped and a later attempt can play the same URL', () =>
	Effect.scoped(
		Effect.gen(function* () {
			let attempts = 0;
			const started = yield* Queue.unbounded<void>();
			const Audio = yield* audioProbe(() => {
				Queue.offerUnsafe(started, undefined);
				return ++attempts === 1
					? Promise.reject(new DOMException('Touch first', 'NotAllowedError'))
					: Promise.resolve();
			});
			const refused = yield* Effect.scoped(
				Effect.gen(function* () {
					const clip = yield* audioClip('prompt.mp3');
					return yield* clip.done;
				})
			);
			assert.equal(refused, 'stopped');
			yield* Queue.take(started);
			const clip = yield* audioClip('prompt.mp3');
			yield* Queue.take(started);
			required(Audio.instances[1]).dispatchEvent(new Event('ended'));
			assert.equal(yield* clip.done, 'played');
		})
	)
);

it.effect('closing the audio scope stops a pending clip exactly once', () =>
	Effect.scoped(
		Effect.gen(function* () {
			const Audio = yield* audioProbe(() => Promise.resolve());
			const clip = yield* Effect.scoped(audioClip('prompt.mp3'));
			const audio = required(Audio.instances[0]);
			assert.equal(yield* clip.done, 'stopped');
			audio.dispatchEvent(new Event('error'));
			yield* clip.stop;
			assert.equal(yield* clip.done, 'stopped');
			assert.equal(audio.pauses, 1);
		})
	)
);

it.live(
	'the record scrubber: history as checkpoints, and a ruler that compresses but keeps the playhead',
	() =>
		Effect.gen(function* () {
			const { checkpoints, tickAt, tickOf, drawnTicks } = yield* browser(
				() => import('../src/record/history.ts')
			);
			const history = [
				{
					revision: 2,
					at: '2026-09-02T00:00:00.000Z',
					actor: { kind: 'system', id: 'run1' },
					restoredFrom: 1,
					approval: { request: 'r1', state: 'Rejected' },
					changed: { status: 'done', updated_at: 'x', revision: 2 }
				},
				{
					revision: 1,
					at: '2026-09-01T00:00:00.000Z',
					actor: { kind: 'member', id: 'u1' },
					changed: { title: 'Paint', id: 'j1' }
				},
				{ revision: 3, at: null, actor: null, changed: null }
			];
			assert.deepEqual(checkpoints(history), [
				{
					revision: 1,
					at: '2026-09-01T00:00:00.000Z',
					actor: { kind: 'member', id: 'u1' },
					fields: ['title'],
					restoredFrom: null,
					approval: null
				},
				{
					revision: 2,
					at: '2026-09-02T00:00:00.000Z',
					actor: { kind: 'system', id: 'run1' },
					fields: ['status'],
					restoredFrom: 1,
					approval: { request: 'r1', state: 'Rejected' }
				},
				{ revision: 3, at: null, actor: null, fields: [], restoredFrom: null, approval: null }
			]);
			assert.deepEqual(checkpoints(null), []);
			assert.equal(tickAt(1, 5), 0);
			assert.equal(tickAt(5, 5), 100);
			assert.equal(tickAt(1, 1), 100);
			assert.equal(tickOf(0, 5), 1);
			assert.equal(tickOf(1, 5), 5);
			assert.equal(tickOf(0.5, 5), 3);
			assert.equal(tickOf(-2, 5), 1);
			assert.deepEqual(drawnTicks(4, 120), [1, 2, 3, 4]);
			const many = drawnTicks(1000, 100, 437);
			assert.ok(many.length <= 102);
			assert.ok(many.includes(1) && many.includes(1000) && many.includes(437));
		})
);
