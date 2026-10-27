// HOST_API conformance (D10a): one black-box slice — sign in, q, act, live register, a deadline wake, close — and the
// host clock's crons and fire, through this release's engine and handlers composed directly, and through HOST_API over
// `nodePorts()`, each over its own fresh PGlite built from the same artifact. The answers match once generated ids and
// instants are blanked.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from '@effect/vitest';
import {
	Cause,
	Clock,
	Context,
	Effect,
	Exit,
	FileSystem,
	Layer,
	ManagedRuntime,
	Option,
	Schema,
	Scope
} from 'effect';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { HttpServerRequest, HttpServerResponse } from 'effect/http';
import {
	artifactHash,
	CONTRACT,
	readArtifact,
	treeHash,
	type Artifact
} from '../src/engine/artifact/read.ts';
import { RateWindows } from '../src/engine/access/rate.ts';
import type {
	CronEntry,
	CronFired,
	DeadlinesPort,
	FilesPort,
	TransportPort
} from '../src/engine/contracts.ts';
import { PgliteDb, Pristine, type PgliteClient } from '../src/node/db/pglite.ts';
import { dbError } from '../src/engine/db/wire.ts';
import { TenantDb, type TenantDbShape } from '../src/engine/db/tenant-db.ts';
import { BoltError } from '../src/protocol/errors.ts';
import { DbError, Interrupted } from '../src/engine/errors.ts';
import { DbError as ReleaseDbError } from '../build/engine/errors.js';
import { HOST_API as RELEASE_HOST_API } from '../build/protocol/host-api.js';
import { program } from './support/guest-fixture.ts';
import { founderBootstrap, loadKeys, makeIdentityHost } from '../src/engine/identity/session.ts';
import { EngineLive } from '../src/engine/host.ts';
import { Activation, Runs } from '../src/engine/services.ts';
import {
	Ai,
	Convert,
	DeadlinePort,
	Drivers,
	Files,
	Geo,
	GuestIsolates,
	Http,
	Images,
	Keys,
	Docs,
	Mcp,
	Metering,
	Speech,
	Transport,
	WebRead
} from '../src/engine/ports.ts';
import {
	applyPlan,
	fingerprint,
	plan,
	readApplied,
	schemaSlice
} from '../src/engine/schema/plan.ts';
import { sha256Hex } from '@norbital-ai/store';
import { HOST_API, HOST_API_VERSION, HostFailure } from '../src/protocol/host-api.ts';
import { auditFromAbi, auditShape } from '../src/engine/audit.ts';
import { memoryAudit } from '../src/test/audit.ts';
import { BoltHost, BoltHostLive } from '../src/protocol/host.ts';
import { RateLimits, responseError } from '../src/protocol/http.ts';
import { HostIdentity, ShellConfig, ShellRoutes, Turnstile } from '../src/shell/host.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { prepareMigrations } from '../src/compiler/migrations.ts';
import { artifactPort } from '../src/node/artifact.ts';
import { tenantDbPort } from '../src/node/db/port.ts';
import { nodePorts, type NodePorts } from '../src/node/ports.ts';
import { callbacks, guest, manifest } from './engine-fixture.ts';

const ORIGIN = 'https://acme.example',
	PUBLIC_URL = `${ORIGIN}/acme`,
	SCOPE = 'acme/live',
	ADDRESS = '203.0.113.9',
	EMAIL = 'ada@acme.example';
const RELEASE_ID = 'conformance';
const signal = new AbortController().signal;
const mail: TransportPort = { send: async () => ({ providerId: 'mail' }) };
const files: FilesPort = {
	put: async (bytes, meta) => ({ key: 'k', bytes: bytes.length, sha256: '', mime: meta.mime }),
	get: async () => new Uint8Array(),
	url: async (key) => `${ORIGIN}/files/${key}`,
	remove: async () => undefined,
	download: () => Promise.reject(new Error('this host downloads nothing'))
};
/** Every deadline call, so both sides' scheduling compares too. */
const deadlines = (calls: string[]): DeadlinesPort => ({
	announce: (scope, at) => void calls.push(`announce ${scope} ${at}`),
	settle: (scope, next) => void calls.push(`settle ${scope} ${next}`),
	teardown: (scope) => void calls.push(`teardown ${scope}`)
});

