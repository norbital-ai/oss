// Real instance routes and scoped restart/flush, with fake conversation and request providers at their network edges.
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, layer, vi } from '@effect/vitest';
import * as NodeServices from '@effect/platform-node/NodeServices';
import {
	ConfigProvider,
	Context,
	Deferred,
	Effect,
	Exit,
	Fiber,
	FiberSet,
	FileSystem,
	Layer,
	Predicate,
	Result,
	Schema,
	Scope
} from 'effect';
import { FetchHttpClient, HttpClient } from 'effect/unstable/http';
import { defaultProviders, toDrivers } from '@norbital-ai/providers';
import { PairingInvalid } from '@norbital-ai/providers/errors';
import { program } from '../../bolt/tests/support/guest-fixture.ts';
import { CONTRACT } from '../../bolt/src/compiler/artifact/index.ts';
import { artifactHash, treeHash, type ArtifactJson } from '../../bolt/src/engine/artifact/read.ts';
import { sha256Hex } from '../../bolt/src/engine/write/sql.ts';
import type { EngineManifest } from '../../bolt/src/engine/manifest.ts';
import type { Json } from '../../bolt/src/decl/values.ts';
import type { Provider } from '../../bolt/src/engine/integrations/driver.ts';
import { instanceRequest } from '../../bolt/src/engine/integrations/instances.ts';
import { fingerprint, schemaSlice } from '../../bolt/src/engine/schema/plan.ts';
import { InstanceStatus } from '../../bolt/src/protocol/schema.ts';
import { Drivers, Feeds, Reads, TenantDb } from '@norbital-ai/bolt/engine';
import { BoltConfig } from '../src/config.ts';
import { httpProvider, sqlServerProvider } from '../src/drivers.ts';
import type { sqlServerDatabase } from '../src/database.ts';
import { devSink } from '../src/mail.ts';
import { Server, ServerLive, type StartOptions } from '../src/server.ts';

