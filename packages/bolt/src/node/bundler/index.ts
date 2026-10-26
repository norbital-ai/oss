/// <reference types="node" />
// The confined bundler, kernel side (compute model §3 "Running a file", §9; P24): one rolldown process per host
// (`process.ts`), one bundle at a time, serving one tenant for its life. It is replaced when the next bundle is another
// tenant's, on a malformed reply or an exit, and past its recycle threshold after a bundle; its whole CPU, start-up
// included, is read from outside it and billed to that tenant. It holds a serving CPU slot while it bundles. Bundles are
// cached by (tenant, tree digest, entry, rolldown version).
//
// Containment: an empty environment, every byte over IPC, Node's permission model (reads of its own code and rolldown's
// only; rolldown is a native addon, which that model cannot hold), and the OS: macOS `sandbox-exec` (no network, no
// writes, no other programs, no reads outside those paths); on Linux bubblewrap where `/usr/bin/bwrap` exists (new
// namespaces: an empty network, no other processes, a filesystem of the runtime's libraries and those paths, read-only).
// Not yet: seccomp and Landlock on Linux, and a cgroup per process (its CPU is read from /proc).
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Effect, FiberSet, Option, Schema, Semaphore } from 'effect';
import type { Bundled, BundlerPort, BundleRequest } from '../../engine/contracts.ts';

const MiB = 1024 * 1024;
export const BUNDLER = {
	/** A process ending a bundle above this is replaced (one bundle may peak above it). */
	recycleBytes: 128 * MiB,
	/** Bundles kept per host, by code and map bytes. */
	cacheBytes: 64 * MiB,
	/** A tree sent to the bundler, and a reply taken from it. */
	treeBytes: 16 * MiB,
	replyBytes: 16 * MiB,
	bundleMs: 30_000
} as const;
export type BundlerOptions = {
	/** A serving CPU slot for `tenant`, held while its bundle builds; calling the answer frees it. */
	readonly slot?: ((tenant: string) => Promise<() => void>) | undefined;
	/** The process's own CPU since the last reading, billed to the one tenant it serves. */
	readonly meter?: ((tenant: string, cpuNanos: bigint) => void) | undefined;
	readonly recycleBytes?: number | undefined;
	readonly cacheBytes?: number | undefined;
};
export type BundlerCounts = {
	/** Processes started. */
	readonly started: number;
	/** Bundles the process built: a cache hit builds none. */
	readonly built: number;
	/** The live process's pid. */
	readonly pid: number | undefined;
};
export type NodeBundler = {
	readonly port: (tenant: string) => BundlerPort;
	readonly counts: () => BundlerCounts;
};

const Package = Schema.Struct({
	version: Schema.String,
	dependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
	optionalDependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String))
});
const THREADS = {
	ROLLDOWN_WORKER_THREADS: '1',
	ROLLDOWN_MAX_BLOCKING_THREADS: '1',
	RAYON_NUM_THREADS: '1',
	TOKIO_WORKER_THREADS: '1',
	// the allocator returns freed memory at once, and no OpenSSL configuration is read
	MIMALLOC_PURGE_DELAY: '0',
	OPENSSL_CONF: '/dev/null'
};
const BWRAP = '/usr/bin/bwrap';
const quote = (path: string) => JSON.stringify(path);

/**
 * The process's script, rolldown's version, and what it may read: this package (its code), rolldown and the
 * dependencies beside it, and the folder where Node finds rolldown from the script (its links). Then how to start it.
 */
