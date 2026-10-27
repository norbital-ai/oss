import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from '@effect/vitest';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { Context, Effect, Layer, Option, Schema } from 'effect';
import { memoryAuditLayer } from '../src/test/index.ts';
import { TestClock } from 'effect/testing';
import { HttpServerRequest, HttpServerResponse } from 'effect/http';
import { DevHost, DevHostLive, type DevHostOptions } from '../src/cli/dev.ts';
import { ToolFailure } from '../src/cli/build.ts';
import { localFiles } from '../src/node/files.ts';
import { prepareMigrations } from '../src/compiler/migrations.ts';
import { readMigrations } from '../src/engine/schema/migrations.ts';
import { treeHash, type Artifact } from '../src/engine/artifact/read.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import type { Json } from '../src/decl/values.ts';
import { PgliteDb } from '../src/node/db/pglite.ts';
import { TenantDb } from '../src/engine/db/tenant-db.ts';
import type { Provider } from '../src/engine/integrations/driver.ts';
import { InstanceStatus } from '../src/protocol/schema.ts';
import { localAudit } from '../src/node/audit.ts';
import type { AuditEvent } from '../src/protocol/audit.ts';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

const NOW = '2026-10-13T00:00:00.000Z';
const scratch = (prefix: string) =>
	Effect.acquireRelease(
		Effect.sync(() => mkdtempSync(join(tmpdir(), prefix))),
		(root) => Effect.sync(() => rmSync(root, { recursive: true, force: true }))
	);
