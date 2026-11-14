// Native host ABI adapters and scoped Effect execution preserve capabilities, failures and interruption.
import { describe, expect, it } from '@effect/vitest';
import { Cause, Context, Effect, Exit, Fiber, Layer, Stream } from 'effect';
import {
	type AiPort,
	type AiResponse,
	type BrowserPort,
	type ConvertPort,
	DbError,
	type DeadlinesPort,
	FacilityFailure,
	Fenced,
	type LinksPort,
	off,
	Port,
	SendRefused,
	type TransportPort,
	Unavailable
} from '@norbital-ai/host-api';
import {
	Conflict,
	IdentityRefusal,
	Interrupted,
	ManifestInvalid,
	SerializationReplay
} from '../src/engine/errors.ts';
import { BoltError } from '../src/protocol/errors.ts';
import {
	Ai,
	Browser,
	Convert,
	DeadlinePort,
	Drivers,
	Docs,
	Files,
	Geo,
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
	it.effect('Docs rejects a malformed namespace through the typed failure channel', () =>
		Effect.gen(function* () {
			const text = new TextEncoder();
			// the API reference is the artifact's `../docs/<file>`
			const loaded = Docs.fromAbi({
				list: async () => [],
				stat: async () => null,
				read: async (path) => {
					const file = path.replace('../docs/', '');
					return text.encode(JSON.stringify(
						file === 'index.json'
							? {
									namespaces: [
										{
											namespace: 'bolt',
											module: '@norbital-ai/bolt',
											summary: 'Bolt',
											symbols: 1
										}
									],
									missing: [],
									skills: []
								}
							: { namespace: 'bolt', module: '@norbital-ai/bolt', summary: 'Bolt', symbols: 'bad' }
					));
				}
			});
			expect(yield* Effect.flip(using(Docs, loaded, (d) => d.corpus))).toMatchObject({
				_tag: 'FacilityFailure',
				kind: 'invalid'
			});
		})
	);
	it.effect('Files: a call round-trips; a refusal keeps its kind', () =>
		Effect.gen(function* () {
			const files = Files.fromAbi({
				put: async (bytes, meta) => ({ ...blob, bytes: bytes.length, mime: meta.mime }),
				get: async () => new Uint8Array([1]),
				async url(key) {
					expect(this.download).toBeTypeOf('function');
					return `https://files/${key}`;
				},
				remove: async () => {},
				download: async (url) =>
					url.endsWith('.png')
						? { ...blob, mime: 'image/png', name: 'seal.png' }
						: Promise.reject({ kind: 'invalid', message: 'not media' })
			});
			expect(
				yield* using(Files, files, (f) =>
					f.put(new Uint8Array([1, 2, 3]), { name: 'a.txt', mime: 'text/csv' })
				)
			).toEqual({ ...blob, bytes: 3, mime: 'text/csv' });
			expect(yield* using(Files, files, (f) => f.url('k1', 60))).toBe('https://files/k1');
			expect(yield* using(Files, files, (f) => f.download('https://law.example/seal.png'))).toEqual(
				{ ...blob, mime: 'image/png', name: 'seal.png' }
			);
			// a host's refusal keeps its kind across the ABI
			expect(
				yield* Effect.flip(using(Files, files, (f) => f.download('https://law.example/a.ts')))
			).toMatchObject({ _tag: 'FacilityFailure', kind: 'invalid', message: 'not media' });
		})
	);

	it.effect('Browser optional methods and lifted methods keep their port receiver', () =>
		Effect.gen(function* () {
			const closed: string[] = [];
			const snapshot = (profile: string) => ({ url: `https://${profile}.example`, title: profile, text: profile });
			const port: BrowserPort = {
				async open() {},
				async navigate(profile) {
					return snapshot(profile);
				},
				async snapshot(profile) {
					expect(this).toBe(port);
					return snapshot(profile);
				},
				async act(profile) {
					return snapshot(profile);
				},
				async evaluate() {
					return null;
				},
				async screenshot() {
					return new Uint8Array();
				},
				async download() {
					return { ...blob, name: 'file.txt' };
				},
				async open_workspace(profile) {
					expect(this).toBe(port);
					return snapshot(profile);
				},
				async close(profile) {
					expect(this).toBe(port);
					closed.push(profile);
				}
			};
			yield* Effect.gen(function* () {
				const browser = yield* Browser;
				expect(yield* browser.snapshot('reader', {})).toEqual(snapshot('reader'));
				expect(
					yield* browser.openWorkspace?.(
						'reader',
						{ environment: 'live' },
						{
							actor: {
								kind: 'member',
								id: 'member',
								external: false,
								admin: false,
								email: null,
								phone: null
							},
							conversation: 'conversation'
						}
					) ?? Effect.die('openWorkspace missing')
				).toEqual(snapshot('reader'));
				const session = yield* browser.scoped('scoped');
				expect(yield* session.snapshot({})).toEqual(snapshot('scoped'));
				yield* browser.close?.('reader') ?? Effect.die('close missing');
			}).pipe(Effect.provide(Browser.fromAbi(port)), Effect.scoped);
			expect(closed).toEqual(['reader', 'scoped']);
		})
	);

	it.effect('Convert, WebRead: a call round-trips; an `off` member is unavailable', () =>
		Effect.gen(function* () {
			const convert = Convert.fromAbi({
				targets: ['pdf'],
				convert: async (source, to) =>
					new TextEncoder().encode(
						`${to}:${'html' in source ? source.html : 'markdown' in source ? source.markdown : ''}`
					)
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
			const absent = yield* Effect.flip(
				using(Convert, Convert.fromAbi(off), (c) => c.convert({ html: '<p>' }, 'pdf', {}))
			);
			expect(absent).toBeInstanceOf(Unavailable);
			expect(absent).toMatchObject({ facility: 'convert' });
		})
	);

	it.effect(
		'Convert.ingest: an answer is decoded; a thrown unavailable keeps its kind; no converter, no ingest',
		() =>
			Effect.gen(function* () {
				const file = { sha256: 'a', name: 'a.mp3', mime: 'audio/mpeg', bytes: new Uint8Array() };
				const converter = (ingest: NonNullable<ConvertPort['ingest']>): ConvertPort => ({
					targets: [],
					convert: () => Promise.reject(new Error('This converter only ingests.')),
					ingest
				});
				const unsupported = Convert.fromAbi(converter(async () => ({ unsupported: 'no parser' })));
				expect(
					yield* using(Convert, unsupported, (c) => c.ingest?.(file, {}) ?? Effect.die('no ingest'))
				).toEqual({ unsupported: 'no parser' });
				const mute = Convert.fromAbi(
					converter(async () =>
						Promise.reject({
							kind: 'unavailable',
							facility: 'convert.ingest',
							reason: 'no transcription model'
						})
					)
				);
				expect(
					yield* Effect.flip(
						using(Convert, mute, (c) => c.ingest?.(file, {}) ?? Effect.die('no ingest'))
					)
				).toMatchObject({
					_tag: 'Unavailable',
					facility: 'convert.ingest',
					reason: 'no transcription model'
				});
				expect(
					yield* using(Convert, Convert.fromAbi(off), (c) => Effect.succeed(c.ingest))
				).toBeUndefined();
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
					return { provider_id: `p${sent.length}` };
				}
			};
			const transport = Transport.fromAbi({ Mail: port, Sms: off, Push: port });
			expect(
				yield* using(Transport, transport, (t) =>
					t.send({ _tag: 'Mail', to: 'a@b.c', subject: 'Code', text: '123456' })
				)
			).toEqual({ provider_id: 'p1' });
			yield* using(Transport, transport, (t) =>
				t.send({
					_tag: 'Push',
					id: 'notice-1',
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
						id: 'notice-1',
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
				announce: async (s, at) => {
					calls.push(`announce ${s} ${at}`);
				},
				settle: async (s, at) => {
					calls.push(`settle ${s} ${String(at)}`);
				},
				teardown: async (s) => {
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
				const response: AiResponse = {
					content: 'hello',
					tool_calls: [{ id: 'call-1', name: 'lookup', input: { query: 'hello' } }],
					finish: 'tool',
					usage: { input: 1, output: 1 }
				};
				const port: AiPort = {
					sys_1: { max_choices: 8, ask: async () => ({ answers: {}, cost_usd: 0, provider: 'p' }) },
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
				const ai = Ai.fromAbi({ system1: port.sys_1, system2: port.sys_2, embed: off });
				expect(yield* using(Ai, ai, (a) => Effect.succeed(a.maxChoices))).toBe(8);
				expect(yield* using(Ai, ai, (a) => a.ask({ state: {}, questions: {} }))).toEqual({
					answers: {},
					cost_usd: 0,
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
					{ _tag: 'Response', response: { content: response.content, tool_calls: response.tool_calls, finish: response.finish, usage: response.usage } }
				]);
				expect(response).not.toHaveProperty('toolCalls');
				expect(response.tool_calls).toEqual([{ id: 'call-1', name: 'lookup', input: { query: 'hello' } }]);
				expect(yield* Effect.flip(using(Ai, ai, (a) => a.embed(['x'], 'default')))).toMatchObject({
					facility: 'ai.embed'
				});
				const embeddings = Ai.fromAbi({
					system1: off,
					system2: off,
					embed: { embed: async (inputs) => inputs.map(() => [0.5]) }
				});
				expect(yield* using(Ai, embeddings, (a) => a.embed(['x', 'y'], 'default'))).toEqual([
					[0.5],
					[0.5]
				]);
				expect(
					yield* Effect.flip(using(Ai, embeddings, (a) => a.ask({ state: {}, questions: {} })))
				).toMatchObject({ facility: 'ai' });
				const failing = Ai.fromAbi({
					system1: port.sys_1,
					system2: {
						models: [],
						infer: async () => {
							throw new Error('the model stream failed');
						}
					},
					embed: off
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

	it.effect('Ai rejects a foreign host response using the stored transcript shape', () =>
		Effect.gen(function* () {
			const port: AiPort['sys_2'] = {
				models: ['default'],
				infer: async () => ({ content: 'hello', tool_calls: [], finish: 'stop', usage: { input: 1, output: 1 } })
			};
			Object.defineProperty(port, 'infer', {
				value: async () => ({ content: 'hello', toolCalls: [], finish: 'stop', usage: { input: 1, output: 1 } })
			});
			const ai = Ai.fromAbi({ system1: off, system2: port, embed: off });
			expect(yield* Effect.flip(using(Ai, ai, (a) => Stream.runCollect(a.infer({ model: 'default', messages: [] }))))).toMatchObject({ _tag: 'FacilityFailure', kind: 'upstream' });
		})
	);
});

describe('native tagged failures', () => {
	it.effect('typed failures retain their class and fields across an Effect boundary', () =>
		Effect.gen(function* () {
			const tags = [
				new Conflict({ records: [{ model: 'orders', id: 'o1', fields: ['qty'] }] }),
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
				const bolt = BoltError.make('not_found', 'admission', 'gone'),
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
