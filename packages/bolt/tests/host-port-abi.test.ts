// Native host ABI adapters and scoped Effect execution preserve capabilities, failures and interruption.
import { describe, expect, it } from '@effect/vitest';
import { Cause, Context, Effect, Exit, Fiber, Layer, Stream } from 'effect';
import { FacilityFailure, Unavailable } from '../src/decl/errors.ts';
import type { AiPort, DeadlinesPort, LinksPort, TransportPort } from '../src/engine/contracts.ts';
import { SendRefused } from '../src/engine/conversations/status.ts';
import {
	Conflict,
	DbError,
	Fenced,
	IdentityRefusal,
	Interrupted,
	ManifestInvalid,
	SerializationReplay
} from '../src/engine/errors.ts';
import { BoltError } from '../src/protocol/errors.ts';
import { Port } from '../src/engine/port.ts';
import {
	Ai,
	Convert,
	DeadlinePort,
	Drivers,
	Files,
	Geo,
	Metering,
	Speech,
	Transport,
	WebRead
} from '../src/engine/ports.ts';

/** Runs `f` against the service `key` that `layer` provides. */
const using = <I, S, A, E>(
	key: Context.Key<I, S>,
	layer: Layer.Layer<I>,
	f: (service: S) => Effect.Effect<A, E>
) => Effect.flatMap(key, f).pipe(Effect.provide(layer));
const blob = { key: 'k1', bytes: 2, sha256: 'ab', mime: 'text/plain' };