const auditEvent = (id: string, status: AuditEvent['status'] = 'prepared'): AuditEvent => ({
	id,
	operationId: id.split(':')[0] ?? id,
	at: '2001-01-01T00:00:00.000Z',
	category: 'write',
	action: 'ledger.update',
	status,
	actor: { kind: 'member', id: 'admin', label: 'Administrator' },
	subject: { model: 'ledger', id: 'balance', revision: 1 },
	invocation: 'call',
	transaction: null,
	run: 'run',
	approval: null,
	payload: { balance: 20, evidence: `needle%_\\${'x'.repeat(270000)}` }
});
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
	exposures: {
		accounts: {
			read: { accounts: { fields: 'all' } },
			create: { columns: { accounts: ['name', 'selected', 'owner'] } },
			update: { columns: { accounts: ['name', 'selected'] } }
		},
		visits: { read: { visits: { fields: 'all' } } }
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
	yield* prepareMigrations(root, m, 'generate');
	const migrations = yield* readMigrations(join(root, 'migrations'));
	mkdirSync(join(dir, 'client'), { recursive: true });
	writeFileSync(
		join(dir, 'client', 'index.html'),
		'<html><head><script src="./assets/app.js"></script><link href="//cdn.test/style.css"></head></html>'
	);
	return {
		dir,
		client: join(dir, 'client'),
		manifest: m,
		migrations,
		guest: { source },
		pages: {},
		artifact: {
			format: 1,
			contract: 'dev-test',
			handle: 'dev-test',
			name: 'Development',
			schema: 'schema',
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
		}).pipe(Layer.provideMerge(Layer.mergeAll(PgliteDb.layer(), memoryAuditLayer)))
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
							state = await ctx.state();
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

it.live(
	'local development audit survives reopen with complete payloads, native immutability, bounded recovery and receipt-time retention',
	() =>
		Effect.scoped(
			Effect.gen(function* () {
				const root = yield* scratch('dev-durable-audit-'),
					directory = join(root, 'audit');
				const events = [
					auditEvent('complete:prepared'),
					auditEvent('complete:terminal', 'committed'),
					auditEvent('waiting-a:prepared'),
					auditEvent('waiting-a:terminal', 'unknown'),
					auditEvent('waiting-b:prepared')
				];
				const first = yield* Effect.scoped(
					Effect.gen(function* () {
						const port = yield* localAudit(directory);
						expect(existsSync(directory)).toBe(false);
						yield* Effect.tryPromise((signal) => port.append(events, signal));
						yield* Effect.tryPromise((signal) => port.append(events, signal));
						const candidate = auditEvent('rolled-back:prepared');
						yield* Effect.tryPromise(async (signal) => {
							await expect(
								port.append(
									[candidate, { ...auditEvent('complete:prepared'), payload: { changed: true } }],
									signal
								)
							).rejects.toMatchObject({ code: 'BA102' });
							expect(await port.detail(candidate.id, signal)).toBeNull();
						});
						const page = yield* Effect.tryPromise((signal) =>
							port.query({ order: 'oldest', limit: 1 }, signal)
						);
						expect(page.rows.map((row) => row.id)).toEqual(['complete:prepared']);
						expect(page.rows[0]).not.toHaveProperty('payload');
						if (page.next === null)
							return yield* Effect.die('Audit pagination has no continuation.');
						return { port, cursor: page.next };
					})
				);
				yield* Effect.tryPromise(async (signal) => {
					await expect(first.port.detail('complete:prepared', signal)).rejects.toThrow('closed');
				});
				yield* Effect.scoped(
					Effect.gen(function* () {
						const pg = yield* Effect.acquireRelease(
							Effect.tryPromise(() =>
								PGlite.create({ dataDir: directory, extensions: { pg_trgm } })
							),
							(pg) => Effect.promise(() => pg.close())
						);
						yield* Effect.tryPromise(async () => {
							await expect(
								pg.query(
									"UPDATE bolt_audit.event SET event=jsonb_set(event,'{payload}','{}') WHERE id=$1",
									['complete:prepared']
								)
							).rejects.toMatchObject({ code: 'BA101' });
							await expect(
								pg.query('DELETE FROM bolt_audit.event WHERE id=$1', ['complete:prepared'])
							).rejects.toMatchObject({ code: 'BA101' });
							await expect(pg.query('TRUNCATE bolt_audit.event')).rejects.toMatchObject({
								code: 'BA101'
							});
							const expired = { ...auditEvent('expired:prepared'), at: new Date().toISOString() };
							await pg.query(
								`INSERT INTO bolt_audit.event (id,occurred_at,recorded_at,event)
          VALUES ($1,$2::timestamptz,clock_timestamp()-interval '31 days',$3::jsonb)`,
								[expired.id, expired.at, JSON.stringify(expired)]
							);
						});
					})
				);
				yield* Effect.scoped(
					Effect.gen(function* () {
						const port = yield* localAudit(directory);
						const detail = yield* Effect.tryPromise((signal) =>
							port.detail('waiting-a:prepared', signal)
						);
						expect(detail).toMatchObject(auditEvent('waiting-a:prepared'));
						expect(detail?.payloadBytes).toBeGreaterThan(270000);
						const next = yield* Effect.tryPromise((signal) =>
							port.query({ order: 'oldest', limit: 1, after: first.cursor }, signal)
						);
						expect(next.rows.map((row) => row.id)).toEqual(['complete:terminal']);
						const filtered = yield* Effect.tryPromise((signal) =>
							port.query(
								{
									text: 'needle%_\\',
									actorKind: 'member',
									actorId: 'admin',
									category: 'write',
									action: 'ledger.update',
									status: 'prepared',
									model: 'ledger',
									record: 'balance',
									invocation: 'call',
									run: 'run',
									since: '2001-01-01T00:00:00.000Z',
									until: '2002-01-01T00:00:00.000Z',
									order: 'oldest'
								},
								signal
							)
						);
						expect(filtered.rows.map((row) => row.id)).toEqual([
							'complete:prepared',
							'waiting-a:prepared',
							'waiting-b:prepared'
						]);
						const pending = yield* Effect.tryPromise((signal) =>
							port.pending({ limit: 1 }, signal)
						);
						expect(pending.rows.map((row) => row.id)).toEqual(['waiting-a:prepared']);
						expect(pending.rows[0]?.payload).toEqual(auditEvent('waiting-a:prepared').payload);
						if (pending.next === null)
							return yield* Effect.die('Audit recovery pagination has no continuation.');
						const pendingCursor = pending.next;
						const pendingNext = yield* Effect.tryPromise((signal) =>
							port.pending({ limit: 1, after: pendingCursor }, signal)
						);
						expect(pendingNext.rows.map((row) => row.id)).toEqual(['waiting-b:prepared']);
						expect(pendingNext.next).toBeNull();
						expect(
							yield* Effect.tryPromise((signal) => port.detail('expired:prepared', signal))
						).toBeNull();
						yield* Effect.tryPromise(async (signal) => {
							await expect(
								port.query({ status: 'failed', order: 'oldest', after: first.cursor }, signal)
							).rejects.toThrow('another query');
							await expect(port.pending({ after: first.cursor }, signal)).rejects.toThrow(
								'another query'
							);
						});
						const other = yield* localAudit(join(root, 'other-audit'));
						yield* Effect.tryPromise(async (signal) => {
							await expect(
								other.query({ order: 'oldest', after: first.cursor }, signal)
							).rejects.toThrow('another query or workspace');
							expect((await other.query({}, signal)).rows).toEqual([]);
						});
					})
				);
			})
		),
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
					input: [{ integration: 'whatsapp', name: 'Front desk' }],
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
