// HOST_API conformance (D10a): one black-box slice through HOST_API over `nodePorts()` and a `Facilities` record — sign
// in, q, act, live register, a deadline wake, the host clock's crons and fire, close — over one PGlite; the needs
// check refuses a bundle whose need the host leaves `off`.
import { cpSync, existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from '@effect/vitest';
import {
	Cause,
	Context,
	Effect,
	Exit,
	FileSystem,
	Layer,
	ManagedRuntime,
	Schema,
	Scope
} from 'effect';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { HttpServerResponse } from 'effect/http';
import {
	artifactHash,
	CONTRACT,
	readArtifact,
	treeHash,
	type Artifact
} from '../src/engine/artifact/read.ts';
import type {
	CronEntry,
	CronFired,
	DeadlinesPort,
	FilesPort,
	TransportPort
} from '../src/engine/contracts.ts';
import { PgliteDb, Pristine, type PgliteClient } from '../src/node/db/pglite.ts';
import { BoltError } from '../src/protocol/errors.ts';
import { DbError, Interrupted } from '../src/engine/errors.ts';
import { program } from '../../bolt-cli/src/test/guest.ts';
import { fingerprint, schemaSlice } from '../src/engine/schema/plan.ts';
import { sha256Hex } from '@norbital-ai/store';
import { HOST_API, HostFailure, type HostPorts } from '../src/protocol/host-api.ts';
import { off, type Facilities } from '../src/facilities/index.ts';
import { memoryAudit } from '../../bolt-cli/src/test/audit.ts';
import { responseError } from '../src/protocol/http.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { prepareMigrations } from '../../bolt-cli/src/compiler/migrations.ts';
import { artifactPort } from '../src/node/artifact.ts';
import { tenantDbPort } from '../src/node/db/port.ts';
import { keysPort } from '../src/node/keys.ts';
import { nodePorts, type NodePorts } from '../src/node/ports.ts';
import { guests } from './support/guests.ts';
import { callbacks, guest } from './engine-fixture.ts';
import { CHECKPOINTS } from '../../bolt-cli/src/test/checkpoint.ts';
import { moduleHash } from '../src/node/module-hash.ts';

const ORIGIN = 'https://acme.example',
	PUBLIC_URL = `${ORIGIN}/acme`,
	SCOPE = 'acme/live',
	ADDRESS = '203.0.113.9',
	EMAIL = 'ada@acme.example';
const RELEASE_ID = 'conformance';
const signal = new AbortController().signal;
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

/** The fixture workspace's artifact: the descriptor, the manifest and the guest, digests recorded. */
const dir = mkdtempSync(join(tmpdir(), 'bolt-host-api-')),
	needsDir = mkdtempSync(join(tmpdir(), 'bolt-host-api-needs-'));
const databases: { dispose(): Promise<void> }[] = [];
const native = ManagedRuntime.make(NodeServices.layer);
const hosts = Effect.runSync(Scope.make());
afterAll(async () => {
	for (const database of databases) await database.dispose();
	await Effect.runPromise(Scope.close(hosts, Exit.void));
	await native.dispose();
	rmSync(dir, { recursive: true, force: true });
	rmSync(needsDir, { recursive: true, force: true });
});
/** The same-graph host's ports (guest isolates, http, images, mcp), built once and alive until the suite ends. */
let ports: Promise<NodePorts> | undefined;
const hostPorts = (): Promise<NodePorts> =>
	(ports ??= Effect.runPromise(nodePorts().pipe(Scope.provide(hosts))));
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
/** The slice's workspace: the engine fixture's callbacks plus two crons. */
const sliceManifest = {
	...callbacks,
	policies: {
		...callbacks.policies,
		ops: { description: 'Ops', grants: { customers: { read: true, create: true } } }
	},
	automations: {
		stamp: { description: 'Files a customer', on: { cron: '*/15 * * * *' }, policies: ['ops'] },
		peek: { description: 'Counts customers', on: { cron: '0 6 * * *' }, policies: ['ops'] }
	}
} satisfies EngineManifest;
const sliceSource = guest.source.replace(
	'export default {',
	`export default { automation: {
	stamp: { body: function* (input, ctx) { yield* ctx.act('customers.create', [{ name: 'stamp' }]); } },
	peek: { body: function* (input, ctx) { return (yield* ctx.query({ customers: {} })).customers.rows.length; } }
},`
);
const compiledSlice = native.runPromise(program(sliceSource));
/** The schema's generated history, a checkpoint like the kit's: generated (and replay-proven) once per machine and migration generator. */
const history = async (m: EngineManifest): Promise<string> => {
	const at = join(
		CHECKPOINTS,
		'host-api',
		sha256Hex(
			JSON.stringify([
				await native.runPromise(
					moduleHash(
						fileURLToPath(new URL('../../bolt-cli/src/compiler/migrations.ts', import.meta.url))
					)
				),
				schemaSlice(m)
			])
		)
	);
	if (existsSync(join(at, 'migrations'))) return at;
	const scratch = mkdtempSync(join(tmpdir(), 'bolt-host-api-history-'));
	await native.runPromise(
		prepareMigrations(scratch, m, 'generate').pipe(Effect.provide(Pristine.layer))
	);
	// written whole, then renamed: a parallel process never reads half a history
	const temporary = `${at}.${randomUUID()}`;
	cpSync(join(scratch, 'migrations'), join(temporary, 'migrations'), { recursive: true });
	rmSync(scratch, { recursive: true, force: true });
	try {
		renameSync(temporary, at);
	} catch {
		rmSync(temporary, { recursive: true, force: true }); // another process kept the same history first
	}
	return at;
};
/** `migrations` from a built directory with the same schema (the machine's checkpoint unless given). */
const built = async (at: string, m: EngineManifest, migrations?: string): Promise<Artifact> => {
	const manifestText = JSON.stringify(m);
	// admission reads the release's committed history, exactly as it would for a built workspace
	cpSync(join(migrations ?? (await history(m)), 'migrations'), join(at, 'migrations'), {
		recursive: true
	});
	const compiled = await compiledSlice;
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
	/** Each mail the host sent, as its ABI body. */
	sent: string[];
};

/** The host's facilities: mail records each message (the sign-in code is read from it), every optional member `off`. */
const facilitiesOf = (database: Facilities['storage']['database'], sent: string[]): Facilities => {
	const mail: TransportPort = {
		send: async (_kind, message) => {
			sent.push(JSON.stringify(message));
			return { providerId: `mail:${sent.length}` };
		}
	};
	return {
		storage: { database, files },
		logs: { runtime: { write: () => {}, query: async () => [] }, audit: memoryAudit().port },
		transactional: { mail, sms: off, phone: off, push: off, challenge: off, fixedCodes: false },
		intelligence: { system1: off, system2: off, embed: off, speech: off },
		ports: { webhooks: off, websockets: off, outbound: off },
		sandbox: off,
		keys: keysPort(randomBytes(32))
	};
};
/** Everything around the facilities this host serves: the release, its scope and URL, the kernel ports, the rest `off`. */
const portsOf = (
	facilities: Facilities,
	release: HostPorts['release'],
	host: NodePorts,
	calls: string[]
): HostPorts => ({
	facilities,
	scope: SCOPE,
	release,
	publicUrl: PUBLIC_URL,
	guests,
	deadlines: deadlines(calls),
	images: host.images,
	docs: host.docs,
	bundler: off,
	convert: off,
	geocoder: off,
	web: off,
	browser: off,
	mcp: host.mcp,
	links: off,
	shell: { workspace: () => ({ name: 'Acme', handle: 'acme' }), ai: false },
	agent: {}
});

/** A branch of the release migrated and founded, then activated through HOST_API. */
const viaHostApi = async (client: PgliteClient, at: string): Promise<Side> => {
	const calls: string[] = [],
		sent: string[] = [];
	const host = await hostPorts();
	const release = { id: RELEASE_ID, artifact: artifactPort(at) };
	const database = tenantDbPort(PgliteDb.make(client));
	const facilities = facilitiesOf(database, sent);
	const branch = await HOST_API.branch(
		{ release, database, audit: facilities.logs.audit },
		{ signal }
	);
	await branch.schema.migrate({ signal });
	expect(
		await branch.identity.founder(EMAIL, { at: new Date().toISOString(), signal })
	).toMatchObject({ _tag: 'Founded' });
	const workspace = await HOST_API.activate(portsOf(facilities, release, host, calls), { signal });
	return {
		calls,
		sent,
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
	it.live(
		'initializes a persistent PGlite directory from a dump, keeps its writes across a reopen, and keeps a close failure a defect',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const fs = yield* FileSystem.FileSystem;
					const dataDir = yield* fs.makeTempDirectoryScoped({ prefix: 'bolt-pglite-bridge-' });
					const owner = yield* Effect.acquireRelease(Scope.make(), (scope) =>
						Scope.close(scope, Exit.void)
					);
					// the pristine image is a `dumpDataDir` dump: the directory starts from it
					const first = yield* PgliteDb.open({ dataDir, loadDataDir: yield* yield* Pristine }).pipe(
						Scope.provide(owner)
					);
					const firstDb = PgliteDb.make(first);
					expect(
						yield* firstDb.value(Schema.String, {
							text: "SELECT current_setting('TimeZone')",
							params: []
						})
					).toBe('UTC');
					yield* firstDb.write({
						text: 'CREATE TABLE pglite_boundary_probe (n integer PRIMARY KEY, at timestamptz NOT NULL)',
						params: []
					});
					yield* firstDb.write({
						text: "INSERT INTO pglite_boundary_probe VALUES (7, '2026-10-16T00:00:00.123456Z')",
						params: []
					});
					yield* Scope.close(owner, Exit.void);
					expect(first.closed).toBe(true);
					const again = yield* Effect.acquireRelease(Scope.make(), (scope) =>
						Scope.close(scope, Exit.void)
					);
					const reopened = yield* PgliteDb.open({ dataDir }).pipe(Scope.provide(again));
					expect(
						(yield* PgliteDb.make(reopened).read([
							{ text: 'SELECT n, at FROM pglite_boundary_probe', params: [] }
						]))[0]?.rows
					).toEqual([{ n: 7, at: '2026-10-16T00:00:00.123456Z' }]);
					// a native close failure is a canonical defect once the close settles
					const close = reopened.close.bind(reopened);
					reopened.close = async () => {
						await close();
						throw Object.assign(new Error('native close reported uncertain storage'), {
							code: '58030'
						});
					};
					const exit = yield* Effect.exit(Scope.close(again, Exit.void));
					expect(reopened.closed).toBe(true);
					expect(Exit.isFailure(exit)).toBe(true);
					if (Exit.isFailure(exit)) {
						const defect = Cause.squash(exit.cause);
						expect(defect).toBeInstanceOf(DbError);
						expect(defect).toMatchObject({ sqlstate: '58030' });
					}
				})
			).pipe(Effect.provide(Pristine.layer), Effect.provide(NodeServices.layer))
	);

	it.live('answers sign in, q, act, live, a wake, crons and fire, and close', () =>
		Effect.tryPromise({
			try: async () => {
				const artifact = await built(dir, sliceManifest);
				const client = await freshClient();
				const side = await viaHostApi(client, dir);
				const issuedAt = new Date().toISOString();
				const contract = fingerprint(schemaSlice(artifact.manifest));

				// sign in: the emailed code, then the session cookie
				expect(
					(await call(side, '', 'POST', '/__bolt/session/code', { address: EMAIL })).status
				).toBe(200);
				const code = /\b\d{6}\b/.exec(side.sent.at(-1) ?? '')?.[0] ?? '';
				const verify = await call(side, '', 'POST', '/__bolt/session/verify', {
					address: EMAIL,
					code
				});
				expect(verify).toMatchObject({ status: 200, set: ['__Secure-bolt-session'] });
				const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
					call(side, verify.cookie, 'POST', path, body, headers);

				// q
				const read = { m: 'query', a: [{ customers: {} }] };
				expect((await post('/__bolt/q', { reads: [read] })).status).toBe(200);
				// act: a create under the booted contract commits; a retired one is refused releaseChanged (L-BOLT-171)
				const create = { callable: 'customers.create', input: [{ name: 'Acme' }], issuedAt };
				expect(
					(
						await post('/__bolt/act', create, {
							'Idempotency-Key': 'k1',
							'Bolt-Contract': contract
						})
					).status
				).toBe(200);
				expect(
					(
						await post('/__bolt/act', create, {
							'Idempotency-Key': 'k2',
							'Bolt-Contract': 'retired'
						})
					).status
				).toBe(409);
				expect((await post('/__bolt/q', { reads: [read] })).body).toContain('"Acme"');
				// Native SQLSTATE 23505 crosses as the unique refusal, not a DbError defect.
				const duplicate = await post('/__bolt/act', create, {
					'Idempotency-Key': 'duplicate-customer',
					'Bolt-Contract': contract
				});
				expect(duplicate.status).toBeLessThan(500);
				expect(duplicate.body).toContain('"code":"unique"');

				// live: the stream's hello names the connection; registering a view answers it on the stream
				const r = await side.handle(
					new Request(`${ORIGIN}/__bolt/live`, { headers: { cookie: verify.cookie } })
				);
				expect(r.headers.get('content-type')).toContain('text/event-stream');
				const reader = (r.body ?? new ReadableStream<Uint8Array>()).getReader();
				const hello = await frames(reader, (f) => f.some((x) => x.includes('"hello"')));
				const conn = Schema.decodeUnknownSync(
					Schema.fromJsonString(Schema.Struct({ conn: Schema.String }))
				)(hello.find((x) => x.includes('"hello"')) ?? '{}').conn;
				expect(
					(await post('/__bolt/live', { conn, add: [{ view: 'customers', read }] })).status
				).toBe(200);
				const answered = await frames(reader, (f) => f.some((x) => x.includes('"answer"')));
				await reader.cancel();
				expect(answered.find((x) => x.includes('"answer"'))).toContain('"Acme"');

				// a deadline wake: every due run, then the settle
				await side.wake();
				expect(side.calls.some((c) => c.startsWith(`settle ${SCOPE}`))).toBe(true);

				// the host clock's crons: a slot runs once; a run that only reads writes nothing and answers ran: false
				expect(await side.crons()).toEqual([
					{ id: 'stamp', cron: '*/15 * * * *', zone: 'UTC' },
					{ id: 'peek', cron: '0 6 * * *', zone: 'UTC' }
				]);
				const slot = '2026-09-25T10:15:00.000Z';
				expect([
					await side.fire('stamp', slot),
					await side.fire('stamp', slot),
					await side.fire('peek', slot)
				]).toEqual([{ ran: true }, { ran: false }, { ran: false }]);

				// close: the generation's guest bodies are interrupted (an order's transform runs one)
				await side.close();
				const order = {
					callable: 'orders.create',
					input: [{ title: 'desk', region: 'north' }],
					issuedAt
				};
				expect(
					(await post('/__bolt/act', order, { 'Idempotency-Key': 'k3', 'Bolt-Contract': contract }))
						.status
				).not.toBe(200);

				// the needs check refuses a bundle whose need the host leaves off, before it reads the database
				await built(needsDir, { ...sliceManifest, needs: ['outbound'] }, dir);
				// a release id names its contents: this bundle differs, so it is its own release
				const release = { id: `${RELEASE_ID}-needs`, artifact: artifactPort(needsDir) };
				const database = tenantDbPort(PgliteDb.make(client));
				const refused = await HOST_API.activate(
					portsOf(facilitiesOf(database, []), release, await hostPorts(), []),
					{ signal }
				).then(
					() => null,
					(e: unknown) => e
				);
				expect(refused).toEqual({
					_tag: 'HostFailure',
					code: 'unavailable',
					phase: 'admission',
					message: 'the bundle needs outbound, which this host leaves off'
				});

				// a cell reads a release once, however many static calls arrive together (each page load makes one)
				const files = artifactPort(needsDir);
				let reads = 0;
				const counted = {
					id: `${RELEASE_ID}-counted`,
					artifact: {
						...files,
						read: (path: string, signal: AbortSignal) => {
							if (path === 'artifact.json') reads++;
							return files.read(path, signal);
						}
					}
				};
				await Promise.all([
					HOST_API.framePolicy(counted, '/', { signal }),
					HOST_API.framePolicy(counted, '/app', { signal }),
					HOST_API.schema.slice(counted, { signal })
				]);
				await HOST_API.verify(counted, { signal });
				expect(reads).toBe(1);

				// failures cross as encoded data, never this release's class
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
