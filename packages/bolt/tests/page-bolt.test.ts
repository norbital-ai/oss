// Browser reads and operations have one Effect contract; live answers have one Stream contract.
import { Cause, Effect, Deferred, Exit, Fiber, Queue, Schema, Stream } from 'effect';
import { describe, expect, it } from '@effect/vitest';
import { Decimal } from '@norbital-ai/std/decimal';
import { createBolt, patched } from '../src/page/bolt.ts';
import type { EventSourceLike } from '../src/page/stream.ts';
import {
	ActConflict,
	ActRefused,
	ActUnknown,
	ReadFailed,
	Refusal,
	TransportFailed
} from '../src/decl/errors.ts';
import { PATHS, type Frame } from '../src/protocol/wire.ts';

const client = (answer: (url: string, body: unknown) => Response) =>
	Effect.gen(function* () {
		const sent: unknown[] = [];
		const fetch: typeof globalThis.fetch = async (url, init) => {
			const request = new Request(url, init);
			const body: unknown =
				request.body === null
					? null
					: request.headers.get('content-type')?.includes('application/json')
						? await request.json()
						: await request.text();
			sent.push(body);
			return answer(new URL(request.url).pathname, body);
		};
		const bolt = yield* createBolt({
			actor: null,
			locale: 'en',
			base: 'https://workspace.test',
			fetch,
			uuid: () => 'k1'
		});
		return { sent, bolt };
	});
const outcome = (answer: unknown) => () => Response.json({ outcome: answer, v: 0 });

describe('reads', () => {
	it.effect('a read carries its wire form and revives its answer when run', () =>
		Effect.gen(function* () {
			const { bolt, sent } = yield* client(() =>
				Response.json({ answers: [{ rows: [{ id: 'a', amount: { $dec: '1.50' } }], next: null }] })
			);
			const read = bolt.read<{ rows: { amount: Decimal }[] }>('jobs', { limit: 1 });
			expect(read.read).toEqual({ m: 'read', a: ['jobs', { limit: 1 }] });
			expect('then' in read).toBe(false);
			expect(sent).toHaveLength(0);
			const answer = yield* read;
			expect(answer.rows[0]?.amount).toBeInstanceOf(Decimal);
			expect(answer.rows[0]?.amount.plus('1').toString()).toBe('2.50');
			expect(sent).toHaveLength(1);
		})
	);
	it.effect('a refused read is ReadFailed; a missing transport is TransportFailed', () =>
		Effect.gen(function* () {
			const { bolt } = yield* client(() =>
				Response.json({ error: { code: 'forbidden', message: 'No access' } }, { status: 403 })
			);
			const failure = yield* Effect.flip(bolt.read('jobs', { limit: 1 }));
			expect(failure).toBeInstanceOf(ReadFailed);
			expect(failure).toMatchObject({ code: 'forbidden', message: 'No access' });
			const offline = yield* createBolt({
				actor: null,
				locale: 'en',
				base: 'https://workspace.test',
				fetch: async () => {
					throw new TypeError('offline');
				}
			});
			expect(yield* Effect.flip(offline.get('jobs', 'j1'))).toBeInstanceOf(TransportFailed);
		})
	);
	it.effect('live revives answers and a refusal ends the Stream', () =>
		Effect.gen(function* () {
			let source: EventSourceLike | undefined;
			const opened = yield* Deferred.make<void>();
			const registered = yield* Deferred.make<void>();
			const answered = yield* Queue.unbounded<{ rows: { amount: Decimal }[] }>();
			const bolt = yield* createBolt({
				actor: null,
				locale: 'en',
				base: 'https://workspace.test',
				fetch: async () => {
					Deferred.doneUnsafe(registered, Effect.void);
					return Response.json({ errors: [] });
				},
				openStream: () => {
					let handler: EventSourceLike['onmessage'] = null;
					source = {
						get onmessage() {
							return handler;
						},
						set onmessage(next) {
							handler = next;
							if (next !== null) Deferred.doneUnsafe(opened, Effect.void);
						},
						onerror: null,
						close() {}
					};
					return source;
				}
			});
			const view = bolt.live<{ rows: { amount: Decimal }[] }>(bolt.read('jobs', { all: true }));
			const seen: { rows: { amount: Decimal }[] }[] = [];
			const fiber = yield* Stream.runForEach(view, (answer) =>
				Effect.sync(() => {
					seen.push(answer);
					Queue.offerUnsafe(answered, answer);
				})
			).pipe(Effect.forkScoped);
			yield* Deferred.await(opened);
			const push = (frame: Frame) =>
				source?.onmessage?.(new MessageEvent('message', { data: JSON.stringify(frame) }));
			push({ t: 'hello', conn: 'c1', v: 0 });
			yield* Deferred.await(registered);
			push({
				t: 'answer',
				view: 'v1',
				v: 1,
				value: { rows: [{ id: 'a', amount: { $dec: '2' } }], next: null }
			});
			yield* Queue.take(answered);
			expect(seen[0]?.rows[0]?.amount).toBeInstanceOf(Decimal);
			push({ t: 'error', view: 'v1', code: 'tooLarge', message: 'too big' });
			const exit = yield* Fiber.await(fiber);
			expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toEqual(
				new ReadFailed({ code: 'tooLarge', message: 'too big' })
			);
		})
	);
});