const layout = () => {
	const script = realpathSync(
		fileURLToPath(
			new URL(`./process${import.meta.url.endsWith('.ts') ? '.ts' : '.js'}`, import.meta.url)
		)
	);
	const rolldown = realpathSync(
		dirname(createRequire(import.meta.url).resolve('rolldown/package.json'))
	);
	const manifest = Schema.decodeUnknownSync(Schema.fromJsonString(Package))(
		readFileSync(join(rolldown, 'package.json'), 'utf8')
	);
	const beside = dirname(rolldown);
	const dependencies = Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })
		.map((name) => join(beside, name))
		.filter((dir) => existsSync(dir))
		.map((dir) => realpathSync(dir));
	let links: string | undefined;
	for (let dir = dirname(script); links === undefined && dir !== dirname(dir); dir = dirname(dir))
		if (existsSync(join(dir, 'node_modules', 'rolldown'))) links = join(dir, 'node_modules');
	const own = realpathSync(fileURLToPath(new URL('../../../', import.meta.url)));
	const reads = [
		...new Set([own, beside, rolldown, ...dependencies, ...(links === undefined ? [] : [links])])
	];
	const real = [...new Set(reads.map((path) => realpathSync(path)))];
	const node = realpathSync(process.execPath),
		prefix = dirname(dirname(node));
	const argv = [
		node,
		'--max-old-space-size=48',
		'--max-semi-space-size=1',
		'--permission',
		'--allow-addons',
		...reads.map((path) => `--allow-fs-read=${path}`),
		script
	];
	// macOS: reads only of the runtime and those paths, no network, no writes, no program but node
	const profile = `(version 1)
(allow default)
(deny network*)
(deny file-write*)
(deny process-exec*)
(allow process-exec* (literal ${quote(node)}))
(deny file-read* (subpath "/Users") (subpath "/private/tmp") (subpath "/private/var/folders") (subpath "/private/etc") (subpath "/Volumes") (subpath "/opt"))
(allow file-read* (subpath "/opt/homebrew/Cellar") (subpath "/opt/homebrew/opt") (subpath ${quote(prefix)}) ${real.map((path) => `(subpath ${quote(path)})`).join(' ')})
(allow file-read-metadata)`;
	const command: { readonly file: string; readonly args: readonly string[] } =
		process.platform === 'darwin'
			? { file: '/usr/bin/sandbox-exec', args: ['-p', profile, ...argv] }
			: process.platform === 'linux' && existsSync(BWRAP)
				? {
						file: BWRAP,
						args: [
							'--unshare-all',
							'--die-with-parent',
							'--new-session',
							'--ro-bind',
							'/usr',
							'/usr',
							...['/lib', '/lib64', '/etc/ld.so.cache'].flatMap((path) => [
								'--ro-bind-try',
								path,
								path
							]),
							...[prefix, ...real, ...reads].flatMap((path) => ['--ro-bind', path, path]),
							'--proc',
							'/proc',
							'--dev',
							'/dev',
							'--chdir',
							'/',
							'--',
							...argv
						]
					}
				: { file: node, args: argv.slice(1) };
	return { version: `rolldown@${manifest.version}`, command };
};

type Usage = { readonly cpu: bigint; readonly rss: number };
/** Linux: the process and its descendants (bwrap runs node as its child), from /proc; 100 ticks a second, 4 KiB pages. */
const procUsage = async (pid: number): Promise<Usage> => {
	const text = await readFile(`/proc/${pid}/stat`, 'utf8');
	const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
	let cpu = BigInt(Number(fields[11]) + Number(fields[12])) * 10_000_000n,
		rss = Number(fields[21]) * 4096;
	for (const task of await readdir(`/proc/${pid}/task`))
		for (const child of (
			await readFile(`/proc/${pid}/task/${task}/children`, 'utf8').catch(() => '')
		)
			.split(' ')
			.filter((x) => x !== '')) {
			const used = await procUsage(Number(child));
			cpu += used.cpu;
			rss += used.rss;
		}
	return { cpu, rss };
};
/** Elsewhere (macOS): `ps`, whose CPU time is `[hh:]mm:ss.ss`. */
const psUsage = (pid: number) =>
	new Promise<Usage>((resolve, reject) =>
		execFile('ps', ['-o', 'rss=,time=', '-p', String(pid)], (error, out) => {
			const [rss = '', time = ''] = out.trim().split(/\s+/);
			if (error !== null || time === '') return reject(error ?? new Error('no such process'));
			const seconds = time.split(':').reduce((sum, part) => sum * 60 + Number(part), 0);
			resolve({ cpu: BigInt(Math.round(seconds * 1e9)), rss: Number(rss) * 1024 });
		})
	);
