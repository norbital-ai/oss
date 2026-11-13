// Browser reads and operations have one Effect contract; live answers have one Stream contract.
import {
	Cause,
	Effect,
	Deferred,
	Exit,
	Fiber,
	Layer,
	ManagedRuntime,
	Queue,
	Schema,
	Stream
} from 'effect';
import { mount_edge } from '@norbital-ai/ui/effect';
import { describe, expect, it } from '@effect/vitest';
import { input_schema } from '@norbital-ai/store/kind';
import { create_bolt, patched } from '../src/page/bolt.ts';
import type { EventSourceLike } from '../src/page/stream.ts';
import {
	ActConflict,
	ActRefused,
	ReadFailed,
	Unavailable
} from '../src/decl/errors.ts';
import { TransportFailed } from '../src/decl/errors/browser.ts';
import { ActUnknown } from '../src/decl/errors/act.ts';
import { Refusal } from '../src/decl/errors/refusal.ts';
import type { ApprovalView } from '../src/engine/approvals/approvals.ts';
import { PATHS, type Frame } from '../src/protocol/wire.ts';
import type {} from './types/registry.ts';

const page = <Row extends Schema.Struct.Fields>(row: Row) =>
	Schema.Struct({
		jobs: Schema.Struct({
			rows: Schema.Array(Schema.Struct(row)),
			next: Schema.NullOr(Schema.String),
			total: Schema.Number
		})
	});
