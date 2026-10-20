// The real scoped standalone graph: founder login, HTTP, SSE, files, ops, timekeeper, startup refusals and shutdown.
import { Server as HttpServer, IncomingMessage } from 'node:http';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, layer, vi } from '@effect/vitest';
import * as NodeServices from '@effect/platform-node/NodeServices';
import {
	Clock,
	Config,
	ConfigProvider,
	Context,
	Deferred,
	Effect,
	Exit,
	Fiber,
	FileSystem,
	Layer,
	Predicate,
	Schema,
	Scope
} from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';
import { TestClock } from 'effect/testing';
import { CONTRACT } from '../../bolt/src/compiler/artifact/index.ts';
import { buildServerPages } from '../../bolt/src/compiler/artifact/server.ts';
import { discover } from '../../bolt/src/compiler/discover.ts';
import { PublicHydration } from '../../bolt/src/protocol/public-page.ts';
import { program } from '../../bolt/tests/support/guest-fixture.ts';
import { artifactHash, treeHash, type ArtifactJson } from '../../bolt/src/engine/artifact/read.ts';
import { sha256Hex } from '../../bolt/src/engine/write/sql.ts';
import type { EngineManifest } from '../../bolt/src/engine/manifest.ts';
import { fingerprint, schemaSlice } from '../../bolt/src/engine/schema/plan.ts';
import { ActReply, Frame, LiveReply, QReply } from '../../bolt/src/protocol/schema.ts';
import { Authorities, BoltError, Reads, TenantDb } from '@norbital-ai/bolt/engine';
import { BoltConfig, type StartFlags } from '../src/config.ts';
import { devSink } from '../src/mail.ts';
import { Server, ServerLive, type StartOptions } from '../src/server.ts';

const manifest = {
	workspace: { tz: 'UTC', locale: 'en' },
	models: {
		quotes: {
			description: 'A quote',
			label: 'title',
			fields: {
				title: { kind: 'text' },
				status: { kind: 'enum', values: ['draft', 'sent'], default: 'draft' },
				attachment: { kind: 'file', accept: ['text/plain'], max: '1MiB', optional: true }
			}
		}
	},
	relationships: {},
	collections: {
		quotes: {
			read: { fields: 'all' },
			create: { input: { columns: ['title', 'attachment'] } },
			update: { input: { columns: ['status', 'attachment'] } },
			queries: {
				hold: { description: 'Reads through a guest body', input: {}, output: { kind: 'json' } }
			}
		}
	},
	policies: {
		ops: { description: 'Ops', grants: { quotes: { read: true, create: true, update: true } } }
	},
	automations: {
		remind: {
			description: 'Marks a quote sent a second after creation',
			on: { created: 'quotes', delay: '1s' },
			runAs: ['ops']
		}
	},
	integrations: {},
	pipelines: {},
	teams: {},
	connections: {},
	envoys: {},
	mcp: {},
	apps: {},
	customFields: {},
	agent: { skills: {} }
} satisfies EngineManifest;
const guest = `export default { collection: { quotes: { bodies: { queries: { hold: function* (_, ctx) { return yield* ctx.read('quotes', { limit: 1 }); } } } } }, automation: { remind: { body: function* (input, ctx) {
	for (const id of input.ids) yield* ctx.act('quotes.update', { target: id, set: { status: 'sent' } });
} } } };`;
const compiledGuest = program(guest);
const root = join(tmpdir(), 'norbital-scratch', `bolt-server-${randomUUID()}`),
	artifact = join(root, 'artifact');
const OPS_KEY = createHash('sha256').update('ops').digest('hex'),
	FOUNDER = 'boss@acme.example';
class TestIoError extends Schema.TaggedError<TestIoError>()('TestIoError', {
	cause: Schema.Defect()
}) {}
const io = <A>(run: (signal: AbortSignal) => Promise<A>) =>
	Effect.tryPromise({ try: run, catch: (cause) => new TestIoError({ cause }) });
const json = <A>(response: Response, schema: Schema.Decoder<A>) =>
	Effect.flatMap(
		io(() => response.json()),
		Schema.decodeUnknownEffect(schema)
	);