/** The process's CPU and memory read from outside it; none once it is gone. */
const usage = (pid: number | undefined) =>
	Effect.promise(() =>
		pid === undefined
			? Promise.resolve(undefined)
			: (process.platform === 'linux' ? procUsage(pid) : psUsage(pid)).then(
					(used): Usage | undefined => used,
					() => undefined
				)
	);

const Reply = Schema.Union([
	Schema.Struct({ id: Schema.Number, code: Schema.String, map: Schema.String }),
	Schema.Struct({
		id: Schema.Number,
		errors: Schema.Array(Schema.String.check(Schema.isMaxLength(4096))).check(
			Schema.isMinLength(1),
			Schema.isMaxLength(50)
		)
	})
]);
const decodeReply = Schema.decodeUnknownOption(Reply);
type Live = {
	readonly child: ChildProcess;
	readonly pid: number | undefined;
	readonly tenant: string;
	readonly replies: Map<number, (reply: unknown) => void>;
	billed: bigint;
	next: number;
};
const failed = (why: string): Bundled => ({ errors: [`the bundler failed: ${why}`] });
const safePath = (path: string) =>
	path !== '' &&
	!path.startsWith('/') &&
	!path.includes('\0') &&
	!path.includes('\\') &&
	path.split('/').every((part) => part !== '' && part !== '.' && part !== '..');

