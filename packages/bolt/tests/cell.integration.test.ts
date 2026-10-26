// The cell (compute model §14): the built `build/cell.js` booted with `bootCell` over `nodePorts()` serves the fixture
// workspace as this release's in-process HOST_API does, each over its own fresh PGlite; every entry is metered, and the
// metered deltas add up to the cell isolate's whole `cpuTime`. The cell has none of Node's globals.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ivm from 'isolated-vm';
import { afterAll, describe, expect, it } from '@effect/vitest';
import { Context, Effect, Exit, Layer, ManagedRuntime, Scope } from 'effect';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { artifactHash, CONTRACT, treeHash } from '../src/engine/artifact/read.ts';
import { prepareMigrations } from '../src/compiler/migrations.ts';
import type { DeadlinesPort, FilesPort, TransportPort } from '../src/engine/contracts.ts';
import { fingerprint, schemaSlice } from '../src/engine/schema/plan.ts';
import { sha256Hex } from '@norbital-ai/store';
import { HOST_API, type HostApi } from '../src/protocol/host-api.ts';
import { artifactPort } from '../src/node/artifact.ts';
import { bootCell } from '../src/node/cell-host.ts';
import { PgliteDb, Pristine, type PgliteClient } from '../src/node/db/pglite.ts';
import { tenantDbPort } from '../src/node/db/port.ts';
import { nodePorts } from '../src/node/ports.ts';
import { program } from './support/guest-fixture.ts';
import { guest, manifest } from './engine-fixture.ts';
import { memoryAudit } from '../src/test/audit.ts';

const ORIGIN = 'https://acme.example',
	PUBLIC_URL = `${ORIGIN}/acme`,
	SCOPE = 'acme/live',
	ADDRESS = '203.0.113.9',
	EMAIL = 'ada@acme.example',
	RELEASE_ID = 'cell';
const CELL_JS = join(import.meta.dirname, '..', 'build', 'cell.js');
const signal = new AbortController().signal;
const mail: TransportPort = { send: async () => ({ providerId: 'mail' }) };
const files: FilesPort = {
	put: async (bytes, meta) => ({ key: 'k', bytes: bytes.length, sha256: '', mime: meta.mime }),
	get: async () => new Uint8Array(),
	url: async (key) => `${ORIGIN}/files/${key}`,
	remove: async () => undefined,
	download: () => Promise.reject(new Error('this host downloads nothing'))
};
const deadlines: DeadlinesPort = {
	announce: () => undefined,
	settle: () => undefined,
	teardown: () => undefined
};

const dir = mkdtempSync(join(tmpdir(), 'bolt-cell-'));
const native = ManagedRuntime.make(NodeServices.layer);
const hosts = Effect.runSync(Scope.make());
const databases: { dispose(): Promise<void> }[] = [];
const disposals: (() => Promise<void> | void)[] = [];
afterAll(async () => {
	for (const dispose of disposals.reverse()) await dispose();
	for (const database of databases) await database.dispose();
	await Effect.runPromise(Scope.close(hosts, Exit.void));
	await native.dispose();
	rmSync(dir, { recursive: true, force: true });
});
class NativeDatabase extends Context.Service<NativeDatabase, PgliteClient>()('test/CellPglite') {}
const freshClient = async (): Promise<PgliteClient> => {
	const runtime = ManagedRuntime.make(
		Layer.effect(NativeDatabase, PgliteDb.open()).pipe(Layer.provide(Pristine.layer))
	);
	databases.push(runtime);
	return runtime.runPromise(NativeDatabase);
};
/** `bolt build`'s output for the fixture workspace, as the HOST_API conformance suite writes it. */
const built = async () => {
	const manifestText = JSON.stringify(manifest);
	// admission reads the release's committed history, exactly as it would for a built workspace
	await native.runPromise(
		prepareMigrations(dir, manifest, 'generate').pipe(Effect.provide(Pristine.layer))
	);
	const compiled = await native.runPromise(program(guest.source));
	writeFileSync(join(dir, 'manifest.json'), manifestText);
	writeFileSync(join(dir, 'guest.mjs'), compiled.source);
	const body = {
		format: 1 as const,
		contract: CONTRACT,
		handle: 'acme',
		name: 'Acme',
		schema: fingerprint(schemaSlice(manifest)),
		client: { entry: 'index.js', css: [] },
		pages: {},
		hashes: {
			manifest: sha256Hex(manifestText),
			guest: sha256Hex(compiled.source),
			client: await native.runPromise(treeHash(join(dir, 'client'))),
			server: await native.runPromise(treeHash(join(dir, 'server')))
		}
	};
	writeFileSync(
		join(dir, 'artifact.json'),
		JSON.stringify({ ...body, hash: await native.runPromise(artifactHash(dir, body)) })
	);
};