describe('acts, starts, uploads and the session', () => {
	it.effect('acts are lazy and their refusal carries the field', () =>
		Effect.gen(function* () {
			const { bolt, sent } = yield* client(
				outcome({ kind: 'refused', code: 'refused', message: 'Closed', field: 'status' })
			);
			const act = bolt.act('jobs.update', { target: 'j1', set: { status: 'x' } });
			expect(sent).toHaveLength(0);
			const field = yield* act.pipe(
				Effect.map(() => null),
				Effect.catchTag('ActRefused', (failure) => Effect.succeed(failure.field ?? null))
			);
			expect(field).toBe('status');
			expect(sent).toHaveLength(1);
		})
	);
	it.effect('conflicts and unconfirmed acts fail; a committed output is revived', () =>
		Effect.gen(function* () {
			const conflict = (yield* client(
				outcome({
					kind: 'conflict',
					records: [{ collection: 'jobs', id: 'j1', fields: ['title'] }]
				})
			)).bolt;
			expect(
				yield* Effect.flip(conflict.act('jobs.update', { target: 'j1', set: {} }))
			).toBeInstanceOf(ActConflict);
			const offline = yield* createBolt({
				actor: null,
				locale: 'en',
				base: 'https://workspace.test',
				uuid: () => 'k9',
				fetch: async () => {
					throw new TypeError('offline');
				}
			});
			expect(yield* Effect.flip(offline.act('jobs.create', {}))).toEqual(
				new ActUnknown({ invocation: 'k9' })
			);
			const done = (yield* client(
				outcome({ kind: 'committed', output: { total: { $dec: '9.00' } }, records: [] })
			)).bolt;
			const committed = yield* done.act('jobs.total', {});
			if (committed.kind !== 'committed') throw new Error('expected committed');
			expect(Object.values(committed.output ?? {})[0]).toBeInstanceOf(Decimal);
			const refused = (yield* client(
				outcome({ kind: 'refused', code: 'forbidden', message: 'No.' })
			)).bolt;
			expect(yield* Effect.flip(refused.act('jobs.create', {}))).toBeInstanceOf(ActRefused);
		})
	);
	it.effect('start names its run at once and sends one request when run', () =>
		Effect.gen(function* () {
			const { bolt, sent } = yield* client(
				outcome({ kind: 'committed', output: null, records: [] })
			);
			const start = bolt.start('sync', {});
			expect([start.id, start.automation]).toEqual(['k1', 'sync']);
			expect(yield* start).toMatchObject({ kind: 'committed' });
			expect(sent).toEqual([
				{
					callable: 'start',
					input: { automation: 'sync', runs: [{ input: {}, id: 'k1' }] },
					issuedAt: expect.any(String)
				}
			]);
		})
	);
	it.effect('approvals and uploads revive every answer; an upload refusal retains its code', () =>
		Effect.gen(function* () {
			const { bolt } = yield* client((url) =>
				url.startsWith(PATHS.approval)
					? Response.json({
							value: [
								{
									id: 'r1',
									log: [
										{
											move: 'comment',
											by: { ref: 'member:u1', name: 'Ada' },
											at: '2026-10-13T00:00:00Z',
											from: 'ONGOING',
											to: 'ONGOING',
											step: 0,
											reason: { $dec: '3.10' }
										}
									]
								}
							]
						})
					: Response.json({ id: 'f1', name: 'a.pdf', mime: 'application/pdf', size: { $dec: '1' } })
			);
			const [view] = yield* bolt.approvals.list({ collection: 'jobs' });
			// the approval wire revives typed values like every other answer
			expect(view?.log[0]?.reason).toBeInstanceOf(Decimal);
			const ref = yield* bolt.upload(new Blob(['x']), 'jobs.file');
			const metadata = yield* Schema.decodeUnknownEffect(Schema.Struct({ size: Schema.Unknown }))(
				ref
			);
			expect(metadata.size).toBeInstanceOf(Decimal);
			const refusing = (yield* client(() =>
				Response.json({ error: { code: 'tooLarge', message: 'Too large.' } }, { status: 413 })
			)).bolt;
			expect(yield* Effect.flip(refusing.upload(new Blob(['x']), 'jobs.file'))).toMatchObject({
				_tag: 'ActRefused',
				code: 'tooLarge'
			});
		})
	);
	it.effect('a sign-in refusal is a Refusal with the host message', () =>
		Effect.gen(function* () {
			const { bolt } = yield* client(() =>
				Response.json({ error: { code: 'invalidInput', message: 'Wrong code.' } }, { status: 400 })
			);
			expect(yield* Effect.flip(bolt.session.sendCode('+6590000000'))).toEqual(
				new Refusal({ message: 'Wrong code.' })
			);
		})
	);
});

describe('live patches on a page value', () => {
	it('set a top-level value beside the rows (meta) without touching them, and refuse it on a single row', () => {
		const page = { status: 'running', rows: [{ id: 'a' }] };
		expect(patched(page, [{ op: 'meta', key: 'status', value: 'stopped' }])).toEqual({
			status: 'stopped',
			rows: [{ id: 'a' }]
		});
		expect(patched({ id: 'a' }, [{ op: 'meta', key: 'status', value: 'stopped' }])).toBe(undefined);
	});
});