const CONVERSATIONS = ['whatsapp', 'telegram', 'slack', 'discord', 'wechat', 'email'] as const;
const manifest = {
	workspace: {
		tz: 'UTC',
		locale: 'en',
		secrets: {
			CRM_CLIENT: { label: 'CRM client' },
			CRM_SECRET: { label: 'CRM secret' }
		}
	},
	models: {
		probe: { description: 'Admission probe', label: 'title', fields: { title: { kind: 'text' } } }
	},
	relationships: {},
	collections: {
		probe: {
			read: { fields: 'all' },
			queries: {
				hold: { description: 'Reads through a guest body', input: {}, output: { kind: 'json' } }
			}
		}
	},
	policies: {},
	automations: {},
	pipelines: {},
	teams: {},
	integrations: {
		calendar: { description: 'Google Calendar', driver: 'calendar' },
		erp: {
			description: 'The ERP',
			driver: 'http',
			test: true,
			credential: { apiKey: { kind: 'text', label: 'API key' } },
			http: {
				baseUrl: 'https://erp.example/api',
				auth: { header: { name: 'x-api-key', value: 'apiKey' } }
			}
		},
		crm: {
			description: 'The CRM',
			driver: 'http',
			http: { baseUrl: 'https://crm.example/v1' },
			oauth: {
				client: 'CRM_CLIENT',
				secret: 'CRM_SECRET',
				authorize: 'https://crm.example/authorize?prompt=consent',
				token: 'https://crm.example/token',
				scopes: ['read']
			}
		},
		ledger: {
			description: 'The ledger',
			driver: 'sqlserver',
			credential: { connection: { kind: 'text', label: 'Connection string' } }
		}
	},
	connections: {
		calendar: { integration: 'calendar' },
		wa_sales: { integration: 'whatsapp' },
		wa_ops: { integration: 'whatsapp' },
		tg: { integration: 'telegram' },
		sl: { integration: 'slack' },
		dc: { integration: 'discord' },
		wx: { integration: 'wechat' },
		mail: { integration: 'email' },
		erp: { integration: 'erp' },
		crm: { integration: 'crm' },
		ledger: { integration: 'ledger' }
	},
	envoys: {},
	mcp: {},
	apps: {},
	customFields: {},
	agent: { skills: {} }
} satisfies EngineManifest;
const sent: [string, Json][] = [];
const fake = (driver: Provider['driver'], id = 'fake'): Provider => ({
	driver,
	id,
	label: `Fake ${id}`,
	setup: {
		kind: 'form',
		webhook: true,
		fields: [{ name: 'key', label: 'Key', secret: true }],
		steps: []
	},
	test: { to: { name: 'to', label: 'To' } },
	async open(ctx) {
		const stored = (await ctx.credentials.load()).get('credential');
		const held = Predicate.isObject(stored) ? stored['key'] : undefined;
		let key = typeof held === 'string' ? held : null;
		if (key !== null) await ctx.status({ state: 'connected', account: key });
		return {
			async pair(input) {
				const value = Predicate.isObject(input) ? input['key'] : undefined;
				if (typeof value !== 'string') throw new PairingInvalid({ message: 'a key is required' });
				await ctx.credentials.write(new Map([['credential', { key: value }]]));
				key = value;
				await ctx.status({ state: 'connected', account: value });
			},
			async close() {},
			async send(message) {
				sent.push([ctx.instance, message]);
				return { providerId: `${id}-1` };
			},
			async webhook(request) {
				if (request.headers.get('x-signed') !== key) return new Response(null, { status: 401 });
				await ctx.emit({
					kind: 'messages',
					messages: [Schema.decodeUnknownSync(Schema.Json)(await request.json())]
				});
				return new Response(null, { status: 200 });
			}
		};
	}
});
const flushing = (driver: Provider['driver']): Provider => {
	const base = fake(driver);
	return {
		...base,
		async open(ctx) {
			const link = await base.open(ctx);
			return {
				...link,
				async close() {
					await new Promise<void>((resolve) => setTimeout(resolve, 700));
					await ctx.emit({
						kind: 'messages',
						messages: [
							{
								id: 'C9:1',
								thread: 'C9',
								sentAt: '2026-10-01T11:00:00.000Z',
								from: { handle: 'U9', name: null },
								text: 'last words'
							}
						]
					});
					await ctx.credentials.write(new Map([['credential', { key: 'flushed' }]]));
				}
			};
		}
	};
};
const outbound: { url: string; init: RequestInit | undefined }[] = [];
const network: typeof fetch = async (input, init) => {
	const request = new Request(input, init),
		url = request.url;
	outbound.push({
		url,
		init: { ...init, method: request.method, headers: request.headers, body: await request.text() }
	});
	if (url === 'https://crm.example/token')
		return Response.json({
			access_token: 'crm-access',
			refresh_token: 'crm-refresh',
			expires_in: 3600
		});
	const headers = request.headers;
	return Response.json({
		path: new URL(url).pathname,
		key: headers.get('x-api-key'),
		bearer: headers.get('authorization')
	});
};
const queries: { credential: Json; statement: string }[] = [];
const database: ReturnType<typeof sqlServerDatabase> = {
	query: (credential, request) =>
		Effect.sync(() => {
			queries.push({ credential, statement: request.statement });
			return { rows: [{ n: 1 }] };
		})
};
const root = join(tmpdir(), 'norbital-scratch', `bolt-server-integrations-${randomUUID()}`),
	artifact = join(root, 'artifact');
const guest = `export default {
	collection: { probe: { bodies: { queries: { hold: function* (_, ctx) { return yield* ctx.read('sys_team', { limit: 1 }); } } } } },
	integration_definition: { erp: { bodies: { test: function* (ctx) { yield* ctx.request({ method: 'GET', path: '/health' }); } } } },
};`,
	compiledGuest = program(guest),
	FOUNDER = 'boss@acme.example',
	mail = devSink();
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
const config = () =>
	BoltConfig({ founder: FOUNDER }).pipe(
		Effect.provide(
			ConfigProvider.layer(
				ConfigProvider.fromUnknown({
					BOLT_ARTIFACT: artifact,
					BOLT_PORT: '0',
					BOLT_PUBLIC_URL: 'http://localhost:3100',
					BOLT_PGLITE_DIR: join(root, 'db'),
					BOLT_FILES_PROVIDER: 'local',
					BOLT_FILES_ENDPOINT: join(root, 'files'),
					BOLT_GOOGLE_OAUTH_CLIENT_ID: 'host-google-client',
					BOLT_GOOGLE_OAUTH_CLIENT_SECRET: 'host-google-secret',
					BOLT_MASTER_KEY: createHash('sha256').update('master').digest('hex')
				})
			)
		)
	);