/** The host's bundler, alive until the scope closes; `port(tenant)` is one tenant's view of it. */
export const bundler = Effect.fn('node.bundler')(function* (options: BundlerOptions = {}) {
	const recycleBytes = options.recycleBytes ?? BUNDLER.recycleBytes,
		cacheBytes = options.cacheBytes ?? BUNDLER.cacheBytes;
	if (process.platform === 'linux' && !existsSync(BWRAP))
		yield* Effect.logWarning(
			'the file-run bundler runs without OS confinement: install bubblewrap (/usr/bin/bwrap)'
		);
	const { version, command } = layout();
	const gate = yield* Semaphore.make(1);
	const run = yield* FiberSet.makeRuntimePromise();
	const cache = new Map<string, { readonly bundled: Bundled; readonly bytes: number }>();
	let cached = 0,
		started = 0,
		built = 0,
		live: Live | undefined;

	const bill = (proc: Live) =>
		Effect.gen(function* () {
			const used = yield* usage(proc.pid);
			if (used === undefined || used.cpu <= proc.billed) return used;
			options.meter?.(proc.tenant, used.cpu - proc.billed);
			proc.billed = used.cpu;
			return used;
		});
	/** Its CPU not yet billed goes to the tenant it served; then it is stopped. */
	const retire = Effect.suspend(() => {
		const proc = live;
		live = undefined;
		return proc === undefined
			? Effect.void
			: bill(proc).pipe(Effect.ensuring(Effect.sync(() => proc.child.kill('SIGKILL'))));
	});
	const start = (tenant: string): Live => {
		const child = spawn(command.file, command.args, {
			cwd: '/',
			env: THREADS,
			stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
			serialization: 'advanced'
		});
		let stderr = '';
		child.stderr?.on('data', (chunk: Buffer) => {
			if (stderr.length < 4096) stderr += chunk.toString();
		});
		const replies = new Map<number, (reply: unknown) => void>();
		child.on('message', (reply: unknown) => {
			const id =
				typeof reply === 'object' && reply !== null && 'id' in reply ? reply.id : undefined;
			for (const [key, answer] of replies)
				if (key === id) {
					replies.delete(key);
					answer(reply);
				}
		});
		// ponytail: CPU since its last reading is lost when it dies on its own; a cgroup per process would keep it
		const exited = () => {
			for (const answer of replies.values()) answer({ exited: stderr.slice(0, 300) });
			replies.clear();
			if (live?.child === child) live = undefined;
		};
		child.on('exit', exited);
		child.on('error', exited);
		started++;
		return { child, pid: child.pid, tenant, replies, billed: 0n, next: 0 };
	};
	const ask = (proc: Live, request: BundleRequest) =>
		Effect.callback<unknown>((resume) => {
			const id = ++proc.next;
			proc.replies.set(id, (reply) => resume(Effect.succeed(reply)));
			proc.child.send({ id, entry: request.entry, files: request.files }, (error) => {
				if (error !== null) resume(Effect.succeed({ exited: error.message }));
			});
			return Effect.sync(() => proc.replies.delete(id));
		}).pipe(
			Effect.timeoutOrElse({
				duration: BUNDLER.bundleMs,
				orElse: () => Effect.succeed({ exited: 'it did not answer in time' })
			})
		);
	const keep = (key: string, bundled: Bundled) => {
		if (!('code' in bundled)) return;
		const bytes = bundled.code.length + bundled.map.length;
		cache.set(key, { bundled, bytes });
		cached += bytes;
		for (const [old, entry] of cache) {
			if (cached <= cacheBytes) break;
			cache.delete(old);
			cached -= entry.bytes;
		}
	};
	const hit = (key: string) => {
		const entry = cache.get(key);
		if (entry === undefined) return undefined;
		cache.delete(key);
		cache.set(key, entry);
		return entry.bundled;
	};
	const slot = (tenant: string) =>
		Effect.acquireRelease(
			Effect.promise(() => options.slot?.(tenant) ?? Promise.resolve(() => {})),
			(free) => Effect.sync(free)
		);
	const build = (tenant: string, request: BundleRequest) =>
		Effect.gen(function* () {
			if (!request.files.every(([path]) => safePath(path)) || !safePath(request.entry))
				return failed('a path is not inside the tree');
			if (request.files.reduce((sum, [, bytes]) => sum + bytes.byteLength, 0) > BUNDLER.treeBytes)
				return failed(`the tree is over ${BUNDLER.treeBytes / MiB} MiB`);
			const key = createHash('sha256')
				.update(`${tenant}\0${request.digest}\0${request.entry}\0${version}`)
				.digest('hex');
			const ready = hit(key);
			if (ready !== undefined) return ready;
			return yield* gate.withPermit(
				Effect.scoped(
					Effect.gen(function* () {
						const again = hit(key);
						if (again !== undefined) return again;
						yield* slot(tenant);
						if (live !== undefined && live.tenant !== tenant) yield* retire;
						const proc = live ?? (live = start(tenant));
						const reply = yield* ask(proc, request);
						built++;
						const used = yield* bill(proc);
						const decoded = decodeReply(reply);
						const size = Option.match(decoded, {
							onNone: () => 0,
							onSome: (r) => ('code' in r ? r.code.length + r.map.length : 0)
						});
						if (Option.isNone(decoded) || size > BUNDLER.replyBytes) {
							yield* retire;
							return failed(
								typeof reply === 'object' && reply !== null && 'exited' in reply
									? 'it stopped'
									: 'a malformed reply'
							);
						}
						if (used === undefined || used.rss > recycleBytes) yield* retire;
						const bundled: Bundled =
							'code' in decoded.value
								? { code: decoded.value.code, map: decoded.value.map }
								: { errors: decoded.value.errors };
						keep(key, bundled);
						return bundled;
					})
				)
			);
		});
	yield* Effect.addFinalizer(() => retire);
	return {
		port: (tenant) => ({
			bundle: (request, signal) => run(build(tenant, request), { signal })
		}),
		counts: () => ({ started, built, pid: live?.pid })
	} satisfies NodeBundler;
});