/** `bolt build`'s output for the fixture workspace: the descriptor, the manifest and the guest, digests recorded. */
const dir = mkdtempSync(join(tmpdir(), 'bolt-host-api-')),
	cronDir = mkdtempSync(join(tmpdir(), 'bolt-host-api-cron-'));
const databases: { dispose(): Promise<void> }[] = [];
const native = ManagedRuntime.make(NodeServices.layer);
const hosts = Effect.runSync(Scope.make());
afterAll(async () => {
	for (const database of databases) await database.dispose();
	await Effect.runPromise(Scope.close(hosts, Exit.void));
	await native.dispose();
	rmSync(dir, { recursive: true, force: true });
	rmSync(cronDir, { recursive: true, force: true });
});
/** The same-graph host's ports (guest isolates, http, images, mcp), alive until the suite ends. */
const hostPorts = (): Promise<NodePorts> =>
	Effect.runPromise(nodePorts().pipe(Scope.provide(hosts)));
class NativeDatabase extends Context.Service<NativeDatabase, PgliteClient>()(
	'test/HostApiPglite'
) {}
/** A raw PGlite, owned by this graph and closed after the suite. */
const freshClient = async (): Promise<PgliteClient> => {
	const runtime = ManagedRuntime.make(
		Layer.effect(NativeDatabase, PgliteDb.open()).pipe(Layer.provide(Pristine.layer))
	);
	databases.push(runtime);
	return runtime.runPromise(NativeDatabase);
};
const fresh = async (): Promise<TenantDbShape> => PgliteDb.make(await freshClient());
const built = async (
	at = dir,
	m: EngineManifest = callbacks,
	source = guest.source
): Promise<Artifact> => {
	const manifestText = JSON.stringify(m);
	// admission reads the release's committed history, exactly as it would for a built workspace
	await native.runPromise(
		prepareMigrations(at, m, 'generate').pipe(Effect.provide(Pristine.layer))
	);
	const compiled = await native.runPromise(program(source));
	writeFileSync(join(at, 'manifest.json'), manifestText);
	writeFileSync(join(at, 'guest.mjs'), compiled.source);
	if (compiled.sourceMap !== undefined)
		writeFileSync(join(at, 'guest.mjs.map'), compiled.sourceMap);
	const body = {
		format: 1 as const,
		contract: CONTRACT,
		handle: 'acme',
		name: 'Acme',
		schema: fingerprint(schemaSlice(m)),
		client: { entry: 'index.js', css: [] },
		pages: {},
		hashes: {
			manifest: sha256Hex(manifestText),
			guest: sha256Hex(compiled.source),
			client: await native.runPromise(treeHash(join(at, 'client'))),
			server: await native.runPromise(treeHash(join(at, 'server')))
		}
	};
	writeFileSync(
		join(at, 'artifact.json'),
		JSON.stringify({ ...body, hash: await native.runPromise(artifactHash(at, body)) })
	);
	return await native.runPromise(readArtifact(at));
};

type Side = {
	handle(r: Request): Promise<Response>;
	wake(): Promise<void>;
	crons(): Promise<readonly CronEntry[]>;
	fire(id: string, slot: string): Promise<CronFired>;
	close(): Promise<void>;
	calls: string[];
};