const Amounts = page({ id: Schema.String, amount: input_schema({ kind: 'decimal', scale: 2 }) });
const Ids = page({ id: Schema.String });
const decimal = (value: unknown) => {
	if (!(typeof value === 'string')) throw new Error('Expected decimal text');
	return value;
};
const all_jobs = { read: { m: 'query', a: [{ jobs: {} }] } } as const;

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
		const bolt = yield* create_bolt({
			operation_outputs: { automations: {} },
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
				Response.json({
					answers: [
						{ jobs: { rows: [{ id: 'a', amount: '1.50' }], next: null, total: 1 } }
					]
				})
			);
			const read = bolt.native_query({ m: 'query', a: [{ jobs: { limit: 1 } }] }, Amounts);
			expect(read.read).toEqual({ m: 'query', a: [{ jobs: { limit: 1 } }] });
			expect('then' in read).toBe(true);
			expect(sent).toHaveLength(0);
			const answer = yield* read;
			expect(answer.jobs.rows[0]?.amount).toBeTypeOf('string');
			expect(Number(decimal(answer.jobs.rows[0]?.amount)) + 1).toBe(2.5);
			expect(sent).toHaveLength(1);
			yield* Effect.acquireRelease(
				Effect.sync(() => mount_edge(ManagedRuntime.make(Layer.empty))),
				(dispose) => Effect.promise(dispose)
			);
			const awaited = yield* Effect.promise(async () => await read);
			expect(awaited.jobs.rows[0]?.amount).toBeTypeOf('string');
			expect(sent).toHaveLength(2);
		})
	);
	it.effect('a refused read is ReadFailed; a missing transport is TransportFailed', () =>
		Effect.gen(function* () {
			const { bolt } = yield* client(() =>
				Response.json({ error: { code: 'forbidden', message: 'No access' } }, { status: 403 })
			);
			const failure = yield* Effect.flip(
				bolt.native_query({ m: 'query', a: [{ jobs: { limit: 1 } }] }, Amounts)
			);
			expect(failure).toBeInstanceOf(ReadFailed);
			expect(failure).toMatchObject({ code: 'forbidden', message: 'No access' });
			const offline = yield* create_bolt({
				operation_outputs: { automations: {} },
				actor: null,
				locale: 'en',
				base: 'https://workspace.test',
				fetch: async () => {
					throw new TypeError('offline');
				}
			});
			expect(
				yield* Effect.flip(
					offline.native_query({ m: 'query', a: [{ jobs: { where: { id: { eq: 'j1' } } } }] }, Ids)
				)
			).toBeInstanceOf(TransportFailed);
		})
	);
	it.effect('live revives answers and a refusal ends the Stream', () =>
		Effect.gen(function* () {
			let source: EventSourceLike | undefined;
			const opened = yield* Deferred.make<void>();
			const registered = yield* Deferred.make<void>();
			type Jobs = typeof Amounts.Type;
			const answered = yield* Queue.unbounded<Jobs>();
			const bolt = yield* create_bolt({
				operation_outputs: { automations: {} },
				actor: null,
				locale: 'en',
				base: 'https://workspace.test',
				fetch: async () => {
					Deferred.doneUnsafe(registered, Effect.void);
					return Response.json({ errors: [] });
				},
				open_stream: () => {
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
			const view = bolt.observe(all_jobs, Amounts);
			const seen: Jobs[] = [];
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
				value: { jobs: { rows: [{ id: 'a', amount: '2' }], next: null, total: 1 } }
			});
			yield* Queue.take(answered);
			expect(seen[0]?.jobs.rows[0]?.amount).toBeTypeOf('string');
			push({ t: 'error', view: 'v1', code: 'too_large', message: 'too big' });
			const exit = yield* Fiber.await(fiber);
			expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toEqual(
				new ReadFailed({ code: 'too_large', message: 'too big' })
			);
		})
	);
	it.live('a live link a release closed comes back on the next generation', () =>
		Effect.gen(function* () {
			const opened = yield* Queue.unbounded<EventSourceLike>();
			const firstRegistration = yield* Deferred.make<void>();
			const secondRegistration = yield* Deferred.make<void>();
			const registers = [firstRegistration, secondRegistration];
			const bolt = yield* create_bolt({
				operation_outputs: { automations: {} },
				actor: null,
				locale: 'en',
				base: 'https://workspace.test',
				fetch: async () => {
					const next = registers.find((one) => !Deferred.isDoneUnsafe(one));
					if (next !== undefined) Deferred.doneUnsafe(next, Effect.void);
					return Response.json({ errors: [] });
				},
				open_stream: () => {
					let handler: EventSourceLike['onmessage'] = null;
					const source: EventSourceLike = {
						get onmessage() {
							return handler;
						},
						set onmessage(next) {
							handler = next;
							if (next !== null) Queue.offerUnsafe(opened, source);
						},
						onerror: null,
						close() {}
					};
					return source;
				}
			});
			const states: string[] = [];
			yield* Stream.runForEach(bolt.sync, (state) =>
				Effect.sync(() => void states.push(state))
			).pipe(Effect.forkScoped);
			yield* Stream.runDrain(bolt.observe(all_jobs, Ids)).pipe(Effect.forkScoped);
			const push = (source: EventSourceLike, frame: Frame) =>
				source.onmessage?.(new MessageEvent('message', { data: JSON.stringify(frame) }));
			const first = yield* Queue.take(opened);
			push(first, { t: 'hello', conn: 'c1', v: 0 });
			yield* Deferred.await(firstRegistration);
			push(first, { t: 'close', release: 'r1' });
			first.onerror?.(new Event('error'));
			const second = yield* Queue.take(opened);
			expect(bolt.closed).toBe('r1');
			push(second, { t: 'hello', conn: 'c2', v: 0 });
			// the views register again on the new connection
			yield* Deferred.await(secondRegistration);
			expect(bolt.closed).toBeNull();
			expect(states).toContain('closed');
			expect(states.at(-1)).toBe('live');
		})
	);
	it.effect('an optimistic money update keeps the decimal text of a live row', () =>
		Effect.gen(function* () {
			let source: EventSourceLike | undefined;
			const opened = yield* Deferred.make<void>();
			const registered = yield* Deferred.make<void>();
			const reply = yield* Deferred.make<Response>();
			const answered = yield* Queue.unbounded<typeof Amounts.Type>();
			const bolt = yield* create_bolt({
				operation_outputs: { automations: {} },
				actor: null,
				locale: 'en',
				base: 'https://workspace.test',
				fetch: async (url) => {
					if (String(url).endsWith(PATHS.act)) return Effect.runPromise(Deferred.await(reply));
					Deferred.doneUnsafe(registered, Effect.void);
					return Response.json({ errors: [] });
				},
				open_stream: () => {
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
			yield* Stream.runForEach(bolt.observe(all_jobs, Amounts), (answer) =>
				Queue.offer(answered, answer)
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
				value: {
					jobs: { rows: [{ id: 'a', amount: '1.50' }], next: null, total: 1 }
				}
			});
			yield* Queue.take(answered);
			const act = yield* bolt
				.act({
					'jobs.update': [{ target: { id: 'a', revision: 1 }, set: { amount: '0' } }]
				})
				.pipe(Effect.forkScoped);
			const painted = yield* Queue.take(answered);
			expect(painted.jobs.rows[0]?.amount).toBeTypeOf('string');
			expect(Number(decimal(painted.jobs.rows[0]?.amount))).toBe(0);
			yield* Deferred.succeed(
				reply,
				Response.json({ outcome: { kind: 'committed', output: { 'jobs.update': null }, records: [] }, v: 1 })
			);
			yield* Fiber.join(act);
		})
	);
	/** A client over one hand-driven stream; `fetch` answers every request. */
	const streamed = (fetch: typeof globalThis.fetch) =>
		Effect.gen(function* () {
			let source: EventSourceLike | undefined;
			const opened = yield* Deferred.make<void>();
			const bolt = yield* create_bolt({
				operation_outputs: { automations: {} },
				actor: null,
				locale: 'en',
				base: 'https://workspace.test',
				fetch,
				open_stream: () => {
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
			const fiber = yield* Stream.runDrain(bolt.observe(all_jobs, Ids)).pipe(Effect.forkScoped);
			yield* Deferred.await(opened);
			const push = (frame: Frame) =>
				source?.onmessage?.(new MessageEvent('message', { data: JSON.stringify(frame) }));
			return { bolt, fiber, push };
		});
	it.effect('a failed live registration fails the view instead of waiting', () =>
		Effect.gen(function* () {
			const { fiber, push } = yield* streamed(async () => {
				throw new TypeError('offline');
			});
			push({ t: 'hello', conn: 'c1', v: 0 });
			const exit = yield* Fiber.await(fiber);
			expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toMatchObject({
				_tag: 'ReadFailed',
				code: 'transport'
			});
		})
	);
	it.effect('a release closes the stream and the client says so (the shell reloads on it)', () =>
		Effect.gen(function* () {
			const { bolt, push } = yield* streamed(async () => Response.json({ errors: [] }));
			push({ t: 'hello', conn: 'c1', v: 0 });
			push({ t: 'close', release: 'r2' });
			yield* bolt.sync.pipe(
				Stream.takeUntil((state) => state === 'closed'),
				Stream.runDrain
			);
		})
	);
});

describe('PDF preview', () => {
	it.effect('returns PDF bytes from a lazy preview', () =>
		Effect.gen(function* () {
			const pdf = new TextEncoder().encode('%PDF');
			const { bolt, sent } = yield* client(
				() => new Response(pdf, { headers: { 'content-type': 'application/pdf' } })
			);
			const preview = bolt.preview_pdf({ markdown: '# Report' }, { page: 'A4' });
			expect(sent).toHaveLength(0);
			expect(yield* preview).toEqual(pdf);
			expect(sent).toEqual([
				{
					callable: 'convert.previewPdf',
					input: { source: { markdown: '# Report' }, options: { page: 'A4' } },
					issued_at: expect.any(String)
				}
			]);
		})
	);
	it.effect('reports an unavailable PDF preview as a typed failure', () =>
		Effect.gen(function* () {
			const { bolt } = yield* client(() =>
				Response.json(
					{ error: { code: 'unavailable', message: 'No document converter is bound.' } },
					{ status: 503 }
				)
			);
			expect(yield* Effect.flip(bolt.preview_pdf({ markdown: '# Report' }))).toEqual(
				new Unavailable({
					facility: 'convert.previewPdf',
					reason: 'No document converter is bound.'
				})
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
			const act = bolt.act({
				'jobs.update': [{ target: { id: 'j1', revision: 1 }, set: { status: 'x' } }]
			});
			expect(sent).toHaveLength(0);
			const field = yield* act.pipe(
				Effect.map(() => null),
				Effect.catchTag('ActRefused', (failure) => Effect.succeed(failure.field ?? null))
			);
			expect(field).toBe('status');
			expect(sent).toHaveLength(1);
		})
	);
	it.effect("a busy host's refusal is refused (nothing ran), not unknown", () =>
		Effect.gen(function* () {
			const busy = 'This workspace is busy. Please try again shortly.';
			const { bolt } = yield* client(() =>
				Response.json({ error: { code: 'busy', message: busy } }, { status: 503 })
			);
			expect(
				yield* Effect.flip(bolt.approvals.decide('r1', { decision: 'reject', reason: 'No' }))
			).toMatchObject({ _tag: 'ActRefused', code: 'rate_limited', message: busy });
		})
	);
	it.effect('conflicts and unconfirmed acts fail; a committed output is revived', () =>
		Effect.gen(function* () {
			const conflict = (yield* client(
				outcome({
					kind: 'conflict',
					records: [{ model: 'jobs', id: 'j1' }]
				})
			)).bolt;
			expect(
				yield* Effect.flip(
					conflict.act({ 'jobs.update': [{ target: { id: 'j1', revision: 1 }, set: {} }] })
				)
			).toBeInstanceOf(ActConflict);
			const offline = yield* create_bolt({
				operation_outputs: { automations: {} },
				actor: null,
				locale: 'en',
				base: 'https://workspace.test',
				uuid: () => 'k9',
				fetch: async () => {
					throw new TypeError('offline');
				}
			});
			expect(yield* Effect.flip(offline.act({ 'jobs.create': [{}] }))).toEqual(
				new ActUnknown({ invocation: 'k9' })
			);
			const done = yield* create_bolt({
				actor: null,
				locale: 'en',
				base: 'https://workspace.test',
				operation_outputs: {
					automations: {
						total: {
							mode: 'call',
							output: {
								kind: 'object',
								fields: {
									total: {
										optional: false,
										value: { kind: 'atom', spec: { kind: 'decimal', scale: 2 } }
									}
								}
							}
						}
					}
				},
				fetch: async () =>
					Response.json({
						outcome: { kind: 'committed', output: { total: '9.00' }, records: [] },
						v: 0
					})
			});
			const call = done.run('total', {});
			if (call.mode !== 'call') throw new Error('expected an in-request call');
			expect(yield* call).toMatchObject({ total: expect.any(String) });
			const refused = (yield* client(
				outcome({ kind: 'refused', code: 'forbidden', message: 'No.' })
			)).bolt;
			expect(yield* Effect.flip(refused.act({ 'jobs.create': [{}] }))).toBeInstanceOf(ActRefused);
		})
	);
	it.effect('run names its job at once and submits it when executed', () =>
		Effect.gen(function* () {
			const { bolt, sent } = yield* client(
				outcome({
					kind: 'committed',
					output: { id: 'k1', ids: ['k1'], automation: 'sync' },
					records: []
				})
			);
			expect(() => bolt.run('sync', [])).toThrow('An automation batch needs at least one input.');
			const run = bolt.run('sync', {});
			if (run.mode !== 'job') throw new Error('expected a durable job');
			expect([run.mode, run.id, run.ids, run.automation]).toEqual(['job', 'k1', ['k1'], 'sync']);
			expect(yield* run).toMatchObject({
				kind: 'committed',
				output: { id: 'k1', ids: ['k1'], automation: 'sync' }
			});
			expect(sent).toEqual([
				{
					callable: 'run',
					input: { automation: 'sync', runs: [{ input: {}, id: 'k1' }] },
					issued_at: expect.any(String)
				}
			]);
		})
	);
	it.effect('approvals and uploads revive every answer; an upload refusal retains its code', () =>
		Effect.gen(function* () {
			const approval: ApprovalView = {
				id: 'r1',
				model: 'jobs',
				record: 'j1',
				action: 'create',
				label: null,
				at: '2026-10-13T00:00:00Z',
				status: 'Pending',
				step: 0,
				steps: [{ name: 'Review', teams: ['finance'], users: [] }],
				superseded_by: [],
				team_names: { finance: 'Finance' },
				user_names: {},
				requestor: { ref: 'member:u1', name: 'Ada' },
				log: [
					{
						move: 'request',
						by: { ref: 'member:u1', name: 'Ada' },
						at: '2026-10-13T00:00:00Z',
						from: null,
						to: 'Pending',
						step: 0,
						reason: 'Review the new job.'
					}
				],
				records: [{ model: 'jobs', id: 'j1', op: 'create' }],
				moves: [{ decision: 'approve', reason: 'optional' }],
				mine: true,
				participant: true
			};
			const file = {
				id: '0199a000-0000-7000-8000-000000000001',
				name: 'a.pdf',
				mime: 'application/pdf',
				size: 1
			};
			const { bolt } = yield* client((url) =>
				url.startsWith(PATHS.approval) ? Response.json({ value: [approval] }) : Response.json(file)
			);
			const [view] = yield* bolt.approvals.list({ model: 'jobs' });
			expect(view?.log[0]?.reason).toBe('Review the new job.');
			expect(view?.moves).toEqual([{ decision: 'approve', reason: 'optional' }]);
			expect(yield* bolt.upload(new Blob(['x']), 'jobs.file')).toEqual(file);
			const refusing = (yield* client(() =>
				Response.json({ error: { code: 'too_large', message: 'Too large.' } }, { status: 413 })
			)).bolt;
			expect(yield* Effect.flip(refusing.upload(new Blob(['x']), 'jobs.file'))).toMatchObject({
				_tag: 'ActRefused',
				code: 'too_large'
			});
		})
	);
	it.effect('approval reads reject malformed request views at the wire boundary', () =>
		Effect.gen(function* () {
			const malformed = { id: 'ap1', status: 'Pending' };
			const one = (yield* client(() => Response.json({ value: malformed }))).bolt;
			const list = (yield* client(() => Response.json({ value: [malformed] }))).bolt;
			expect(yield* Effect.flip(one.approvals.get('ap1'))).toMatchObject({
				_tag: 'ProtocolFailed'
			});
			expect(yield* Effect.flip(list.approvals.list())).toMatchObject({ _tag: 'ProtocolFailed' });
		})
	);

	it.effect('a sign-in refusal is a Refusal with the host message', () =>
		Effect.gen(function* () {
			const { bolt } = yield* client(() =>
				Response.json({ error: { code: 'invalid_input', message: 'Wrong code.' } }, { status: 400 })
			);
			expect(yield* Effect.flip(bolt.session.send_code('+6590000000'))).toEqual(
				new Refusal({ message: 'Wrong code.' })
			);
		})
	);
});

describe('live patches on a page value', () => {
	it('set a top-level value beside the rows (meta) without touching them, on a single record too, and refuse it on no record', () => {
		const page = { status: 'running', rows: [{ id: 'a' }] };
		expect(patched(page, [{ op: 'meta', key: 'status', value: 'stopped' }])).toEqual({
			status: 'stopped',
			rows: [{ id: 'a' }]
		});
		expect(patched({ id: 'a', status: 'running' }, [{ op: 'meta', key: 'status', value: 'stopped' }])).toEqual({ id: 'a', status: 'stopped' });
		expect(patched({ id: 'a', status: 'running' }, [{ op: 'unset', key: 'status' }])).toEqual({ id: 'a' });
		expect(patched(null, [{ op: 'meta', key: 'status', value: 'stopped' }])).toBe(undefined);
	});
});