const writeFixture = (
	dir = artifact,
	m: EngineManifest = manifest,
	g = guest,
	publicSource?: string
) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		yield* fs.makeDirectory(join(dir, 'client'), { recursive: true });
		yield* fs.makeDirectory(join(dir, 'server'), { recursive: true });
		yield* fs.makeDirectory(join(dir, 'assets'), { recursive: true });
		const text = JSON.stringify(m),
			compiled = yield* g === guest ? compiledGuest : program(g);
		yield* fs.writeFileString(join(dir, 'manifest.json'), text);
		yield* fs.writeFileString(join(dir, 'guest.mjs'), compiled.source);
		if (compiled.sourceMap !== undefined)
			yield* fs.writeFileString(join(dir, 'guest.mjs.map'), compiled.sourceMap);
		yield* fs.writeFileString(
			join(dir, 'client', 'index.html'),
			'<!doctype html><div id="bolt"></div>'
		);
		yield* fs.writeFileString(join(dir, 'assets', 'thumbnail.svg'), '<svg/>');
		const pages: Record<string, ArtifactJson['pages'][string]> = {};
		if (publicSource !== undefined) {
			const found = yield* discover(publicSource);
			expect(found.errors).toEqual([]);
			const compiledPages = yield* buildServerPages(publicSource, found.files, m, dir);
			for (const [route, server] of Object.entries(compiledPages)) {
				const prefix = `public/${route}`;
				yield* fs.makeDirectory(join(dir, 'client', prefix), { recursive: true });
				yield* fs.writeFileString(join(dir, 'client', prefix, 'entry.js'), 'export {};');
				yield* fs.writeFileString(
					join(dir, 'client', prefix, 'index.html'),
					'<!doctype html><html lang="__BOLT_PUBLIC_LOCALE__"><head><meta name="bolt-release" content="__BOLT_PUBLIC_RELEASE__"><!--bolt-public-head--></head><body><div id="bolt"><!--bolt-public-body--></div><script type="application/json" id="bolt-public-hydration">__BOLT_PUBLIC_HYDRATION__</script></body></html>'
				);
				pages[route] = { entry: `${prefix}/entry.js`, css: [], server };
			}
		}
		const body: Omit<ArtifactJson, 'hash'> = {
			format: 1,
			contract: CONTRACT,
			handle: 'acme',
			name: 'Acme',
			schema: fingerprint(schemaSlice(m)),
			transforms: [],
			projections: [],
			client: { entry: '', css: [] },
			pages,
			hashes: {
				manifest: sha256Hex(text),
				guest: sha256Hex(compiled.source),
				client: yield* treeHash(join(dir, 'client')),
				server: yield* treeHash(join(dir, 'server'))
			}
		};
		yield* fs.writeFileString(
			join(dir, 'artifact.json'),
			JSON.stringify({ ...body, hash: yield* artifactHash(dir, body) })
		);
	});
const env = (over: Record<string, string> = {}) => ({
	BOLT_ARTIFACT: artifact,
	BOLT_PORT: '0',
	BOLT_PUBLIC_URL: 'http://localhost:3100',
	BOLT_PGLITE_DIR: join(root, 'db'),
	BOLT_FILES_PROVIDER: 'local',
	BOLT_FILES_ENDPOINT: join(root, 'files'),
	BOLT_OPS_KEY: OPS_KEY,
	...over
});
const config = (values: Record<string, string>, flags: StartFlags = {}) =>
	BoltConfig(flags).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(values))));
const mail = devSink(),
	quiet: StartOptions = { mail: mail.send, providers: [], log: () => {} };
const generation = (cfg: Parameters<typeof ServerLive>[0], options: StartOptions = quiet) =>
	Effect.gen(function* () {
		const scope = yield* Scope.fork(yield* Scope.Scope, 'sequential');
		const context = yield* Layer.buildWithScope(
			ServerLive(cfg, options).pipe(Layer.provideMerge(NodeServices.layer)),
			scope
		).pipe(
			Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(scope, exit) : Effect.void))
		);
		return {
			server: Context.get(context, Server),
			db: Context.get(context, TenantDb),
			close: Scope.close(scope, Exit.void)
		};
	});
class TestServer extends Context.Service<TestServer>()('server-test/TestServer', {
	make: Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		yield* Effect.addFinalizer(() =>
			fs.remove(root, { recursive: true, force: true }).pipe(Effect.orDie)
		);
		yield* writeFixture();
		const active = yield* generation(
			yield* config(env({ BOLT_MASTER_KEY: OPS_KEY }), { founder: FOUNDER }),
			{ ...quiet, maxConcurrent: 1 }
		);
		let cookie = '';
		const call = (
			method: string,
			path: string,
			body?: unknown,
			headers: Record<string, string> = {}
		) =>
			io((signal) =>
				fetch(`${active.server.url}${path}`, {
					method,
					signal,
					headers: {
						cookie,
						...(body === undefined ? {} : { 'content-type': 'application/json' }),
						...headers
					},
					...(body === undefined
						? {}
						: {
								body:
									typeof body === 'string'
										? body
										: body instanceof Uint8Array
											? new Blob([new Uint8Array(body)])
											: JSON.stringify(body)
							})
				})
			);
		return {
			...active,
			call,
			setCookie: (value: string) => {
				cookie = value;
			},
			act: (callable: string, input: unknown) =>
				Clock.currentTimeMillis.pipe(
					Effect.flatMap((now) =>
						call(
							'POST',
							'/__bolt/act',
							{ callable, input, issuedAt: new Date(now).toISOString() },
							{ 'Idempotency-Key': randomUUID() }
						)
					)
				)
		};
	})
}) {}
const frames = (res: Response) =>
	Effect.gen(function* () {
		const body = res.body;
		if (body === null)
			return yield* Effect.fail(new TestIoError({ cause: new Error('SSE body missing') }));
		let terminal = false;
		const reader = yield* Effect.acquireRelease(
			Effect.sync(() => body.getReader()),
			(reader) =>
				(terminal ? Effect.void : io(() => reader.cancel()).pipe(Effect.orDie)).pipe(
					Effect.andThen(Effect.sync(() => reader.releaseLock()))
				)
		);
		const decoder = new TextDecoder(),
			seen: Frame[] = [];
		let buffer = '';
		const next = (pred: (f: Frame) => boolean, ms = 5_000) =>
			Effect.gen(function* () {
				for (;;) {
					const hit = seen.findIndex(pred);
					if (hit >= 0) {
						const found = seen.splice(0, hit + 1).at(-1);
						if (found !== undefined) return found;
					}
					const { value, done } = yield* io(() => reader.read()).pipe(
						Effect.tapError(() =>
							Effect.sync(() => {
								terminal = true;
							})
						)
					);
					if (done) {
						terminal = true;
						return yield* Effect.fail(new TestIoError({ cause: new Error('stream ended') }));
					}
					buffer += decoder.decode(value, { stream: true });
					for (let i = buffer.indexOf('\n\n'); i >= 0; i = buffer.indexOf('\n\n')) {
						const chunk = buffer.slice(0, i);
						buffer = buffer.slice(i + 2);
						if (chunk.startsWith('data: '))
							seen.push(
								yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Frame))(chunk.slice(6))
							);
					}
				}
			}).pipe(
				Effect.timeoutOrElse({
					duration: ms,
					orElse: () => Effect.fail(new TestIoError({ cause: new Error('stream stalled') }))
				})
			);
		return {
			next,
			cancel: io(() => reader.cancel()).pipe(
				Effect.tap(() =>
					Effect.sync(() => {
						terminal = true;
					})
				)
			)
		};
	});