/** The same-graph composition is BoltHostLive over the native engine and shell layers. */
const direct = async (artifact: Artifact, db: TenantDbShape): Promise<Side> => {
	const calls: string[] = [],
		audit = memoryAudit();
	await native.runPromise(
		Effect.flatMap(plan(await native.runPromise(readApplied(db)), artifact.manifest), (p) =>
			applyPlan(db, p)
		)
	);
	const identity = await native.runPromise(
		Effect.gen(function* () {
			return yield* makeIdentityHost({
				audit: yield* auditShape(audit.port),
				db,
				now: Clock.currentTimeMillis.pipe(Effect.map((at) => new Date(at))),
				windows: new RateWindows(),
				keys: yield* loadKeys(db),
				publicUrl: PUBLIC_URL,
				mail,
				devSink: true
			});
		})
	);
	expect(await native.runPromise(founderBootstrap(identity, EMAIL))).toHaveProperty('user');
	const host = await hostPorts();
	const ports = Layer.mergeAll(
		auditFromAbi(audit.port).pipe(Layer.provide(NodeServices.layer)),
		Layer.succeed(TenantDb, db),
		GuestIsolates.fromAbi(host.guestIsolates),
		Keys.unavailable,
		Http.fromAbi(host.http),
		Images.fromAbi(host.images),
		Mcp.fromAbi(host.mcp),
		Docs.fromAbi(host.docs),
		Files.fromAbi(files),
		DeadlinePort.fromAbi(deadlines(calls)),
		Transport.fromAbi({ Mail: mail }),
		Ai.unavailable,
		Convert.unavailable,
		Drivers.unavailable,
		Geo.unavailable,
		Metering.unavailable,
		Speech.unavailable,
		WebRead.unavailable,
		Layer.succeed(Activation, {
			scope: SCOPE,
			epoch: '',
			release: RELEASE_ID,
			publicUrl: PUBLIC_URL,
			guest: Option.some(artifact.guest),
			start: []
		})
	);
	const engine = EngineLive(artifact.manifest).pipe(Layer.provideMerge(ports));
	const shell = ShellRoutes.pipe(
		Layer.provideMerge(
			Layer.mergeAll(
				Layer.succeed(HostIdentity, identity),
				Layer.succeed(ShellConfig, {
					publicUrl: PUBLIC_URL,
					workspace: () => ({ name: 'Acme', handle: 'acme' }),
					ai: false
				}),
				Turnstile.unavailable,
				RateLimits.layer
			).pipe(Layer.provideMerge(engine))
		)
	);
	const runtime = ManagedRuntime.make(
		BoltHostLive.pipe(Layer.provideMerge(shell), Layer.provideMerge(NodeServices.layer))
	);
	databases.push(runtime);
	const context = await runtime.context();
	let open = true;
	return {
		calls,
		handle: (request) =>
			open
				? runtime.runPromise(
						Effect.flatMap(BoltHost, (host) =>
							host.handle(
								HttpServerRequest.fromWeb(request).modify({ remoteAddress: Option.some(ADDRESS) })
							)
						).pipe(
							Effect.map((response) =>
								Option.isNone(response)
									? new Response(null, { status: 404 })
									: HttpServerResponse.toWeb(response.value, { context })
							)
						)
					)
				: Promise.resolve(HttpServerResponse.toWeb(responseError(new Interrupted()))),
		wake: () => runtime.runPromise(Effect.flatMap(Runs, (runs) => runs.tick)),
		crons: () => runtime.runPromise(Effect.flatMap(Runs, (runs) => runs.crons)),
		fire: (id, slot) => runtime.runPromise(Effect.flatMap(Runs, (runs) => runs.fire(id, slot))),
		close: async () => {
			open = false;
			await runtime.dispose();
		}
	};
};

/** Built SDK and source SDK have distinct error identities; only the host's ports cross. */
const viaHostApi = async (client: PgliteClient, at = dir): Promise<Side> => {
	const calls: string[] = [],
		audit = memoryAudit();
	const host = await hostPorts();
	const release = { id: RELEASE_ID, artifact: artifactPort(at) };
	const database = tenantDbPort(PgliteDb.make(client));
	const branch = await RELEASE_HOST_API.branch(
		{ release, database, audit: audit.port },
		{ signal }
	);
	await branch.schema.migrate({ signal });
	expect(
		await branch.identity.founder(EMAIL, { at: new Date().toISOString(), signal })
	).toMatchObject({ _tag: 'Founded' });
	const workspace = await RELEASE_HOST_API.activate(
		{
			scope: SCOPE,
			audit: audit.port,
			release,
			database,
			publicUrl: PUBLIC_URL,
			files,
			deadlines: deadlines(calls),
			identity: { mail, devSink: true },
			shell: { workspace: () => ({ name: 'Acme', handle: 'acme' }), ai: false },
			agent: {},
			guestIsolates: host.guestIsolates,
			http: host.http,
			images: host.images,
			mcp: host.mcp
		},
		{ signal }
	);
	return {
		calls,
		handle: async (r) => {
			const response = await workspace.handle(r, { address: ADDRESS }).catch((error: unknown) => {
				const failure = Schema.decodeUnknownSync(HostFailure)(error);
				if (failure.code !== 'interrupted') throw error;
				expect(failure).toEqual({
					_tag: 'HostFailure',
					code: 'interrupted',
					phase: 'admission',
					message: 'The workspace generation is closed.'
				});
				return HttpServerResponse.toWeb(responseError(new Interrupted()));
			});
			return response ?? new Response(null, { status: 404 });
		},
		wake: () => workspace.wake({ signal }),
		crons: () => workspace.crons(),
		fire: (id, slot) => workspace.fire(id, slot, { signal }),
		close: () => workspace.close()
	};
};

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const INSTANT = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
const blank = (text: string) => text.replace(UUID, '<id>').replace(INSTANT, '<at>');