const writeFixture = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	yield* fs.makeDirectory(join(artifact, 'client'), { recursive: true });
	const text = JSON.stringify(manifest),
		compiled = yield* compiledGuest;
	yield* fs.writeFileString(join(artifact, 'manifest.json'), text);
	yield* fs.writeFileString(join(artifact, 'guest.mjs'), compiled.source);
	if (compiled.sourceMap !== undefined)
		yield* fs.writeFileString(join(artifact, 'guest.mjs.map'), compiled.sourceMap);
	yield* fs.writeFileString(join(artifact, 'client', 'index.html'), '<!doctype html>');
	const body: Omit<ArtifactJson, 'hash'> = {
		format: 1,
		contract: CONTRACT,
		handle: 'acme',
		name: 'Acme',
		schema: fingerprint(schemaSlice(manifest)),
		transforms: [],
		projections: [],
		client: { entry: '', css: [] },
		pages: {},
		hashes: {
			manifest: sha256Hex(text),
			guest: sha256Hex(compiled.source),
			client: yield* treeHash(join(artifact, 'client')),
			server: yield* treeHash(join(artifact, 'server'))
		}
	};
	yield* fs.writeFileString(
		join(artifact, 'artifact.json'),
		JSON.stringify({ ...body, hash: yield* artifactHash(artifact, body) })
	);
});
const generation = (cfg: Parameters<typeof ServerLive>[0], options: StartOptions) =>
	Effect.gen(function* () {
		const scope = yield* Scope.fork(yield* Scope.Scope, 'sequential');
		const context = yield* Layer.buildWithScope(ServerLive(cfg, options), scope).pipe(
			Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(scope, exit) : Effect.void))
		);
		return {
			server: Context.get(context, Server),
			db: Context.get(context, TenantDb),
			close: Scope.close(scope, Exit.void)
		};
	});
class TestServer extends Context.Service<TestServer>()('integrations-test/TestServer', {
	make: Effect.gen(function* () {
		const parent = yield* Scope.Scope,
			fs = yield* FileSystem.FileSystem;
		const platform = yield* Effect.context<NodeServices.NodeServices | HttpClient.HttpClient>();
		yield* Effect.addFinalizer(() =>
			fs.remove(root, { recursive: true, force: true }).pipe(Effect.orDie)
		);
		yield* writeFixture;
		const run = yield* FiberSet.makeRuntimePromise<HttpClient.HttpClient>();
		const native = yield* toDrivers(
			[
				httpProvider({ fetch: network }),
				sqlServerProvider(database),
				...defaultProviders().filter((provider) => provider.driver === 'calendar')
			],
			(effect, options) => run(Effect.result(effect), options).then(Result.getOrThrow)
		);
		const providers = [
			...CONVERSATIONS.map((driver) => fake(driver)),
			fake('whatsapp', 'other'),
			...native
		];
		const cfg = yield* config(),
			base: StartOptions = { mail: mail.send, log: () => {}, providers };
		let active = yield* generation(cfg, base),
			cookie = '';
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
					...(body === undefined ? {} : { body: JSON.stringify(body) })
				})
			);
		yield* call('POST', '/__bolt/session/code', { address: FOUNDER });
		const code = /\b(\d{6})\b/.exec(mail.mail.at(-1)?.text ?? '')?.[1];
		if (code === undefined) throw new Error('Expected emailed founder code');
		const response = yield* call('POST', '/__bolt/session/verify', { address: FOUNDER, code });
		cookie = response.headers
			.getSetCookie()
			.map((c) => c.split(';')[0])
			.join('; ');
		return {
			current: () => active,
			call,
			providers,
			cookie: () => cookie,
			setCookie: (value: string) => {
				cookie = value;
			},
			state: (instance: string) =>
				Effect.flatMap(call('GET', `/__bolt/integrations/${instance}`), (response) =>
					json(response, Schema.Struct({ value: InstanceStatus }))
				).pipe(Effect.map((reply) => reply.value)),
			restart: (options: StartOptions = {}) =>
				Effect.gen(function* () {
					yield* active.close;
					active = yield* generation(cfg, { ...base, ...options });
				}).pipe(Effect.provide(platform), Scope.provide(parent))
		};
	})
}) {}
const PairingReply = Schema.Struct({
	value: Schema.Struct({ pairing: Schema.Struct({ kind: Schema.String, value: Schema.String }) })
});