layer(Layer.effect(TestServer, TestServer.make).pipe(Layer.provideMerge(NodeServices.layer)), {
	timeout: '60 seconds',
	excludeTestServices: true
})('bolt start on PGlite', (it) => {
	it.effect('signs the founder in with the emailed code', () =>
		Effect.gen(function* () {
			const t = yield* TestServer;
			expect((yield* t.call('POST', '/__bolt/session/code', { address: FOUNDER })).status).toBe(
				200
			);
			const code = /\b(\d{6})\b/.exec(mail.mail.at(-1)?.text ?? '')?.[1];
			expect(mail.mail.at(-1)?.to).toBe(FOUNDER);
			expect(code).toMatch(/^\d{6}$/);
			const r = yield* t.call('POST', '/__bolt/session/verify', { address: FOUNDER, code });
			expect(r.status).toBe(200);
			const cookie = r.headers
				.getSetCookie()
				.map((c) => c.split(';')[0])
				.join('; ');
			t.setCookie(cookie);
			expect(cookie).toContain('bolt-session=');
			expect(cookie).not.toContain('__Secure-');
			expect(r.headers.getSetCookie()[0]).not.toMatch(/(?:^|;)\s*Secure(?:;|$)/i);
			expect(r.headers.getSetCookie()[0]).toContain('SameSite=Lax');
			expect(r.headers.getSetCookie()[0]).toContain('Path=/');
			expect(r.headers.getSetCookie()[0]).not.toMatch(/(?:^|;)\s*Domain=/i);
		})
	);
	it.effect('refuses the protocol without a session', () =>
		Effect.gen(function* () {
			const t = yield* TestServer;
			expect(
				(yield* io((signal) =>
					fetch(`${t.server.url}/__bolt/q`, {
						method: 'POST',
						signal,
						body: JSON.stringify({ reads: [] })
					})
				)).status
			).toBe(401);
		})
	);
	it.effect(
		'acts and reads over HTTP, holds a live view, and fires the delayed automation',
		() =>
			Effect.gen(function* () {
				const t = yield* TestServer,
					live = yield* t.call('GET', '/__bolt/live');
				expect(live.headers.get('content-type')).toBe('text/event-stream');
				const stream = yield* frames(live),
					hello = yield* stream.next((f) => f.t === 'hello');
				if (hello.t !== 'hello') throw new Error('Expected hello frame');
				const reg = yield* t.call('POST', '/__bolt/live', {
					conn: hello.conn,
					add: [{ view: 'all', read: { m: 'read', a: ['quotes', { all: true }] } }]
				});
				expect(yield* json(reg, LiveReply)).toEqual({ errors: [] });
				yield* stream.next((f) => f.t === 'answer' && f.view === 'all');
				const r = yield* t.act('quotes.create', { title: 'Q-1' }),
					reply = yield* json(r, ActReply);
				expect(r.status).toBe(200);
				expect(reply.outcome.kind).toBe('committed');
				if (reply.outcome.kind !== 'committed' || reply.outcome.records[0] === undefined)
					throw new Error('Expected created record');
				const id = reply.outcome.records[0].id;
				const q = yield* t.call('POST', '/__bolt/q', { reads: [{ m: 'get', a: ['quotes', id] }] });
				expect((yield* json(q, QReply)).answers[0]).toMatchObject({
					title: 'Q-1',
					status: 'draft'
				});
				const has = (status: string) => (f: Frame) => {
					const matches = (row: unknown) =>
						Predicate.isObject(row) && row['id'] === id && row['status'] === status;
					if (f.t === 'answer' && Predicate.isObject(f.value)) {
						const rows = f.value['rows'];
						return Schema.is(Schema.Array(Schema.Json))(rows) && rows.some(matches);
					}
					return f.t === 'patch' && f.ops.some((op) => op.op === 'upsert' && matches(op.row));
				};
				yield* stream.next(has('draft'));
				yield* stream.next(has('sent'), 8_000);
				const Run = Schema.Struct({ automation: Schema.String, state: Schema.String }),
					statement = {
						text: `SELECT automation, state FROM sys_run WHERE automation = 'remind'`,
						params: []
					};
				let runs = yield* t.db.rows(Run, statement);
				for (let i = 0; i < 50 && !runs.some((run) => run.state === 'succeeded'); i++) {
					yield* Effect.sleep(50);
					runs = yield* t.db.rows(Run, statement);
				}
				expect(runs).toEqual([{ automation: 'remind', state: 'succeeded' }]);
				yield* stream.cancel;
			}),
		20_000
	);
	it.effect('uploads to a file field and downloads it by id', () =>
		Effect.gen(function* () {
			const t = yield* TestServer,
				bytes = new TextEncoder().encode('hello bolt');
			const up = yield* t.call('PUT', '/__bolt/files/quotes.attachment', bytes, {
				'content-type': 'text/plain',
				'Idempotency-Key': randomUUID(),
				'content-disposition': `attachment; filename*=UTF-8''note.txt`
			});
			const ref = yield* json(
				up,
				Schema.Struct({ id: Schema.String, name: Schema.String, mime: Schema.String })
			);
			expect(up.status).toBe(200);
			expect(ref.name).toBe('note.txt');
			expect(
				(yield* json(yield* t.act('quotes.create', { title: 'Q-2', attachment: ref }), ActReply))
					.outcome.kind
			).toBe('committed');
			const down = yield* t.call('GET', `/__bolt/files/${ref.id}`);
			expect(down.status).toBe(200);
			expect(yield* io(() => down.text())).toBe('hello bolt');
			expect(
				(yield* io((signal) => fetch(`${t.server.url}/__bolt/files/${ref.id}`, { signal }))).status
			).toBe(401);
			expect(
				(yield* t.call('PUT', '/__bolt/files/quotes.attachment', bytes, {
					'content-type': 'image/png',
					'Idempotency-Key': randomUUID()
				})).status
			).toBe(400);
		})
	);
	it.effect('runs a signed host operation once and refuses its replay and a forged MAC', () =>
		Effect.gen(function* () {
			const t = yield* TestServer,
				user = yield* t.db.value(Schema.String, {
					text: `SELECT id FROM sys_user WHERE email = $1`,
					params: [FOUNDER]
				});
			const body = JSON.stringify({ op: 'session.mint', input: { user }, runId: randomUUID() }),
				ts = String(yield* Clock.currentTimeMillis),
				nonce = randomUUID();
			const mac = createHmac('sha256', Buffer.from(OPS_KEY, 'hex'))
				.update(
					[
						'v1',
						'acme',
						new URL(t.server.url).host,
						'session.mint',
						ts,
						nonce,
						sha256Hex(body)
					].join('\n')
				)
				.digest('base64url');
			const send = (value: string) =>
				t.call('POST', '/__bolt/ops', body, {
					'bolt-op-name': 'session.mint',
					'bolt-op-ts': ts,
					'bolt-op-nonce': nonce,
					'bolt-op-mac': value
				});
			const ok = yield* send(mac);
			expect(ok.status).toBe(200);
			expect(
				(yield* json(ok, Schema.Struct({ value: Schema.Struct({ token: Schema.String }) }))).value
					.token
			).toBeTypeOf('string');
			expect((yield* send(mac)).status).toBe(409);
			expect((yield* send(mac.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')))).status).toBe(403);
		})
	);
	it.effect('answers a signed host.ping (L-BOLT-298)', () =>
		Effect.gen(function* () {
			const t = yield* TestServer,
				body = JSON.stringify({ op: 'host.ping' }),
				ts = String(yield* Clock.currentTimeMillis),
				nonce = randomUUID();
			const mac = createHmac('sha256', Buffer.from(OPS_KEY, 'hex'))
				.update(
					['v1', 'acme', new URL(t.server.url).host, 'host.ping', ts, nonce, sha256Hex(body)].join(
						'\n'
					)
				)
				.digest('base64url');
			const r = yield* t.call('POST', '/__bolt/ops', body, {
				'bolt-op-name': 'host.ping',
				'bolt-op-ts': ts,
				'bolt-op-nonce': nonce,
				'bolt-op-mac': mac
			});
			expect(r.status).toBe(200);
			expect(
				(yield* json(r, Schema.Struct({ value: Schema.Struct({ workspace: Schema.String }) })))
					.value.workspace
			).toBe('acme');
		})
	);
	it.effect('serves the artifact client for app paths, not for unknown protocol paths', () =>
		Effect.gen(function* () {
			const t = yield* TestServer,
				page = yield* t.call('GET', '/app/sales/list');
			expect(page.status).toBe(200);
			expect(yield* io(() => page.text())).toContain('id="bolt"');
			expect((yield* t.call('GET', '/__bolt/nothing')).status).toBe(404);
			expect((yield* t.call('GET', '/manifest.webmanifest')).headers.get('content-type')).toBe(
				'application/manifest+json'
			);
			const asset = yield* t.call('GET', '/assets/thumbnail.svg');
			expect([asset.headers.get('content-type'), yield* io(() => asset.text())]).toEqual([
				'image/svg+xml',
				'<svg/>'
			]);
		})
	);
	it.effect(
		'renders a real public Svelte loader with caller-scoped data and matching private hydration',
		() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const source = join(root, 'public-source');
				yield* fs.makeDirectory(source, { recursive: true });
				yield* fs.symlink(
					fileURLToPath(new URL('../../bolt/node_modules', import.meta.url)),
					join(source, 'node_modules')
				);
				for (const [file, content] of Object.entries({
					'src/+workspace.ts': "export default { tz: 'UTC', locale: 'en' };",
					'src/app/site/+app.ts': 'export default {};',
					'src/app/site/home.page.data.ts':
						'import { Schema } from "effect"; export default Schema.Struct({ titles: Schema.Array(Schema.String), visitor: Schema.String });',
					'src/app/site/+home.page.server.ts':
						'import { pageServer } from "@norbital-ai/bolt"; import Data from "./home.page.data.ts"; export default pageServer({ data: Data, load: function* (_, ctx) { const result = yield* ctx.read("quotes", { limit: 10 }); return { titles: result.rows.map((row) => row.title), visitor: ctx.actor.kind === "visitor" ? ctx.actor.visitor : "member" }; } });',
					'src/app/site/+home.page.svelte':
						'<script lang="ts">import { bolt } from "$bolt"; let { data }: { data: { titles: readonly string[]; visitor: string } } = $props();</script><svelte:head><title>Protected public page</title></svelte:head><main><h1>{bolt.t("page.welcome")}</h1>{#each data.titles as title}<p>{title}</p>{/each}<p data-visitor={data.visitor}>{bolt.org.name}</p></main>',
					'src/i18n/+messages.ts': 'export default { "page.welcome": "Welcome to public SSR" };'
				})) {
					yield* fs.makeDirectory(dirname(join(source, file)), { recursive: true });
					yield* fs.writeFileString(join(source, file), content);
				}
				const publicManifest: EngineManifest = {
					...manifest,
					policies: {
						...manifest.policies,
						visitor: {
							description: 'Public draft quotes',
							grants: { quotes: { read: { where: { status: { eq: 'draft' } } } } }
						}
					},
					apps: {
						site: {
							title: 'Site',
							description: 'Public quote page',
							icon: 'lucide:globe',
							audience: { public: ['visitor'] },
							pages: { home: { title: 'Home' } }
						}
					}
				};
				const publicArtifact = join(root, 'public-artifact');
				yield* writeFixture(publicArtifact, publicManifest, guest, source);
				const active = yield* generation(
					yield* config(
						env({ BOLT_ARTIFACT: publicArtifact, BOLT_PGLITE_DIR: join(root, 'public-db') })
					),
					{ ...quiet, maxConcurrent: 1 }
				);
				yield* active.db.write({
					text: 'INSERT INTO quotes (id, title, status) VALUES ($1, $2, $3), ($4, $5, $6)',
					params: [
						randomUUID(),
						'PUBLIC & <visible>',
						'draft',
						randomUUID(),
						'PRIVATE SENT QUOTE',
						'sent'
					]
				});
				const response = yield* io((signal) =>
					fetch(`${active.server.url}/app/site/home`, { signal })
				);
				expect(response.status).toBe(200);
				expect(response.headers.get('cache-control')).toBe('private, no-store');
				const html = yield* io(() => response.text());
				expect(html).toContain('<title>Protected public page</title>');
				expect(html).toContain('Welcome to public SSR');
				expect(html).toMatch(/<p>PUBLIC &amp; &lt;visible(?:>|&gt;)<\/p>/);
				expect(html).not.toContain('PRIVATE SENT QUOTE');
				const encoded =
					/<script type="application\/json" id="bolt-public-hydration">([\s\S]*?)<\/script>/.exec(
						html
					)?.[1];
				if (encoded === undefined) throw new Error('Expected public hydration envelope');
				const hydration = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PublicHydration))(
					encoded
				);
				expect(hydration.route).toBe('app/site/home');
				expect(hydration.boot.messages['page.welcome']).toBe('Welcome to public SSR');
				const actor = yield* Schema.decodeUnknownEffect(
					Schema.Struct({ kind: Schema.Literal('visitor'), visitor: Schema.String })
				)(hydration.boot.actor);
				expect(hydration.data).toEqual({ titles: ['PUBLIC & <visible>'], visitor: actor.visitor });
				expect(response.headers.getSetCookie().join(';')).toContain(
					encodeURIComponent(actor.visitor)
				);
				expect(hydration.boot).not.toHaveProperty('authority');
				expect(hydration.boot).not.toHaveProperty('token');
				const cookie = response.headers
					.getSetCookie()
					.map((value) => value.split(';')[0])
					.join('; ');
				const head = yield* io((signal) =>
					fetch(`${active.server.url}/app/site/home`, {
						method: 'HEAD',
						signal,
						headers: { cookie }
					})
				);
				expect(head.status).toBe(200);
				expect(head.headers.get('cache-control')).toBe('private, no-store');
				expect(yield* io(() => head.text())).toBe('');
				yield* active.close;
			})
	);
	it.effect('drains on close: open live streams end at once, the port stops listening', () =>
		Effect.gen(function* () {
			const t = yield* TestServer,
				live = yield* frames(yield* t.call('GET', '/__bolt/live'));
			yield* live.next((f) => f.t === 'hello');
			const entered = yield* Deferred.make<void>(),
				release = yield* Deferred.make<void>(),
				queued = yield* Deferred.make<void>();
			const reads = Context.get(t.server.context, Reads),
				read = reads.run;
			const calls = vi
				.spyOn(reads, 'run')
				.mockImplementation((...args) =>
					Deferred.succeed(entered, undefined).pipe(
						Effect.andThen(Deferred.await(release)),
						Effect.andThen(read(...args))
					)
				);
			yield* Effect.addFinalizer(() => Effect.sync(() => calls.mockRestore()));
			const emit = HttpServer.prototype.emit;
			let requests = 0;
			const events = vi.spyOn(HttpServer.prototype, 'emit').mockImplementation(function (
				this: HttpServer,
				event,
				...args
			) {
				const request = args[0];
				if (
					event === 'request' &&
					request instanceof IncomingMessage &&
					request.url === '/__bolt/q' &&
					++requests === 2
				)
					request.once('end', () => setImmediate(() => Deferred.doneUnsafe(queued, Effect.void)));
				return emit.call(this, event, ...args);
			});
			yield* Effect.addFinalizer(() => Effect.sync(() => events.mockRestore()));
			yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
			const query = { reads: [{ m: 'query', a: ['quotes', 'hold', {}] }] };
			const first = yield* Effect.forkChild(t.call('POST', '/__bolt/q', query));
			yield* Deferred.await(entered);
			const second = yield* Effect.forkChild(t.call('POST', '/__bolt/q', query));
			yield* Deferred.await(queued);
			const t0 = yield* Clock.currentTimeMillis,
				stopped = yield* Effect.forkChild(t.close);
			yield* Effect.yieldNow;
			yield* Deferred.succeed(release, undefined);
			const finished = yield* Fiber.join(first),
				refused = yield* Fiber.join(second);
			yield* Fiber.join(stopped);
			expect(finished.status).toBe(200);
			expect(refused.status).toBe(500);
			expect(calls.mock.calls.length).toBe(1);
			expect((yield* Clock.currentTimeMillis) - t0).toBeLessThan(3_000);
			const ended = yield* Effect.flip(live.next(() => false, 1_000));
			expect(ended).toBeInstanceOf(TestIoError);
			if (ended instanceof TestIoError)
				expect(String(ended.cause)).toMatch(/stream ended|terminated|stalled/);
			expect(
				yield* Effect.result(io((signal) => fetch(`${t.server.url}/`, { signal })))
			).toMatchObject({ _tag: 'Failure' });
		})
	);
	it.effect('activates with every optional provider unbound, warning instead (P19, rule 69)', () =>
		Effect.gen(function* () {
			expect((yield* TestServer).server.warnings.join('\n')).toMatch(/geocoding is not configured/);
		})
	);
	it.effect(
		'--seed loads a pack with its assets into an empty database once, and does nothing over rows (rule 70)',
		() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem,
					pack = join(root, 'pack'),
					bytes = Buffer.from('seeded note');
				yield* fs.makeDirectory(join(pack, 'rows'), { recursive: true });
				yield* fs.makeDirectory(join(pack, 'assets', 'docs'), { recursive: true });
				yield* fs.writeFile(join(pack, 'assets', 'docs', 'note.txt'), bytes);
				yield* fs.writeFileString(
					join(pack, 'pack.json'),
					JSON.stringify({
						format: 1,
						name: 'base',
						hash: 'h',
						start: [],
						rows: { quotes: 1, sys_user: 1 },
						assets: [
							{
								path: 'docs/note.txt',
								sha256: sha256Hex(bytes),
								bytes: bytes.length,
								contentType: 'text/plain'
							}
						]
					})
				);
				yield* fs.writeFileString(
					join(pack, 'rows', 'quotes.jsonl'),
					`${JSON.stringify({ id: randomUUID(), title: 'seeded', status: 'draft', attachment: { asset: 'docs/note.txt' } })}\n`
				);
				yield* fs.writeFileString(
					join(pack, 'rows', 'sys_user.jsonl'),
					`${JSON.stringify({ id: 'seeded-member', name: 'Seeded member', email: 'seeded@example.com', team: 'seeded-sales' })}\n`
				);
				const lines: string[] = [],
					seededArtifact = join(root, 'seeded-artifact');
				const seededManifest: EngineManifest = {
					...manifest,
					teams: { 'seeded-sales': { name: 'Sales', policies: ['ops'] } }
				};
				yield* writeFixture(seededArtifact, seededManifest);
				const cfg = yield* config(
					env({ BOLT_ARTIFACT: seededArtifact, BOLT_PGLITE_DIR: join(root, 'seeded') }),
					{ seed: pack }
				);
				const first = yield* generation(cfg, { ...quiet, log: (line) => lines.push(line) });
				expect(
					yield* first.db.value(Schema.Number, {
						text: `SELECT count(*)::int AS n FROM quotes`,
						params: []
					})
				).toBe(1);
				expect(
					(yield* new Authorities(seededManifest, 'seed').member(first.db, 'seeded-member'))
						?.policies
				).toEqual(['ops']);
				const rows = yield* first.db.rows(
					Schema.Struct({
						attachment: Schema.Struct({ name: Schema.String, mime: Schema.String }),
						key: Schema.String,
						field: Schema.String,
						size: Schema.Number
					}),
					{
						text: `SELECT q.attachment, f.key, f.field, f.size FROM quotes q JOIN sys_file f ON f.id = q.attachment->>'id'`,
						params: []
					}
				);
				const hit = rows[0];
				if (hit === undefined) throw new Error('Expected seeded file');
				expect(hit).toMatchObject({
					attachment: { name: 'note.txt', mime: 'text/plain' },
					field: 'quotes.attachment',
					size: bytes.length
				});
				expect(yield* fs.readFileString(join(root, 'files', hit.key))).toBe('seeded note');
				yield* first.close;
				const second = yield* generation(cfg, { ...quiet, log: (line) => lines.push(line) });
				expect(
					yield* second.db.value(Schema.Number, {
						text: `SELECT count(*)::int AS n FROM quotes`,
						params: []
					})
				).toBe(1);
				expect(
					(yield* new Authorities(seededManifest, 'seed').member(second.db, 'seeded-member'))
						?.policies
				).toEqual(['ops']);
				yield* second.close;
				expect(lines.filter((line) => line.startsWith('--seed'))).toEqual([
					expect.stringMatching(/loaded pack base/),
					expect.stringMatching(/nothing seeded/)
				]);
			}),
		60_000
	);
	it.effect('refuses activation without the required facilities and on a foreign contract', () =>
		Effect.gen(function* () {
			const missingMail = yield* Effect.flip(
				generation(
					yield* config(
						env({ BOLT_PGLITE_DIR: join(root, 'db2'), BOLT_PUBLIC_URL: 'https://acme.example' })
					),
					{ providers: [], log: () => {} }
				)
			);
			expect(missingMail.message).toMatch(/BOLT_TRANSACTIONAL_EMAIL/);
			const {
				BOLT_FILES_PROVIDER: _p,
				BOLT_FILES_ENDPOINT: _e,
				...noFiles
			} = env({ BOLT_PGLITE_DIR: join(root, 'db3') });
			expect((yield* Effect.flip(generation(yield* config(noFiles)))).message).toMatch(
				/files are required/
			);
			const contract = yield* Effect.flip(
				generation(yield* config(env({ BOLT_PGLITE_DIR: join(root, 'db4') })), {
					...quiet,
					contracts: ['other']
				})
			);
			expect(contract).toBeInstanceOf(BoltError);
			if (contract instanceof BoltError) expect(contract.code).toBe('contract');
			const tampered = join(root, 'tampered'),
				fs = yield* FileSystem.FileSystem;
			yield* writeFixture(tampered);
			yield* fs.writeFileString(
				join(tampered, 'manifest.json'),
				JSON.stringify({ ...manifest, models: {} })
			);
			expect(
				(yield* Effect.flip(
					generation(
						yield* config(env({ BOLT_ARTIFACT: tampered, BOLT_PGLITE_DIR: join(root, 'db5') }))
					)
				)).message
			).toMatch(/schema hash/);
		})
	);
	it.effect('refuses non-image models before acquiring the database', () =>
		Effect.gen(function* () {
			const db = join(root, 'refused-model-db'),
				fs = yield* FileSystem.FileSystem;
			const metadata = vi.fn<typeof fetch>(async () =>
				Response.json({ data: [{ id: 'text-only', architecture: { input_modalities: ['text'] } }] })
			);
			const cfg = yield* config(
				env({
					BOLT_PGLITE_DIR: db,
					BOLT_AI_SYS_1_PROVIDER: 'openai',
					BOLT_AI_SYS_1_MODEL: 'tiny',
					BOLT_AI_SYS_2_PROVIDER: 'openai',
					BOLT_AI_SYS_2_MODELS: '{"default":"text-only"}'
				})
			);
			const refusal = yield* Effect.flip(
				generation(cfg).pipe(Effect.provideService(FetchHttpClient.Fetch, metadata))
			);
			expect(refusal.message).toMatch(/must take image/);
			expect(metadata).toHaveBeenCalledTimes(2);
			expect(
				metadata.mock.calls
					.map(([input]) => new URL(input instanceof Request ? input.url : String(input)).pathname)
					.sort()
			).toEqual(['/api/v1/embeddings/models', '/api/v1/models']);
			expect(yield* fs.exists(db)).toBe(false);
		})
	);
	it.effect('refuses a malformed file-store URL before acquiring the database', () =>
		Effect.gen(function* () {
			const db = join(root, 'refused-files-db'),
				fs = yield* FileSystem.FileSystem;
			const cfg = yield* config(
				env({
					BOLT_PGLITE_DIR: db,
					BOLT_FILES_PROVIDER: 's3',
					BOLT_FILES_ENDPOINT: 'http://',
					BOLT_FILES_CREDENTIAL: 'key:secret'
				})
			);
			expect((yield* Effect.flip(generation(cfg))).message).toMatch(/Invalid URL/);
			expect(yield* fs.exists(db)).toBe(false);
		})
	);
	it.effect(
		'refuses a destructive schema step without --accept and applies it with (rule 69)',
		() =>
			Effect.gen(function* () {
				const narrower = join(root, 'narrower'),
					{ attachment: _dropped, ...fields } = manifest.models.quotes.fields;
				yield* writeFixture(narrower, {
					...manifest,
					models: { quotes: { ...manifest.models.quotes, fields } },
					collections: {
						quotes: {
							read: { fields: 'all' },
							create: { input: { columns: ['title'] } },
							update: { input: { columns: ['status'] } }
						}
					}
				});
				const db = { BOLT_PGLITE_DIR: join(root, 'db6') };
				yield* (yield* generation(yield* config(env(db)))).close;
				expect(
					(yield* Effect.flip(generation(yield* config(env({ ...db, BOLT_ARTIFACT: narrower })))))
						.message
				).toMatch(/--accept/);
				yield* (yield* generation(
					yield* config(env({ ...db, BOLT_ARTIFACT: narrower }), { accept: true })
				)).close;
			}),
		60_000
	);
});