/** One request per side with that side's session cookie; the answer as status, the session cookie's name, and the body. */
const call = async (
	side: Side,
	cookie: string,
	method: string,
	path: string,
	body?: unknown,
	headers: Record<string, string> = {}
) => {
	const r = await side.handle(
		new Request(`${ORIGIN}${path}`, {
			method,
			headers: {
				'content-type': 'application/json',
				...(cookie === '' ? {} : { cookie }),
				...headers
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) })
		})
	);
	const set = r.headers.getSetCookie().map((c) => c.split('=')[0]);
	return {
		status: r.status,
		set,
		body: blank(await r.text()),
		cookie: r.headers
			.getSetCookie()
			.map((c) => c.split(';')[0])
			.join('; ')
	};
};
/** The live stream's frames until `done` holds; at most 20 chunks. */
const frames = async (
	reader: ReadableStreamDefaultReader<Uint8Array>,
	done: (frames: readonly string[]) => boolean
): Promise<string[]> => {
	const out: string[] = [];
	for (let i = 0; i < 20 && !done(out); i++) {
		const { value } = await reader.read();
		if (value === undefined) break;
		out.push(
			...new TextDecoder()
				.decode(value)
				.split('\n')
				.filter((l) => l.startsWith('data: '))
				.map((l) => l.slice('data: '.length))
		);
	}
	return out;
};