describe('fromAbi', () => {
	it.effect('Files: a call round-trips; an absent port is unavailable', () =>
		Effect.gen(function* () {
			const files = Files.fromAbi({
				put: async (bytes, meta) => ({ ...blob, bytes: bytes.length, mime: meta.mime }),
				get: async () => new Uint8Array([1]),
				url: async (key) => `https://files/${key}`,
				remove: async () => {}
			});
			expect(
				yield* using(Files, files, (f) =>
					f.put(new Uint8Array([1, 2, 3]), { name: 'a.txt', mime: 'text/csv' })
				)
			).toEqual({ ...blob, bytes: 3, mime: 'text/csv' });
			expect(yield* using(Files, files, (f) => f.url('k1', 60))).toBe('https://files/k1');
			const absent = yield* Effect.flip(
				using(Files, Files.fromAbi(undefined), (f) => f.get('k1', 10))
			);
			expect(absent).toBeInstanceOf(Unavailable);
			expect(absent).toMatchObject({ facility: 'files', reason: 'the host provides no files' });
		})
	);

	it.effect('Convert, WebRead, Metering: a call round-trips', () =>
		Effect.gen(function* () {
			const convert = Convert.fromAbi({
				targets: ['pdf'],
				convert: async (source, to) =>
					new TextEncoder().encode(`${to}:${'markdown' in source ? source.markdown : source.html}`)
			});
			expect(yield* using(Convert, convert, (c) => Effect.succeed(c.targets))).toEqual(['pdf']);
			expect(
				new TextDecoder().decode(
					yield* using(Convert, convert, (c) => c.convert({ markdown: '# a' }, 'pdf', {}))
				)
			).toBe('pdf:# a');
			const web = WebRead.fromAbi({
				read: async (url, _signal, options) => ({
					url,
					title: null,
					text: options?.raw === true ? 'raw' : 'text'
				})
			});
			expect(yield* using(WebRead, web, (w) => w.read('https://a.example', { raw: true }))).toEqual(
				{ url: 'https://a.example', title: null, text: 'raw' }
			);
			const recorded: string[] = [];
			const metering = Metering.fromAbi({
				record: async (meter, quantity, key) => {
					recorded.push(`${meter}:${quantity}:${key}`);
				}
			});
			yield* using(Metering, metering, (m) => m.record('ai', 0.5, 'call-1'));
			expect(recorded).toEqual(['ai:0.5:call-1']);
			expect(
				yield* Effect.flip(
					using(Convert, Convert.unavailable, (c) => c.convert({ html: '<p>' }, 'pdf', {}))
				)
			).toMatchObject({ facility: 'convert' });
		})
	);

	it.effect('Speech: a provider refusal keeps its kind; an absent member is unavailable', () =>
		Effect.gen(function* () {
			const speech = Speech.fromAbi({
				transcribe: async () =>
					Promise.reject({ kind: 'tooLarge', message: 'the audio is over 2 hours' })
			});
			const refused = yield* Effect.flip(
				using(Speech, speech, (s) =>
					s.transcribe({ name: 'a.mp3', mime: 'audio/mpeg', bytes: new Uint8Array() }, {})
				)
			);
			expect(refused).toBeInstanceOf(FacilityFailure);
			expect(refused).toMatchObject({ kind: 'tooLarge', message: 'the audio is over 2 hours' });
			expect(
				yield* Effect.flip(using(Speech, speech, (s) => s.speak('hi', { format: 'mp3' })))
			).toMatchObject({ facility: 'ai.speak', reason: 'the host provides no speech' });
		})
	);

	it.live('Geo: past its wall a call times out and the provider signal is aborted', () =>
		Effect.gen(function* () {
			let aborted = false;
			const geo = Geo.fromAbi({
				search: (_query, signal) =>
					new Promise(() => {
						signal.addEventListener('abort', () => {
							aborted = true;
						});
					}),
				reverse: async (point) => ({ point, label: 'here', address: 'here, 1' })
			});
			expect(
				yield* Effect.flip(using(Geo, geo, (g) => g.search('cafe').pipe(Port.call('geo', 20))))
			).toMatchObject({ kind: 'timeout' });
			expect(aborted).toBe(true);
			expect(yield* using(Geo, geo, (g) => g.reverse({ lat: 1, lng: 2 }))).toEqual({
				point: { lat: 1, lng: 2 },
				label: 'here',
				address: 'here, 1'
			});
		})
	);

	it.effect("Transport: each message reaches its kind's port as the ABI payload", () =>
		Effect.gen(function* () {
			const sent: [string, unknown][] = [];
			const port: TransportPort = {
				send: async (kind, message) => {
					sent.push([kind, message]);
					return { providerId: `p${sent.length}` };
				}
			};
			const transport = Transport.fromAbi({ Mail: port, Push: port });
			expect(
				yield* using(Transport, transport, (t) =>
					t.send({ _tag: 'Mail', to: 'a@b.c', subject: 'Code', text: '123456' })
				)
			).toEqual({ providerId: 'p1' });
			yield* using(Transport, transport, (t) =>
				t.send({
					_tag: 'Push',
					subscription: { kind: 'web', endpoint: 'https://push', keys: {} },
					title: 'New',
					body: null,
					link: null,
					path: '/inbox'
				})
			);
			expect(sent).toEqual([
				['email', { to: 'a@b.c', subject: 'Code', text: '123456' }],
				[
					'inbox',
					{
						subscription: { kind: 'web', endpoint: 'https://push', keys: {} },
						title: 'New',
						body: null,
						link: null,
						path: '/inbox'
					}
				]
			]);
			expect(
				yield* Effect.flip(
					using(Transport, transport, (t) => t.send({ _tag: 'Sms', to: '+6512345678', text: 'hi' }))
				)
			).toMatchObject({ facility: 'sms' });
		})
	);

	it.effect('DeadlinePort: announce, settle and teardown reach the port', () =>
		Effect.gen(function* () {
			const calls: string[] = [];
			const port: DeadlinesPort = {
				announce: (s, at) => {
					calls.push(`announce ${s} ${at}`);
				},
				settle: (s, at) => {
					calls.push(`settle ${s} ${String(at)}`);
				},
				teardown: (s) => {
					calls.push(`teardown ${s}`);
				}
			};
			yield* using(DeadlinePort, DeadlinePort.fromAbi(port), (d) =>
				Effect.all([
					d.announce('t1', '2026-10-14T09:00:00Z'),
					d.settle('t1', null),
					d.teardown('t1')
				])
			);
			expect(calls).toEqual(['announce t1 2026-10-14T09:00:00Z', 'settle t1 null', 'teardown t1']);
		})
	);

	it.effect(
		'Drivers: a send refusal stays SendRefused; a request round-trips; an absent member is unavailable',
		() =>
			Effect.gen(function* () {
				const port: LinksPort = {
					send: async () => {
						throw new SendRefused('mailbox full', '452', false);
					},
					request: async (instance, op) => ({ instance, op })
				};
				const drivers = Drivers.fromAbi(port);
				const refused = yield* Effect.flip(
					using(Drivers, drivers, (d) => d.send('i1', { to: 'a', text: 'b' }))
				);
				expect(refused).toBeInstanceOf(SendRefused);
				expect(refused).toMatchObject({ message: 'mailbox full', code: '452', permanent: false });
				expect(yield* using(Drivers, drivers, (d) => d.request('i1', { method: 'GET' }))).toEqual({
					instance: 'i1',
					op: { method: 'GET' }
				});
				expect(
					yield* Effect.flip(using(Drivers, drivers, (d) => d.read('i1', 'f', 'p', null)))
				).toMatchObject({ facility: 'link' });
			})
	);

	it.effect(
		'Ai: ask round-trips, infer streams its deltas then the response, an embeddings-only port embeds',
		() =>
			Effect.gen(function* () {
				const response = {
					content: 'hello',
					toolCalls: [],
					finish: 'stop' as const,
					usage: { input: 1, output: 1 }
				};
				const port: AiPort = {
					sys_1: { ask: async () => ({ answers: {}, costUsd: 0, provider: 'p' }) },
					sys_2: {
						models: ['default'],
						infer: async (_request, _signal, onDelta, onProgress) => {
							onDelta?.('hel');
							onProgress?.('thinking');
							onDelta?.('lo');
							return response;
						}
					}
				};
				const ai = Ai.fromAbi(port);
				expect(yield* using(Ai, ai, (a) => a.ask({ state: {}, questions: {} }))).toEqual({
					answers: {},
					costUsd: 0,
					provider: 'p'
				});
				expect(
					yield* using(Ai, ai, (a) =>
						Stream.runCollect(a.infer({ model: 'default', messages: [] }))
					)
				).toEqual([
					{ _tag: 'Delta', text: 'hel' },
					{ _tag: 'Progress', reasoning: 'thinking' },
					{ _tag: 'Delta', text: 'lo' },
					{ _tag: 'Response', response }
				]);
				expect(yield* Effect.flip(using(Ai, ai, (a) => a.embed(['x'], 'default')))).toMatchObject({
					facility: 'ai.embed'
				});
				const embeddings = Ai.fromAbi({ embed: async (inputs) => inputs.map(() => [0.5]) });
				expect(yield* using(Ai, embeddings, (a) => a.embed(['x', 'y'], 'default'))).toEqual([
					[0.5],
					[0.5]
				]);
				expect(
					yield* Effect.flip(using(Ai, embeddings, (a) => a.ask({ state: {}, questions: {} })))
				).toMatchObject({ facility: 'ai' });
				const failing = Ai.fromAbi({
					...port,
					sys_2: {
						models: [],
						infer: async () => {
							throw new Error('the model stream failed');
						}
					}
				});
				expect(
					yield* Effect.flip(
						using(Ai, failing, (a) =>
							Stream.runCollect(a.infer({ model: 'default', messages: [] }))
						)
					)
				).toMatchObject({ kind: 'upstream', message: 'the model stream failed' });
			})
	);
});