it.effect(
	'runs a cron automation at the fixed clock, binding ctx.now and ctx.today to it',
	() =>
		Effect.gen(function* () {
			const dir = join(root, 'cron-artifact'),
				fs = yield* FileSystem.FileSystem;
			yield* Effect.addFinalizer(() =>
				fs.remove(root, { recursive: true, force: true }).pipe(Effect.orDie)
			);
			yield* TestClock.setTime(Date.parse('2031-02-03T07:59:00.000Z'));
			yield* writeFixture(
				dir,
				{
					...manifest,
					automations: {
						stamp: {
							description: 'Stamps a quote at 08:00',
							on: { cron: '0 8 * * *' },
							runAs: ['ops']
						}
					}
				},
				`export default { automation: { stamp: { body: function* (input, ctx) { yield* ctx.act('quotes.create', { title: ctx.now + ' ' + ctx.today }); } } } };`
			);
			const s = yield* generation(
				yield* config(env({ BOLT_ARTIFACT: dir, BOLT_PGLITE_DIR: join(root, 'cron') }))
			);
			const due = yield* s.db.value(Schema.String, {
				text: `SELECT due_at FROM sys_run WHERE automation = 'stamp'`,
				params: []
			});
			expect(new Date(due).toISOString()).toBe('2031-02-03T08:00:00.000Z');
			yield* TestClock.setTime(Date.parse('2031-02-03T08:00:00.000Z'));
			yield* s.server.wake;
			expect(
				yield* s.db.rows(Schema.Struct({ title: Schema.String }), {
					text: `SELECT title FROM quotes`,
					params: []
				})
			).toEqual([{ title: '2031-02-03T08:00:00.000Z 2031-02-03' }]);
			yield* s.close;
		}).pipe(Effect.provide(NodeServices.layer)),
	60_000
);