type Served = (request: Request) => Promise<Response>;
/** One environment through `api`: migrated, its founder made, activated. */
const serve = async (
	api: HostApi,
	run: <A>(work: () => Promise<A>) => Promise<A>
): Promise<Served> => {
	const host = await Effect.runPromise(nodePorts().pipe(Scope.provide(hosts)));
	const release = { id: RELEASE_ID, artifact: artifactPort(dir) };
	const database = tenantDbPort(PgliteDb.make(await freshClient()));
	const audit = memoryAudit();
	const branch = await run(() => api.branch({ release, database, audit: audit.port }, { signal }));
	await run(() => branch.schema.migrate({ signal }));
	expect(
		await run(() => branch.identity.founder(EMAIL, { at: new Date().toISOString(), signal }))
	).toMatchObject({
		_tag: 'Founded'
	});
	const workspace = await run(() =>
		api.activate(
			{
				scope: SCOPE,
				release,
				database,
				publicUrl: PUBLIC_URL,
				audit: audit.port,
				files,
				deadlines,
				identity: { mail, devSink: true },
				shell: { workspace: () => ({ name: 'Acme', handle: 'acme' }), ai: false },
				agent: {},
				guestIsolates: host.guestIsolates,
				http: host.http,
				images: host.images,
				mcp: host.mcp
			},
			{ signal }
		)
	);
	disposals.push(() => workspace.close().catch(() => undefined));
	return async (request) =>
		(await run(() => workspace.handle(request, { address: ADDRESS }))) ??
		new Response(null, { status: 404 });
};

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const INSTANT = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
const blank = (text: string) => text.replace(UUID, '<id>').replace(INSTANT, '<at>');
const call = async (served: Served, cookie: string, path: string, body: unknown) => {
	const response = await served(
		new Request(`${ORIGIN}${path}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', ...(cookie === '' ? {} : { cookie }) },
			body: JSON.stringify(body)
		})
	);
	return {
		status: response.status,
		set: response.headers.getSetCookie().map((c) => c.split('=')[0]),
		body: blank(await response.text()),
		cookie: response.headers
			.getSetCookie()
			.map((c) => c.split(';')[0])
			.join('; ')
	};
};

describe('the cell', () => {
	it.live('serves the workspace as the in-process HOST_API does, and meters every entry', () =>
		Effect.promise(async () => {
			await built();
			const metered: { unit: string; nanos: bigint }[] = [];
			const cell = await bootCell(readFileSync(CELL_JS, 'utf8'), {
				memoryMiB: 128,
				slot: async () => () => undefined,
				meter: (unit, nanos) => void metered.push({ unit, nanos }),
				// the hog overruns at once; everything else has room
				entryTimeoutMs: (unit) => (unit === 'acme/live:hog' ? 1 : 10_000)
			});
			disposals.push(() => cell.dispose());

			expect(cell.api.version).toBe(HOST_API.version);
			expect(cell.api.contract).toBe(HOST_API.contract);
			expect(cell.api.cookieSite(true)).toBe(HOST_API.cookieSite(true));
			const sides = [
				await serve(HOST_API, (work) => work()),
				await serve(cell.api, (work) => cell.run('acme/live:request', work))
			] as const;
			const both = async (cookies: readonly [string, string], path: string, body: unknown) =>
				[
					await call(sides[0], cookies[0], path, body),
					await call(sides[1], cookies[1], path, body)
				] as const;

			const [code, cellCode] = await both(['', ''], '/__bolt/session/code', { address: EMAIL });
			expect(code.status).toBe(200);
			expect(cellCode).toEqual(code);
			const [verify, cellVerify] = await both(['', ''], '/__bolt/session/verify', {
				address: EMAIL,
				code: '123456'
			});
			expect(verify).toMatchObject({ status: 200, set: ['__Secure-bolt-session'] });
			expect(cellVerify).toEqual({ ...verify, cookie: cellVerify.cookie });
			const read = { reads: [{ m: 'query', a: ['customers', { all: true }] }] };
			const [q, cellQ] = await both([verify.cookie, cellVerify.cookie], '/__bolt/q', read);
			expect(q.status).toBe(200);
			expect({ status: cellQ.status, body: cellQ.body }).toEqual({
				status: q.status,
				body: q.body
			});

			// every entry is metered to a unit, and nothing the isolate ran escaped its entries
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(metered.map(({ unit }) => unit)).toContain('boot');
			expect(metered.map(({ unit }) => unit)).toContain('acme/live:request');
			expect(metered.reduce((sum, { nanos }) => sum + nanos, 0n)).toBe(cell.cpuNanos());

			// a host function the cell calls may move the rest of that entry, and what it starts, to the next unit
			const port = artifactPort(dir);
			let stepped = false;
			await cell.run('acme/live:step-1', () =>
				cell.api.verify(
					{
						id: 'acme',
						artifact: {
							...port,
							read: (path, abort) => {
								if (!stepped) cell.step('acme/live:step-2');
								stepped = true;
								return port.read(path, abort);
							}
						}
					},
					{ signal }
				)
			);
			await new Promise((resolve) => setTimeout(resolve, 50));
			const units = metered.map(({ unit }) => unit);
			expect(units.indexOf('acme/live:step-2')).toBeGreaterThan(units.indexOf('acme/live:step-1'));

			// a unit that overruns ends alone: its entry fails, the cell is retired, and other work still runs on it
			const release = { id: RELEASE_ID, artifact: artifactPort(dir) };
			// its manifest is 20 MB of JSON: parsing it is one entry far past the hog's 1 ms
			const heavy = new TextEncoder().encode(
				JSON.stringify({ rows: Array.from({ length: 2_000_000 }, (_, i) => i) })
			);
			const hog = {
				id: RELEASE_ID,
				artifact: {
					...release.artifact,
					read: (path: string, abort: AbortSignal) =>
						path === 'manifest.json' ? Promise.resolve(heavy) : release.artifact.read(path, abort)
				}
			};
			const overrun = await cell
				.run('acme/live:hog', () => cell.api.verify(hog, { signal }))
				.then(
					() => null,
					(error: unknown) => error
				);
			expect(overrun).toMatchObject({ _tag: 'HostFailure', code: 'cpuBudget' });
			expect(await cell.retired).toMatchObject({ code: 'cpuBudget' });
			await expect(
				cell.run('acme/live:after', () => cell.api.verify(release, { signal }))
			).resolves.toBeUndefined();

			// the bundle brings no Node or fetch of its own: evaluated bare, it defines none
			const bare = new ivm.Isolate({ memoryLimit: 128 });
			disposals.push(() => bare.dispose());
			const context = await bare.createContext();
			await context.eval(readFileSync(CELL_JS, 'utf8'));
			expect(await context.eval('[typeof process, typeof require, typeof fetch].join()')).toBe(
				'undefined,undefined,undefined'
			);
		})
	);
});