describe('native tagged failures', () => {
	it.effect('typed failures retain their class and fields across an Effect boundary', () =>
		Effect.gen(function* () {
			const tags = [
				new Conflict({ records: [{ collection: 'orders', id: 'o1', fields: ['qty'] }] }),
				new Fenced({ instance: 'i1', message: 'another link took i1' }),
				new Interrupted(),
				new SerializationReplay(),
				new IdentityRefusal({ code: 'expired', message: 'The code expired.' }),
				new ManifestInvalid({ issues: ['workspace.tz: missing'] })
			];
			for (const tag of tags) expect(yield* Effect.flip(Effect.fail(tag))).toBe(tag);
			expect(
				(yield* Effect.flip(
					Effect.fail(new IdentityRefusal({ code: 'expired', message: 'The code expired.' }))
				)).message
			).toBe('The code expired.');
		})
	);

	it.effect(
		'BoltError and DbError retain identity; an ABI throw is a typed failure that names it',
		() =>
			Effect.gen(function* () {
				const bolt = BoltError.make('notFound', 'admission', 'gone'),
					db = DbError.make('23505', 'duplicate key');
				expect([
					yield* Effect.flip(Effect.fail(bolt)),
					yield* Effect.flip(Effect.fail(db))
				]).toEqual([bolt, db]);
				const boom = new TypeError('x is undefined');
				const internal = yield* Effect.flip(Port.attempt('files', () => Promise.reject(boom)));
				expect(internal).toBeInstanceOf(FacilityFailure);
				expect(internal).toMatchObject({ kind: 'upstream', message: 'x is undefined' });
				expect(
					yield* Effect.flip(Port.attempt('files', () => Promise.reject('a string')))
				).toMatchObject({ kind: 'upstream', message: 'files failed' });
				const wrapped = BoltError.make('bug', 'commit', 'unexpected', db);
				expect(yield* Effect.flip(Effect.fail(wrapped))).toBe(wrapped);
			})
	);
});

describe('scoped native execution', () => {
	it.effect('Effects yield success and typed failure without a Promise engine', () =>
		Effect.gen(function* () {
			expect(yield* Effect.succeed(7)).toBe(7);
			const fenced = new Fenced({ instance: 'i1', message: 'another link took i1' });
			expect(yield* Effect.flip(Effect.fail(fenced))).toBe(fenced);
			expect(Effect.runSync(Effect.succeed('now'))).toBe('now');
			const db = DbError.make('40001', 'serialization');
			expect(yield* Effect.flip(Effect.fail(db))).toBe(db);
		})
	);

	it.effect('an interrupted run terminates with interruption', () =>
		Effect.gen(function* () {
			const pending = yield* Effect.never.pipe(Effect.forkScoped);
			yield* Fiber.interrupt(pending);
			const exit = yield* Fiber.await(pending);
			expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
		})
	);
});
