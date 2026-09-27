/// <reference types="node" />
// `bolt dev` (§5.1, rules 69, 71): build, then one in-process host on PGlite — the engine, the shell's session routes,
// `/__bolt/{q,act,live}` and the built client — over the generic host ports (dev mail sink with the fixed code, local
// files, in-process deadlines). Watching `src/` and `seed/` rebuilds and hot-swaps the activation; a failed step keeps
// the previous one serving. Destructive schema steps are accepted (only here, rule 69).
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, watch, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { type Artifact, loadPackWithAssets, readPack, type Pack } from '../compiler/artifact/index.ts';
import type { Blob, FilesPort, TenantDb, TransportPort } from '../engine/contracts.ts';
import { RateWindows } from '../engine/access/rate.ts';
import { openPglite } from '../engine/db/pglite.ts';
import { Authorities } from '../engine/identity/actor.ts';
import { founderBootstrap, loadKeys, type IdentityHost } from '../engine/identity/session.ts';
import { engine, type Engine } from '../engine/index.ts';
import { inProcessDeadlines } from '../engine/runs/scheduler.ts';
import { boltHandler } from '../protocol/http.ts';
import { filesHandler } from '../protocol/files.ts';
import { devTurnstile, shellHost } from '../shell/host.ts';
import { fileAttachments } from '../shell/data.ts';
import { AuthorErrors, buildWorkspace, type Log } from './build.ts';

export type DevOptions = { port?: number; seed?: string; bank?: string; founder?: string; db?: string; log: Log; watch?: boolean };
export type DevHost = { url: string; engine(): Engine; swap(a: Artifact): Promise<void>; close(): Promise<void> };

const SCOPE = 'dev';
const TYPES: { readonly [ext: string]: string } = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
	'.css': 'text/css', '.json': 'application/json', '.map': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
	'.webp': 'image/webp', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.onnx': 'application/octet-stream', '.mp3': 'audio/mpeg' };

/** Blobs as files under `dir` (the self-host `local` files provider has the same shape). */
export function localFiles(dir: string): FilesPort {
	mkdirSync(dir, { recursive: true });
	const at = (key: string) => { if (!/^[0-9a-f-]{36}$/.test(key)) throw new Error(`bad file key ${key}`); return join(dir, key); };
	return {
		async put(bytes, meta): Promise<Blob> {
			const key = randomUUID();
			writeFileSync(at(key), bytes);
			return { key, bytes: bytes.byteLength, sha256: '', mime: meta.mime };
		},
		async get(key, max) {
			if (statSync(at(key)).size > max) throw new Error(`file ${key} is over ${max} bytes`);
			return readFileSync(at(key));
		},
		async url(key) { return `/__bolt/files/${key}`; },
		async remove(key) { rmSync(at(key), { force: true }); },
	};
}

/** The dev mail sink (rule 38a(f)): nothing leaves the machine; every message is printed. */
const devMail = (log: Log): TransportPort => ({
	async send(_channel, message) { log(`mail (dev sink): ${JSON.stringify(message)}`); return { providerId: randomUUID() }; },
	subscribe: () => () => {},
});

function toRequest(req: IncomingMessage, origin: string): Request {
	const headers = new Headers();
	for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) for (const x of Array.isArray(v) ? v : [v]) headers.append(k, x);
	const body = req.method === 'GET' || req.method === 'HEAD' ? null : Readable.toWeb(req) as ReadableStream<Uint8Array>;
	return new Request(new URL(req.url ?? '/', origin), { method: req.method ?? 'GET', headers, ...(body === null ? {} : { body, duplex: 'half' }) } as RequestInit);
}
async function send(res: ServerResponse, r: Response): Promise<void> {
	res.statusCode = r.status;
	r.headers.forEach((v, k) => { if (k !== 'set-cookie') res.setHeader(k, v); });
	const cookies = r.headers.getSetCookie();
	if (cookies.length > 0) res.setHeader('set-cookie', cookies);
	if (r.body === null) { res.end(); return; }
	Readable.fromWeb(r.body as never).on('error', () => res.destroy()).pipe(res);
}
/** The client build, then the artifact's own `assets/**` at `/assets/*` (the workspace assets), then the document. */
function staticFile(dir: string, artifact: string, path: string): Response {
	const at = (base: string, rel: string) => { const f = normalize(join(base, decodeURIComponent(rel))); return f.startsWith(base + sep) && existsSync(f) && statSync(f).isFile() ? f : undefined; };
	const hit = at(dir, path) ?? (path.startsWith('/assets/') ? at(artifact, path) : undefined) ?? join(dir, 'index.html');
	const immutable = hit !== join(dir, 'index.html') && path.startsWith('/assets/');
	return new Response(readFileSync(hit), { headers: { 'content-type': TYPES[extname(hit)] ?? 'application/octet-stream',
		'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' } });
}