describe('HOST_API conformance (D10a)', () => {
	it.live('preserves a native close failure as a canonical defect after close settles', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const owner = yield* Effect.acquireRelease(Scope.make(), (scope) =>
					Scope.close(scope, Exit.void)
				);
				const pg = yield* PgliteDb.open().pipe(Scope.provide(owner));
				const close = pg.close.bind(pg);
				pg.close = async () => {
					await close();
					throw Object.assign(new Error('native close reported uncertain storage'), {
						code: '58030'
					});
				};
				const exit = yield* Effect.exit(Scope.close(owner, Exit.void));
				expect(pg.closed).toBe(true);
				expect(Exit.isFailure(exit)).toBe(true);
				if (Exit.isFailure(exit)) {
					const defect = Cause.squash(exit.cause);
					expect(defect).toBeInstanceOf(DbError);
					expect(defect).toMatchObject({ sqlstate: '58030' });
				}
			})
		).pipe(Effect.provide(Pristine.layer))
	);

	it.live(
		'initializes a persistent PGlite directory from a dump and preserves writes after scoped reopen',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const fs = yield* FileSystem.FileSystem;
					const dataDir = yield* fs.makeTempDirectoryScoped({ prefix: 'bolt-pglite-bridge-' });
					const seed = yield* PgliteDb.open();
					const seedDb = PgliteDb.make(seed);
					yield* seedDb.write({
						text: 'CREATE TABLE pglite_boundary_probe (n integer PRIMARY KEY, at timestamptz NOT NULL)',
						params: []
					});
					yield* seedDb.write({
						text: "INSERT INTO pglite_boundary_probe VALUES (7, '2026-10-16T00:00:00.123456Z')",
						params: []
					});
					const dump = yield* Effect.tryPromise({
						try: () => seed.dumpDataDir('none'),
						catch: dbError
					}).pipe(Effect.uninterruptible);
					const owner = yield* Effect.acquireRelease(Scope.make(), (scope) =>
						Scope.close(scope, Exit.void)
					);
					const first = yield* PgliteDb.open({ dataDir, loadDataDir: dump }).pipe(
						Scope.provide(owner)
					);
					const firstDb = PgliteDb.make(first);
					expect(
						yield* firstDb.value(Schema.String, {
							text: "SELECT current_setting('TimeZone')",
							params: []
						})
					).toBe('UTC');
					expect(
						(yield* firstDb.read([
							{ text: 'SELECT n, at FROM pglite_boundary_probe', params: [] }
						]))[0]?.rows
					).toEqual([{ n: 7, at: '2026-10-16T00:00:00.123456Z' }]);
					yield* firstDb.write({
						text: "INSERT INTO pglite_boundary_probe VALUES (8, '2026-10-17T00:00:00Z')",
						params: []
					});
					yield* Scope.close(owner, Exit.void);
					expect(first.closed).toBe(true);
					const reopened = yield* PgliteDb.open({ dataDir });
					expect(
						(yield* PgliteDb.make(reopened).read([
							{ text: 'SELECT n FROM pglite_boundary_probe ORDER BY n', params: [] }
						]))[0]?.rows
					).toEqual([{ n: 7 }, { n: 8 }]);
				})
			).pipe(Effect.provide(Pristine.layer), Effect.provide(NodeServices.layer))
	);

	it.live('answers sign in, q, act, live, a wake and close as the direct composition does', () =>
		Effect.tryPromise({
			try: async () => {
				expect(RELEASE_HOST_API.version).toBe(HOST_API_VERSION);
				expect(RELEASE_HOST_API).not.toBe(HOST_API);
				expect(ReleaseDbError).not.toBe(DbError);
				const artifact = await built();
				const sides = [
					await direct(artifact, await fresh()),
					await viaHostApi(await freshClient())
				] as const;
				/** The same step on each side, in turn. */
				const both = async <A>(
					f: (side: Side, cookie: string) => Promise<A>,
					cookies: readonly [string, string] = ['', '']
				): Promise<readonly [A, A]> => [
					await f(sides[0], cookies[0]),
					await f(sides[1], cookies[1])
				];
				const issuedAt = new Date().toISOString();
				const contract = fingerprint(schemaSlice(artifact.manifest));

				// sign in: the emailed code (the dev sink's fixed one), then the session cookie
				const [code] = await both((s) =>
					call(s, '', 'POST', '/__bolt/session/code', { address: EMAIL })
				);
				expect(code.status).toBe(200);
				const verify = await both((s) =>
					call(s, '', 'POST', '/__bolt/session/verify', { address: EMAIL, code: '123456' })
				);
				expect(verify[0]).toMatchObject({ status: 200, set: ['__Secure-bolt-session'] });
				expect(verify[1]).toEqual({ ...verify[0], cookie: verify[1].cookie });
				const cookies = [verify[0].cookie, verify[1].cookie] as const;
				/** A signed-in POST on each side; both answers match, the first is returned. */
				const same = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
					const [a, b] = await both(
						(s, cookie) => call(s, cookie, 'POST', path, body, headers),
						cookies
					);
					expect({ status: b.status, body: b.body }).toEqual({ status: a.status, body: a.body });
					return a;
				};

				// q
				const read = { m: 'query', a: [{ customers: {} }] };
				expect((await same('/__bolt/q', { reads: [read] })).status).toBe(200);
				// act: a create under the booted contract commits; a retired one is refused releaseChanged (L-BOLT-171)
				const create = { callable: 'customers.create', input: [{ name: 'Acme' }], issuedAt };
				expect(
					(
						await same('/__bolt/act', create, {
							'Idempotency-Key': 'k1',
							'Bolt-Contract': contract
						})
					).status
				).toBe(200);
				expect(
					(
						await same('/__bolt/act', create, {
							'Idempotency-Key': 'k2',
							'Bolt-Contract': 'retired'
						})
					).status
				).toBe(409);
				expect((await same('/__bolt/q', { reads: [read] })).body).toContain('"Acme"');
				// Native SQLSTATE 23505 must become the receiving SDK's unique refusal, not a foreign DbError defect.
				const duplicate = await same('/__bolt/act', create, {
					'Idempotency-Key': 'duplicate-customer',
					'Bolt-Contract': contract
				});
				expect(duplicate.status).toBeLessThan(500);
				expect(duplicate.body).toContain('"code":"unique"');

				// live: the stream's hello names the connection; registering a view answers it on the stream
				const live = await both(async (s, cookie) => {
					const r = await s.handle(new Request(`${ORIGIN}/__bolt/live`, { headers: { cookie } }));
					expect(r.headers.get('content-type')).toContain('text/event-stream');
					const reader = (r.body ?? new ReadableStream<Uint8Array>()).getReader();
					const hello = await frames(reader, (f) => f.some((x) => x.includes('"hello"')));
					const conn = Schema.decodeUnknownSync(
						Schema.fromJsonString(Schema.Struct({ conn: Schema.String }))
					)(hello.find((x) => x.includes('"hello"')) ?? '{}').conn;
					const register = await call(s, cookie, 'POST', '/__bolt/live', {
						conn,
						add: [{ view: 'customers', read }]
					});
					const answered = await frames(reader, (f) => f.some((x) => x.includes('"answer"')));
					await reader.cancel();
					return {
						status: register.status,
						body: register.body,
						answer: blank(answered.find((x) => x.includes('"answer"')) ?? '')
					};
				}, cookies);
				expect(live[0].status).toBe(200);
				expect(live[0].answer).toContain('"Acme"');
				expect(live[1]).toEqual(live[0]);

				// a deadline wake: every due run, then the settle; the scheduling both sides saw is the same
				await both((s) => s.wake());
				expect(sides[1].calls.map(blank)).toEqual(sides[0].calls.map(blank));

				// close: the generation's guest bodies are interrupted (an order's transform runs one)
				await both((s) => s.close());
				const order = {
					callable: 'orders.create',
					input: [{ title: 'desk', region: 'north' }],
					issuedAt
				};
				expect(
					(await same('/__bolt/act', order, { 'Idempotency-Key': 'k3', 'Bolt-Contract': contract }))
						.status
				).not.toBe(200);
			},
			catch: (cause) => BoltError.make('internal', 'admission', String(cause), cause)
		})
	);

	it.live('lists the crons and fires each slot once, as the direct composition does', () =>
		Effect.tryPromise({
			try: async () => {
				const cronManifest = {
					...manifest,
					policies: {
						...manifest.policies,
						ops: { description: 'Ops', grants: { customers: { read: true, create: true } } }
					},
					automations: {
						stamp: {
							description: 'Files a customer',
							on: { cron: '*/15 * * * *' },
							runAs: ['ops']
						},
						peek: { description: 'Counts customers', on: { cron: '0 6 * * *' }, runAs: ['ops'] }
					}
				} satisfies EngineManifest;
				const artifact = await built(
					cronDir,
					cronManifest,
					`export default { automation: {
	stamp: { body: function* (input, ctx) { yield* ctx.act('customers.create', [{ name: 'stamp' }]); } },
	peek: { body: function* (input, ctx) { return (yield* ctx.query({ customers: {} })).customers.rows.length; } }
} };`
				);
				const sides = [
					await direct(artifact, await fresh()),
					await viaHostApi(await freshClient(), cronDir)
				] as const;
				const both = async <A>(f: (side: Side) => Promise<A>): Promise<readonly [A, A]> => [
					await f(sides[0]),
					await f(sides[1])
				];
				const crons = await both((s) => s.crons());
				expect(crons[0]).toEqual([
					{ id: 'stamp', cron: '*/15 * * * *', zone: 'UTC' },
					{ id: 'peek', cron: '0 6 * * *', zone: 'UTC' }
				]);
				expect(crons[1]).toEqual(crons[0]);
				// a slot runs once; a run that only reads writes nothing and answers ran: false
				const slot = '2026-09-25T10:15:00.000Z';
				const fired = await both(async (s) => [
					await s.fire('stamp', slot),
					await s.fire('stamp', slot),
					await s.fire('peek', slot)
				]);
				expect(fired[0]).toEqual([{ ran: true }, { ran: false }, { ran: false }]);
				expect(fired[1]).toEqual(fired[0]);
				await both((s) => s.close());
			},
			catch: (cause) => BoltError.make('internal', 'admission', String(cause), cause)
		})
	);

	it.live('crosses failures as encoded data, never this release’s class', () =>
		Effect.tryPromise({
			try: async () => {
				const missing = await HOST_API.verify(
					{ id: 'x', artifact: artifactPort(join(dir, 'missing')) },
					{ signal }
				).then(
					() => null,
					(e: unknown) => e
				);
				expect(missing).toEqual({
					_tag: 'HostFailure',
					code: 'notFound',
					phase: 'admission',
					message: expect.stringContaining('artifact.json')
				});
				expect(missing).not.toBeInstanceOf(Error);
			},
			catch: (cause) => BoltError.make('internal', 'admission', String(cause), cause)
		})
	);
});