it.live(
	'serves on Postgres: TLS by default, plain only with sslmode=disable (§5.11.6)',
	(ctx) =>
		Effect.gen(function* () {
			const url = yield* Config.option(Config.string('BOLT_TEST_POSTGRES_URL')).pipe(
				Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv()))
			);
			if (url._tag === 'None') {
				ctx.skip();
				return;
			}
			const fs = yield* FileSystem.FileSystem;
			yield* Effect.addFinalizer(() =>
				fs.remove(root, { recursive: true, force: true }).pipe(Effect.orDie)
			);
			yield* writeFixture();
			const { default: pg } = yield* io(() => import('pg'));
			const name = `bolt_start_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
			const admin = yield* Effect.acquireRelease(
				io(async () => {
					const client = new pg.Client({ connectionString: url.value });
					await client.connect();
					return client;
				}),
				(client) => io(() => client.end()).pipe(Effect.orDie)
			);
			yield* io(() => admin.query(`CREATE DATABASE ${name}`));
			yield* Effect.addFinalizer(() =>
				io(() => admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)).pipe(Effect.orDie)
			);
			const at = (query: string) => {
				const u = new URL(url.value);
				u.pathname = `/${name}`;
				u.search = query;
				return u.href;
			};
			const pgEnv = (value: string) => {
				const { BOLT_PGLITE_DIR: _d, ...rest } = env();
				return { ...rest, BOLT_DATABASE_URL: value };
			};
			expect((yield* Effect.flip(generation(yield* config(pgEnv(at('')))))).message).toMatch(
				/SSL|TLS/i
			);
			const s = yield* generation(yield* config(pgEnv(at('?sslmode=disable'))));
			expect(
				yield* s.db.value(Schema.Number, {
					text: `SELECT count(*)::int AS n FROM quotes`,
					params: []
				})
			).toBe(0);
			yield* s.close;
		}).pipe(Effect.provide(NodeServices.layer)),
	60_000
);