/** Activates `a` on `db` and serves it on `port`; `swap` re-activates the same database with another build. */
export async function devHost(a: Artifact, db: TenantDb, o: { port: number; pack?: Pack; founder?: string; files: FilesPort; log: Log }): Promise<DevHost> {
	const origin = `http://127.0.0.1:${o.port}`;
	const mail = devMail(o.log);
	let current: { e: Engine; handle: (r: Request) => Promise<Response | null>; client: string; dir: string } | undefined;
	const deadlines = inProcessDeadlines(async () => { await current?.e.runs?.tick(); });
	const ips = new WeakMap<Request, string>();
	let identity: IdentityHost | undefined;

	const activate = async (next: Artifact, pack?: Pack) => {
		const m = next.manifest;
		const e = engine({ manifest: m, db, guest: next.guest, transforms: next.transforms, deadlines, scope: SCOPE, files: o.files,
			transports: { email: mail }, agent: { attachments: fileAttachments(db, o.files) }, console: (level, ...args) => o.log(`guest ${level}: ${args.map(String).join(' ')}`),
			...(pack === undefined || pack.meta.start.length === 0 ? {} : { runs: { start: pack.meta.start } }) } as Parameters<typeof engine>[0]);
		await e.migrate({ accept: true });
		identity ??= { db, now: () => new Date(), windows: new RateWindows(), keys: await loadKeys(db), mail, devSink: true, publicUrl: origin };
		await e.channels.activate();
		e.channels.subscribe();
		if (pack !== undefined) o.log(await loadPackWithAssets(db, m, pack, o.files, new Date().toISOString())
			? `seeded pack ${pack.meta.name} (${pack.meta.hash.slice(0, 12)})` : `pack ${pack.meta.name} not loaded: the database has rows`);
		await e.runs!.boot();
		const authorities = new Authorities(m, next.artifact.hash);
		const shell = shellHost({ manifest: m, identity, authorities, workspace: { name: next.artifact.name, handle: next.artifact.handle },
			ip: (r) => ips.get(r) ?? '127.0.0.1', turnstile: devTurnstile, runs: e.runs!, secure: false, ai: false });
		const bindings = () => { const now = new Date().toISOString(); return { now, today: now.slice(0, 10), tz: m.workspace.tz, params: {} }; };
		const bolt = boltHandler({ engine: e, session: shell.authority, uuid: randomUUID, bindings });
		const files = filesHandler({ engine: e, session: shell.authority, bindings });
		current?.e.live.close(next.artifact.hash); // rule 66: the old generation's streams close and reconnect to this one
		current = { e, client: resolve(next.client), dir: resolve(next.dir), handle: async (r) => (await shell.handle(r)) ?? (await files(r)) ?? (await bolt(r)) };
	};
	await activate(a, o.pack);
	if (o.founder !== undefined) {
		const f = await founderBootstrap(identity!, o.founder);
		o.log(f.ok ? `founder ${o.founder}: sign in with code 123456 (dev sink)` : `founder: ${f.message}`);
	}

	const server = createServer((req, res) => {
		void (async () => {
			const request = toRequest(req, origin);
			ips.set(request, req.socket.remoteAddress ?? '127.0.0.1');
			const path = new URL(request.url).pathname;
			const answer = await current!.handle(request)
				?? (path.startsWith('/__bolt/') ? new Response(JSON.stringify({ error: { code: 'notFound', message: 'No such route.' } }), { status: 404, headers: { 'content-type': 'application/json' } })
					: staticFile(current!.client, current!.dir, path));
			await send(res, answer);
		})().catch((e: unknown) => {
			o.log(`request failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
			if (!res.headersSent) res.statusCode = 500;
			res.end();
		});
	});
	await new Promise<void>((ok, fail) => { server.once('error', fail); server.listen(o.port, '127.0.0.1', () => ok()); });
	return {
		url: origin,
		engine: () => current!.e,
		swap: (next) => activate(next),
		async close() {
			deadlines.stop();
			server.closeAllConnections();
			await new Promise<void>((ok) => server.close(() => ok()));
		},
	};
}

/** Which pack `--seed` names: `base` (default), `sample` (built from `--bank`), `none`, or a pack directory. */
function packOf(root: string, seed: string): Pack | undefined {
	if (seed === 'none') return undefined;
	const dir = seed === 'base' || seed === 'sample' ? join(root, '.norbital', 'seed', seed) : resolve(seed);
	if (!existsSync(join(dir, 'pack.json'))) throw new Error(`no seed pack at ${dir}${seed === 'sample' ? ' (pass --bank=<bank checkout>)' : ''}`);
	return readPack(dir);
}

export async function dev(root: string, o: DevOptions): Promise<DevHost> {
	const { artifact } = await buildWorkspace(root, { ...(o.bank === undefined ? {} : { bank: o.bank }), types: false, log: o.log });
	const { db } = await openPglite(o.db === undefined ? undefined : resolve(o.db));
	const pack = packOf(root, o.seed ?? 'base');
	const host = await devHost(artifact, db, { port: o.port ?? 5180, ...(pack === undefined ? {} : { pack }), ...(o.founder === undefined ? {} : { founder: o.founder }),
		files: localFiles(join(root, '.norbital', 'cache', 'dev-files')), log: o.log });
	o.log(`dev ready: ${host.url}`);
	if (o.watch === false) return host;
	// ponytail: one debounced rebuild of the whole workspace per burst; incremental bundles when ≤ 2 s stops holding (§5.1)
	let timer: ReturnType<typeof setTimeout> | undefined, running = Promise.resolve();
	const rebuild = () => {
		running = running.then(async () => {
			const t0 = Date.now();
			try {
				const next = await buildWorkspace(root, { types: false });
				await host.swap(next.artifact);
				o.log(`reloaded ${next.artifact.artifact.hash.slice(0, 12)} in ${Date.now() - t0} ms`);
			} catch (e) {
				if (e instanceof AuthorErrors) for (const d of e.errors) o.log(`${d.code} ${d.message}`);
				else o.log(`rebuild failed: ${e instanceof Error ? e.message : String(e)}`);
				o.log('kept the previous activation');
			}
		});
	};
	for (const dir of ['src', 'seed'].map((d) => join(root, d)).filter((d) => existsSync(d)))
		watch(dir, { recursive: true }, () => { clearTimeout(timer); timer = setTimeout(rebuild, 150); });
	return host;
}
