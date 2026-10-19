import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from '@effect/vitest';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { Context, Effect, Layer, Option, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { HttpServerRequest, HttpServerResponse } from 'effect/unstable/http';
import { DevHost, DevHostLive, type DevHostOptions } from '../src/cli/dev.ts';
import { ToolFailure } from '../src/cli/build.ts';
import { localFiles } from '../src/engine/facilities.ts';
import type { Artifact } from '../src/compiler/artifact/index.ts';
import { treeHash } from '../src/engine/artifact/read.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import type { Json } from '../src/decl/values.ts';
import { PgliteDb } from '../src/engine/db/pglite.ts';
import { TenantDb } from '../src/engine/db/tenant-db.ts';
import type { Provider } from '../src/engine/integrations/driver.ts';
import { InstanceStatus } from '../src/protocol/schema.ts';

const NOW = '2026-10-13T00:00:00.000Z';
const scratch = (prefix: string) =>
	Effect.acquireRelease(
		Effect.sync(() => mkdtempSync(join(tmpdir(), prefix))),
		(root) => Effect.sync(() => rmSync(root, { recursive: true, force: true }))
	);
const responseJson = (response: Response): Effect.Effect<unknown, ToolFailure> =>
	Effect.tryPromise({
		try: () => response.json(),
		catch: (cause) => new ToolFailure({ message: 'The development response is not JSON.', cause })
	});

const manifest: EngineManifest = {
	workspace: {
		tz: 'UTC',
		locale: 'en',
		secrets: {
			REMOTE_URL: { label: 'Remote' },
			REMOTE_TOKEN: { label: 'Token' }
		}
	},
	models: {
		accounts: {
			description: 'Calendar accounts',
			label: 'name',
			fields: {
				name: { kind: 'text' },
				selected: { kind: 'json', shape: { kind: 'list', of: { kind: 'text' } } }
			}
		},
		visits: {
			description: 'Scheduled visits',
			label: 'name',
			fields: { entry_key: { kind: 'text', unique: true }, name: { kind: 'text' } }
		}
	},
	relationships: { 'accounts.owner': { to: 'sys_user' } },
	collections: {
		accounts: {
			read: { fields: 'all' },
			create: { input: { columns: ['name', 'selected', 'owner'] } },
			update: { input: { columns: ['name', 'selected'] } }
		},
		visits: { read: { fields: 'all' } }
	},
	policies: {
		source: {
			description: 'Calendar callbacks',
			grants: {
				accounts: { read: true },
				visits: { read: true, create: true, update: true, delete: true }
			}
		}
	},
	integrations: {},
	connections: { 'local-mail': { integration: 'email' } },
	pipelines: {},
	automations: {},
	teams: {},
	envoys: {},
	mcp: {},
	apps: {},
	customFields: {},
	agent: { skills: {} }
};

const artifact = Effect.fn('test.devArtifact')(function* (
	root: string,
	m = manifest,
	source = 'export default {};'
) {
	const dir = join(root, '.norbital', 'artifact');
	mkdirSync(join(dir, 'client'), { recursive: true });
	writeFileSync(
		join(dir, 'client', 'index.html'),
		'<html><head><script src="./assets/app.js"></script><link href="//cdn.test/style.css"></head></html>'
	);
	return {
		dir,
		client: join(dir, 'client'),
		manifest: m,
		guest: { source },
		transforms: [],
		projections: [],
		pages: {},
		artifact: {
			format: 1,
			contract: 'dev-test',
			handle: 'dev-test',
			name: 'Development',
			schema: 'schema',
			transforms: [],
			projections: [],
			client: { entry: 'index.html', css: [] },
			pages: {},
			hashes: {
				manifest: 'manifest',
				guest: 'guest',
				client: 'client',
				server: yield* treeHash(join(dir, 'server'))
			},
			hash: 'same-program'
		}
	} satisfies Artifact;
});

const start = Effect.fn('test.devStart')(function* (
	root: string,
	a: Artifact,
	options: Pick<DevHostOptions, 'providers'> = {}
) {
	const context = yield* Layer.build(
		DevHostLive(a, {
			port: 5180,
			publicUrl: 'http://127.0.0.1:5180/tenant',
			files: localFiles(join(root, 'files')),
			founder: 'dev@example.test',
			keyFile: join(root, 'dev-master.key'),
			log: () => {},
			...options
		}).pipe(Layer.provideMerge(PgliteDb.layer()))
	);
	return { host: Context.get(context, DevHost), db: Context.get(context, TenantDb) };
});

const signIn = Effect.fn('test.devSignIn')(function* (host: DevHost['Service']) {
	const cookies = new Map<string, string>();
	const call = (
		path: string,
		body?: Json,
		authenticated = true,
		headers: Record<string, string> = {}
	) =>
		Effect.gen(function* () {
			const native = yield* host.handle(
				HttpServerRequest.fromWeb(
					new Request(`${host.url}${path}`, {
						method: body === undefined ? 'GET' : 'POST',
						headers: {
							'content-type': 'application/json',
							...headers,
							...(authenticated
								? { cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; ') }
								: {})
						},
						...(body === undefined ? {} : { body: JSON.stringify(body) })
					})
				).modify({ remoteAddress: Option.some('127.0.0.1') })
			);
			const response = HttpServerResponse.toWeb(native);
			for (const cookie of response.headers.getSetCookie()) {
				const pair = cookie.split(';')[0],
					at = pair?.indexOf('=');
				if (pair !== undefined && at !== undefined && at >= 0)
					cookies.set(pair.slice(0, at), pair.slice(at + 1));
			}
			return response;
		});
	expect((yield* call('/__bolt/session/code', { address: 'dev@example.test' })).status).toBe(200);
	expect(
		(yield* call('/__bolt/session/verify', { address: 'dev@example.test', code: '123456' })).status
	).toBe(200);
	return call;
});

it.effect(
	'development serves an instance’s verbs, seals its pairing, hands its webhook and the host OAuth callback the public request and resumes after a swap',
	() =>
		Effect.gen(function* () {
			const root = yield* scratch('dev-instance-links-');
			yield* TestClock.setTime(Date.parse(NOW));
			let closes = 0,
				state = '';
			const loaded: (Json | null)[] = [],
				hooks: string[] = [];
			const provider: Provider = {
				id: 'fixture-mail',
				driver: 'email',
				label: 'Fixture mail',
				setup: { kind: 'none', steps: [] },
				async open(ctx) {
					const stored = (await ctx.credentials.load()).get('credential') ?? null;
					loaded.push(stored);
					expect(new URL(ctx.webhookUrl).pathname).toBe('/tenant/hooks/integration/local-mail');
					expect(new URL(ctx.redirectUrl).pathname).toBe('/tenant/hooks/oauth/callback');
					if (stored !== null) await ctx.status({ state: 'connected' });
					return {
						send: async () => ({ providerId: 'fixture-message' }),
						pair: async () => {
							state = ctx.state();
							await ctx.credentials.write(
								new Map([['credential', { token: 'private-mail-credential' }]])
							);
							await ctx.status({ state: 'connected' });
						},
						webhook: async (request) => {
							hooks.push(new URL(request.url).pathname);
							return new Response(null, { status: 204 });
						},
						close: async () => {
							closes++;
						}
					};
				}
			};
			yield* Effect.scoped(
				Effect.gen(function* () {
					const a = yield* artifact(root),
						{ host, db } = yield* start(root, a, { providers: [provider] }),
						call = yield* signIn(host);
					expect((yield* call('/__bolt/integrations/local-mail', undefined, false)).status).toBe(
						401
					);
					expect(yield* responseJson(yield* call('/__bolt/integrations/local-mail'))).toMatchObject(
						{
							value: {
								instance: 'local-mail',
								driver: 'email',
								state: 'unpaired',
								providers: [{ id: 'fixture-mail' }]
							}
						}
					);
					expect((yield* call('/__bolt/integrations/local-mail/pair', {})).status).toBe(200);
					expect(yield* responseJson(yield* call('/__bolt/integrations/local-mail'))).toMatchObject(
						{
							value: { state: 'connected', stored: true, provider: 'fixture-mail' }
						}
					);
					const delivery = yield* host.handle(
						HttpServerRequest.fromWeb(
							new Request(`${host.url}/hooks/integration/local-mail/open/m1.gif`, {
								method: 'POST'
							})
						)
					);
					expect(delivery.status).toBe(204);
					const paired = yield* host.handle(
						HttpServerRequest.fromWeb(
							new Request(
								`${host.url}/hooks/oauth/callback?code=c&state=${encodeURIComponent(state)}`
							)
						)
					);
					expect(paired.status).toBe(204);
					expect(hooks).toEqual([
						'/tenant/hooks/integration/local-mail/open/m1.gif',
						'/tenant/hooks/oauth/callback'
					]);
					const [sealed] = yield* db.read([
						{
							text: "SELECT name, sealed FROM bolt_credential WHERE instance = 'local-mail' ORDER BY name",
							params: []
						}
					]);
					expect(sealed?.rows.map((r) => r['name'])).toEqual(['credential', 'provider']);
					expect(JSON.stringify(sealed?.rows)).not.toContain('private-mail-credential');
					const refused = yield* Effect.flip(
						host.swap({ ...a, dir: join(root, 'dev-master.key') })
					);
					expect(refused).toMatchObject({
						_tag: 'ToolFailure',
						message: 'The development master key must be outside the artifact.'
					});
					expect(closes).toBe(0);
					expect((yield* call('/__bolt/integrations/local-mail')).status).toBe(200);
					yield* host.swap(a);
					expect(closes).toBe(1);
					expect(loaded.at(-1)).toEqual({ token: 'private-mail-credential' });
					expect(yield* responseJson(yield* call('/__bolt/integrations/local-mail'))).toMatchObject(
						{
							value: { state: 'connected', stored: true }
						}
					);
				})
			);
			expect(closes).toBe(2);
		}).pipe(Effect.provide(NodeServices.layer)),
	30000
);

it.effect(
	'development offers the host providers to a UI-created instance of a built-in conversation integration on a workspace that names none',
	() =>
		Effect.gen(function* () {
			const root = yield* scratch('dev-instance-providers-');
			yield* TestClock.setTime(Date.parse(NOW));
			// no `providers`: the host's own (bolt-server's `drivers()`), with no connection, integration or seeded instance to hint at them
			const a = yield* artifact(root, { ...manifest, connections: {} });
			const { host, db } = yield* start(root, a);
			const call = yield* signIn(host);
			const created = yield* call(
				'/__bolt/act',
				{
					callable: 'sys_integration.create',
					input: { integration: 'whatsapp', name: 'Front desk' },
					issuedAt: NOW
				},
				true,
				{ 'Idempotency-Key': randomUUID() }
			);
			expect(yield* responseJson(created)).toMatchObject({ outcome: { kind: 'committed' } });
			const [row] = yield* db.rows(Schema.Struct({ id: Schema.String }), {
				text: "SELECT id FROM sys_integration WHERE name = 'Front desk'",
				params: []
			});
			if (row === undefined) return yield* Effect.die('The created integration has no row.');
			const status = yield* Schema.decodeUnknownEffect(Schema.Struct({ value: InstanceStatus }))(
				yield* responseJson(yield* call(`/__bolt/integrations/${row.id}`))
			);
			expect(status.value).toMatchObject({ driver: 'whatsapp', state: 'unpaired' });
			if (status.value.providers === undefined)
				return yield* Effect.die('The integration status omitted host providers.');
			expect(status.value.providers.map((p) => p.id)).toEqual(
				expect.arrayContaining(['baileys', 'twilio'])
			);
		}).pipe(Effect.provide(NodeServices.layer)),
	30000
);