layer(
	Layer.effect(TestServer, TestServer.make).pipe(
		Layer.provideMerge(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer))
	),
	{ timeout: '60 seconds', excludeTestServices: true }
)('integration instances on bolt start', (it) => {
	it.effect('uses the configured host Google app for the real Calendar provider sign-in', () =>
		Effect.gen(function* () {
			const t = yield* TestServer;
			expect((yield* t.state('calendar')).providers).toMatchObject([
				{ id: 'google', setup: { kind: 'oauth' } }
			]);
			expect((yield* t.state('calendar')).providers?.[0]?.available).not.toBe(false);
			const paired = yield* json(
				yield* t.call('POST', '/__bolt/integrations/calendar/pair', {}),
				PairingReply
			);
			expect(paired.value.pairing.kind).toBe('oauth');
			const authorize = new URL(paired.value.pairing.value);
			expect(authorize.origin).toBe('https://accounts.google.com');
			expect(Object.fromEntries(authorize.searchParams)).toMatchObject({
				client_id: 'host-google-client',
				scope: 'https://www.googleapis.com/auth/calendar.readonly',
				redirect_uri: 'http://localhost:3100/hooks/oauth/callback'
			});
			expect(JSON.stringify(paired)).not.toContain('host-google-secret');
			expect((yield* t.call('POST', '/__bolt/integrations/calendar/unpair', {})).status).toBe(200);
		})
	);
	it.effect(
		'refuses a visitor; answers every instance with its providers and its own webhook URL',
		() =>
			Effect.gen(function* () {
				const t = yield* TestServer,
					saved = t.cookie();
				t.setCookie('');
				expect((yield* t.call('GET', '/__bolt/integrations/tg')).status).toBe(401);
				t.setCookie(saved);
				for (const [instance, driver] of [
					['wa_sales', 'whatsapp'],
					['tg', 'telegram'],
					['sl', 'slack'],
					['dc', 'discord'],
					['wx', 'wechat'],
					['mail', 'email']
				] as const)
					expect(yield* t.state(instance)).toMatchObject({
						instance,
						driver,
						state: 'unpaired',
						about: { webhookUrl: `http://localhost:3100/hooks/integration/${instance}` }
					});
				expect((yield* t.state('wa_sales')).providers?.map((provider) => provider.id)).toEqual([
					'fake',
					'other'
				]);
				expect((yield* t.call('GET', '/__bolt/integrations/nope')).status).toBe(404);
			})
	);
	it.effect(
		'pairs two WhatsApp instances on different providers, answers refusals verbatim, and streams the status',
		() =>
			Effect.gen(function* () {
				const t = yield* TestServer;
				const refusal = Schema.Struct({
					error: Schema.Struct({ code: Schema.String, message: Schema.String })
				});
				expect(
					yield* json(
						yield* t.call('POST', '/__bolt/integrations/wa_sales/pair', { key: 'k' }),
						refusal
					)
				).toEqual({
					error: {
						code: 'invalidInput',
						message: 'choose how to connect this whatsapp instance: fake, other'
					}
				});
				expect(
					yield* json(
						yield* t.call('POST', '/__bolt/integrations/wa_sales/pair', { provider: 'fake' }),
						refusal
					)
				).toEqual({ error: { code: 'invalidInput', message: 'a key is required' } });
				expect(
					(yield* t.call('POST', '/__bolt/integrations/wa_sales/pair', {
						provider: 'fake',
						key: 'sales'
					})).status
				).toBe(200);
				expect(
					(yield* t.call('POST', '/__bolt/integrations/wa_ops/pair', {
						provider: 'other',
						key: 'ops'
					})).status
				).toBe(200);
				expect(yield* t.state('wa_sales')).toMatchObject({
					state: 'connected',
					provider: 'fake',
					account: 'sales'
				});
				expect(yield* t.state('wa_ops')).toMatchObject({
					state: 'connected',
					provider: 'other',
					account: 'ops'
				});
				const sse = yield* t.call('GET', '/__bolt/integrations/wa_ops/stream');
				expect(sse.headers.get('content-type')).toBe('text/event-stream');
				if (sse.body === null) throw new Error('Expected status stream');
				const body = sse.body;
				const reader = yield* Effect.acquireRelease(
					Effect.sync(() => body.getReader()),
					(reader) =>
						io(() => reader.cancel()).pipe(
							Effect.orDie,
							Effect.andThen(Effect.sync(() => reader.releaseLock()))
						)
				);
				expect(new TextDecoder().decode((yield* io(() => reader.read())).value)).toMatch(
					/"account":"ops"/
				);
				yield* io(() => reader.cancel());
				const db = t.current().db;
				expect(
					yield* db.rows(Schema.Struct({ instance: Schema.String, name: Schema.String }), {
						text: `SELECT instance, name FROM bolt_credential WHERE instance LIKE 'wa_%' ORDER BY instance, name`,
						params: []
					})
				).toEqual([
					{ instance: 'wa_ops', name: 'credential' },
					{ instance: 'wa_ops', name: 'provider' },
					{ instance: 'wa_sales', name: 'credential' },
					{ instance: 'wa_sales', name: 'provider' }
				]);
				expect(
					JSON.stringify(
						yield* db.rows(Schema.Struct({ sealed: Schema.String }), {
							text: 'SELECT sealed FROM bolt_credential',
							params: []
						})
					)
				).not.toContain('sales');
			})
	);
	it.effect(
		'routes each instance’s webhook to its own link: a verified message is stored on that instance before the 200',
		() =>
			Effect.gen(function* () {
				const t = yield* TestServer;
				expect((yield* t.call('POST', '/__bolt/integrations/sl/pair', { key: 'slk' })).status).toBe(
					200
				);
				const message = {
					id: 'C1:1',
					thread: 'C1',
					sentAt: '2026-10-01T10:00:00.000Z',
					from: { handle: 'U1', name: null },
					text: 'hello'
				};
				expect(
					(yield* t.call('POST', '/hooks/integration/sl', message, { 'x-signed': 'wrong' })).status
				).toBe(401);
				expect(
					(yield* t.call('POST', '/hooks/integration/sl', message, { 'x-signed': 'slk' })).status
				).toBe(200);
				expect((yield* t.call('POST', '/hooks/integration/dc', message)).status).toBe(404);
				expect(
					(yield* t.call('POST', '/hooks/integration/sl/open/m1.gif', message, {
						'x-signed': 'wrong'
					})).status
				).toBe(401);
				expect(
					yield* t
						.current()
						.db.rows(Schema.Struct({ integration: Schema.String, text: Schema.String }), {
							text: `SELECT integration, text FROM sys_message WHERE direction = 'inbound'`,
							params: []
						})
				).toEqual([{ integration: 'sl', text: 'hello' }]);
			})
	);
	it.effect('sends a test message through a connected instance, and refuses one that is not', () =>
		Effect.gen(function* () {
			const t = yield* TestServer;
			expect((yield* t.state('wa_sales')).test).toEqual({ to: { name: 'to', label: 'To' } });
			expect((yield* t.state('tg')).test).toBeUndefined();
			expect((yield* t.call('POST', '/__bolt/integrations/tg/test', { to: '5' })).status).toBe(400);
			expect(
				(yield* t.call('POST', '/__bolt/integrations/wa_sales/test', {
					to: 'whatsapp:+6591111111'
				})).status
			).toBe(200);
			expect(sent.at(-1)).toEqual([
				'wa_sales',
				{
					id: expect.any(String),
					to: 'whatsapp:+6591111111',
					text: expect.stringContaining('Norbital test message')
				}
			]);
		})
	);
	it.effect(
		'pairs an http instance with its definition’s credential and answers ctx.request under its base URL with it',
		() =>
			Effect.gen(function* () {
				const t = yield* TestServer;
				expect((yield* t.state('erp')).providers).toMatchObject([
					{
						id: 'http',
						setup: { kind: 'form', fields: [{ name: 'apiKey', label: 'API key', secret: true }] }
					}
				]);
				expect(
					yield* json(
						yield* t.call('POST', '/__bolt/integrations/erp/pair', {}),
						Schema.Struct({ error: Schema.Struct({ code: Schema.String, message: Schema.String }) })
					)
				).toEqual({ error: { code: 'invalidInput', message: 'API key is required' } });
				expect(
					(yield* t.call('POST', '/__bolt/integrations/erp/pair', { apiKey: 'erp-key' })).status
				).toBe(200);
				expect(yield* t.state('erp')).toMatchObject({ state: 'connected', stored: true });
				const current = t.current(),
					links = Context.get(current.server.context, Drivers);
				expect(yield* Context.get(current.server.context, Feeds).test('erp')).toBeUndefined();
				expect(
					yield* instanceRequest({ manifest, db: current.db, links }, 'erp', {
						method: 'GET',
						path: '/orders'
					})
				).toEqual({ ok: true, value: { path: '/api/orders', key: 'erp-key', bearer: null } });
				expect(
					(yield* Effect.flip(
						links.request('erp', { method: 'GET', path: '../admin' }).pipe(Effect.timeout(1_000))
					)).message
				).toMatch(/leaves the integration's base URL/);
			})
	);
	it.effect(
		'signs an OAuth http instance in on the host’s one public callback, routed by its state, and sends the token it minted',
		() =>
			Effect.gen(function* () {
				const t = yield* TestServer;
				for (const [name, value] of [
					['CRM_CLIENT', 'crm-client'],
					['CRM_SECRET', 'crm-secret']
				] as const)
					expect(
						(yield* t.call('POST', '/__bolt/shell/settings', {
							op: 'setSecret',
							input: { name, value }
						})).status
					).toBe(200);
				yield* t.restart(); // the link manager reads the sealed secrets when the generation starts
				const paired = yield* json(
					yield* t.call('POST', '/__bolt/integrations/crm/pair', {}),
					PairingReply
				);
				expect(paired.value.pairing.kind).toBe('oauth');
				const authorize = new URL(paired.value.pairing.value);
				expect(Object.fromEntries(authorize.searchParams)).toMatchObject({
					prompt: 'consent',
					response_type: 'code',
					client_id: 'crm-client',
					scope: 'read',
					redirect_uri: 'http://localhost:3100/hooks/oauth/callback',
					state: expect.stringMatching(/\.crm$/)
				});
				const oauthState = authorize.searchParams.get('state');
				if (oauthState === null) throw new Error('Expected OAuth state');
				expect((yield* t.call('GET', '/hooks/oauth/callback?code=c1&state=forged')).status).toBe(
					400
				);
				expect(
					(yield* t.call(
						'GET',
						`/hooks/oauth/callback?code=c1&state=${encodeURIComponent(oauthState.replace(/^[^.]*/, 'forged'))}`
					)).status
				).toBe(400);
				expect(
					(yield* t.call(
						'GET',
						`/hooks/integration/crm/oauth/callback?code=c1&state=${encodeURIComponent(oauthState)}`
					)).status
				).toBe(404);
				expect(
					(yield* t.call(
						'GET',
						`/hooks/oauth/callback?code=c1&state=${encodeURIComponent(oauthState)}`
					)).status
				).toBe(200);
				expect(yield* t.state('crm')).toMatchObject({ state: 'connected', stored: true });
				expect(
					String(outbound.find((entry) => entry.url === 'https://crm.example/token')?.init?.body)
				).toContain('client_secret=crm-secret');
				expect(
					yield* Context.get(t.current().server.context, Drivers)
						.request('crm', { method: 'GET', path: '/me' })
						.pipe(Effect.timeout(1_000))
				).toEqual({
					status: 200,
					body: { path: '/v1/me', key: null, bearer: 'Bearer crm-access' }
				});
			})
	);
	it.effect('pairs a sqlserver instance and runs a request over its connection string', () =>
		Effect.gen(function* () {
			const t = yield* TestServer;
			expect(
				(yield* t.call('POST', '/__bolt/integrations/ledger/pair', {
					connection: 'Server=db;Database=ledger'
				})).status
			).toBe(200);
			expect(
				yield* Context.get(t.current().server.context, Drivers)
					.request('ledger', { statement: 'SELECT 1 AS n', parameters: {} })
					.pipe(Effect.timeout(1_000))
			).toEqual({ rows: [{ n: 1 }] });
			expect(queries).toEqual([
				{ credential: 'Server=db;Database=ledger', statement: 'SELECT 1 AS n' }
			]);
		})
	);
	it.effect(
		'seals credentials: the next start resumes them from the rows; unpair destroys them',
		() =>
			Effect.gen(function* () {
				const t = yield* TestServer;
				yield* t.restart();
				expect(yield* t.state('wa_ops')).toMatchObject({
					state: 'connected',
					provider: 'other',
					account: 'ops'
				});
				expect((yield* t.call('POST', '/__bolt/integrations/wa_ops/unpair', {})).status).toBe(200);
				const rows = yield* t.current().db.rows(Schema.Struct({ instance: Schema.String }), {
					text: `SELECT DISTINCT instance FROM bolt_credential ORDER BY instance`,
					params: []
				});
				expect(rows.map((row) => row.instance)).toEqual(['crm', 'erp', 'ledger', 'sl', 'wa_sales']);
				expect(yield* t.state('wa_ops')).toMatchObject({ state: 'unpaired', stored: false });
			}),
		60_000
	);
	it.effect(
		"serves the hooks outside admission: with every slot held an OAuth callback and a link's ingest land; a guest body waits for a slot",
		() =>
			Effect.gen(function* () {
				const t = yield* TestServer;
				yield* t.restart({ maxConcurrent: 1 });
				const entered = yield* Deferred.make<void>(),
					release = yield* Deferred.make<void>();
				const reads = Context.get(t.current().server.context, Reads),
					read = reads.run;
				const spy = vi
					.spyOn(reads, 'run')
					.mockImplementation((...args) =>
						args[0].some(
							(read) =>
								read.kind === 'query' && read.collection === 'probe' && read.query === 'hold'
						)
							? Deferred.succeed(entered, undefined).pipe(
									Effect.andThen(Deferred.await(release)),
									Effect.andThen(read(...args))
								)
							: read(...args)
					);
				yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()));
				yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
				const held = yield* Effect.forkChild(
					t.call('POST', '/__bolt/q', { reads: [{ m: 'query', a: ['probe', 'hold', {}] }] })
				);
				yield* Deferred.await(entered);
				let tested = false;
				const test = yield* Effect.forkChild(
					t.call('POST', '/__bolt/integrations/erp/test', {}).pipe(
						Effect.tap(() =>
							Effect.sync(() => {
								tested = true;
							})
						)
					)
				);
				const paired = yield* json(
					yield* t.call('POST', '/__bolt/integrations/crm/pair', {}),
					PairingReply
				);
				const oauthState = new URL(paired.value.pairing.value).searchParams.get('state');
				if (oauthState === null) throw new Error('Expected OAuth state');
				expect(
					(yield* t.call(
						'GET',
						`/hooks/oauth/callback?code=c2&state=${encodeURIComponent(oauthState)}`
					)).status
				).toBe(200);
				expect(yield* t.state('crm')).toMatchObject({ state: 'connected', stored: true });
				const message = {
					id: 'C1:2',
					thread: 'C1',
					sentAt: '2026-10-01T10:05:00.000Z',
					from: { handle: 'U1', name: null },
					text: 'while busy'
				};
				expect(
					(yield* t.call('POST', '/hooks/integration/sl', message, { 'x-signed': 'slk' })).status
				).toBe(200);
				expect(tested).toBe(false);
				yield* Deferred.succeed(release, undefined);
				expect([(yield* Fiber.join(held)).status, (yield* Fiber.join(test)).status]).toEqual([
					200, 200
				]);
			}),
		60_000
	);
	it.effect(
		'closes the links before the engine and database: a close-time message and credential flush past 500 ms still land',
		() =>
			Effect.gen(function* () {
				const t = yield* TestServer;
				yield* t.restart({
					providers: t.providers.map((provider) =>
						provider.driver === 'discord' ? flushing('discord') : provider
					)
				});
				expect((yield* t.call('POST', '/__bolt/integrations/dc/pair', { key: 'dck' })).status).toBe(
					200
				);
				yield* t.restart();
				expect(yield* t.state('dc')).toMatchObject({ state: 'connected', account: 'flushed' });
				expect(
					yield* t.current().db.rows(Schema.Struct({ text: Schema.String }), {
						text: `SELECT text FROM sys_message WHERE integration = 'dc'`,
						params: []
					})
				).toEqual([{ text: 'last words' }]);
			}),
		60_000
	);
});
