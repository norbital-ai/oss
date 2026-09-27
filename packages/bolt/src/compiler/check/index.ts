/// <reference types="node" />
// `bolt check` (rule 7): discover → names → bundle → evaluate → manifest → seed decode → schema → build checks, every
// error of every stage in one run (a stage whose input failed is skipped, the others still run). tsc, svelte-check and
// doctor follow in the CLI. Declarations are evaluated in isolated-vm (rule 2) with a frozen clock and a seeded
// `Math.random`, twice, and the two manifest hashes must match; the guest program obeys rule 6's walls.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, extname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import ivm from 'isolated-vm';
import { build, type Rollup } from 'vite';
import { engineManifest, type EngineManifest, type RowData } from '../../engine/contracts.ts';
import { PRELUDE } from '../../engine/guest/prelude.ts';
import { assetHook, digest, randomStream, type GuestProgram } from '../../engine/guest/runner.ts';
import { plan } from '../../engine/schema/plan.ts';
import { decodeSeed, type SeedPack } from '../../engine/write/seed.ts';
import { discover, ROLES, type Discovered } from '../discover.ts';
import { load, manifestErrors, type Manifest } from '../load.ts';
import { namesIndex, writeNames, writeTypeSetup } from '../names.ts';
import { buildChecks } from './rules.ts';

export type Stage = 'discover' | 'names' | 'bundle' | 'evaluate' | 'manifest' | 'seed' | 'schema' | 'rules';
/** An author error; `line` (1-based) when the checker names one. */
export type CheckDiagnostic = { code: string; path: string; line?: number; message: string; help?: string };
export type CheckResult = {
	/** The stages that ran, in order (test `compiler/check-order`). */
	stages: Stage[]; errors: CheckDiagnostic[];
	manifest?: EngineManifest; guest?: GuestProgram;
	/** Collections that attach a transform body. */
	transforms: string[]; seed?: SeedPack;
};

const GUEST_BYTES = 8 * 1024 * 1024, EVAL_CPU_MS = 100, FROZEN = Date.UTC(2000, 0, 1);
// src or the published build; a path join, since a DOM test environment's transform rewrites `new URL(…, import.meta.url)` to an asset
const BOLT = join(dirname(fileURLToPath(import.meta.url)), '../..', `index${extname(fileURLToPath(import.meta.url))}`);
const ENTRY = 'virtual:bolt-guest', BYTES = '?bytes', BYTES_ID = '\0bolt-bytes:';
const NODE = new Set([...builtinModules, ...builtinModules.map((b) => `node:${b}`)]);
type Bodies = { transforms: string[]; automations: string[] };

/** Checks the workspace at `root`; `bolt` is the module specifier the names index augments. */
export async function check(dir: string, options: { bolt?: string } = {}): Promise<CheckResult> {
	const root = realpathSync(dir);   // importers arrive resolved; relative paths need the same spelling
	const stages: Stage[] = [], errors: CheckDiagnostic[] = [];
	const stage = (s: Stage) => stages.push(s);
	const out: CheckResult = { stages, errors, transforms: [] };

	stage('discover');
	const { files, errors: layout } = discover(root);
	errors.push(...layout);

	// the index is path-derived (rule 8); integration directions are the manifest's, filled in at the manifest stage
	stage('names');
	writeTypeSetup(root);   // before bundling: the workspace tsconfig extends it
	const empty = Object.fromEntries(ROLES.map((r) => [r.role, {}])) as Manifest;
	writeNames(root, namesIndex(files, empty, options.bolt));

	stage('bundle');
	const code = files.filter((f) => f.path.endsWith('.ts'));
	const bundled = await bundle(root, code, errors);
	if (bundled === undefined) return out;
	out.guest = bundled;

	stage('evaluate');
	const evaluated = await evaluateTwice(bundled, errors);
	if (evaluated === undefined) return out;

	stage('manifest');
	const { roles, bodies } = JSON.parse(evaluated) as { roles: { [role: string]: { [name: string]: unknown } }; bodies: Bodies };
	const { manifest, errors: text } = await load(root, files.filter((f) => !f.path.endsWith('.ts')));
	errors.push(...text);
	for (const f of code) manifest[f.role][f.name] = roles[f.role]?.[f.name];
	errors.push(...manifestErrors(manifest));
	writeNames(root, namesIndex(files, manifest, options.bolt));
	let m: EngineManifest;
	try {
		m = engineManifest(manifest);
	} catch (e) {
		errors.push({ code: 'manifest/invalid', path: 'src', message: e instanceof Error ? e.message : String(e) });
		return out;
	}
	out.manifest = m;
	out.transforms = bodies.transforms;

	stage('seed');
	const pack = seedPack(root, errors);
	try {
		// identity rows (`sys_*`) are the identity area's seed; the rest decode against the manifest
		const tenant = Object.fromEntries(Object.entries(pack).filter(([c]) => !c.startsWith('sys_')));
		decodeSeed(m, tenant);
		out.seed = tenant;
	} catch (e) {
		errors.push({ code: 'seed/decode', path: 'seed', message: e instanceof Error ? e.message : String(e) });
	}

	stage('schema');
	try {
		plan(null, m);
	} catch (e) {
		errors.push({ code: `schema/${(e as { code?: string }).code ?? 'invalid'}`, path: 'src/data', message: e instanceof Error ? e.message : String(e) });
	}

	stage('rules');
	const where = (role: string, name: string) => files.find((f) => f.role === role && f.name === name)?.path ?? `src (${role} ${name})`;
	errors.push(...buildChecks(m, bodies, where));
	return out;
}

/** One ES module whose default export holds every code role by name (the C2 guest ABI); rule 6's import walls. */
async function bundle(root: string, code: readonly Discovered[], errors: CheckDiagnostic[]): Promise<GuestProgram | undefined> {
	const byRole = Map.groupBy(code, (f) => f.role);
	const entry = [...code.map((f, i) => `import r${i} from ${JSON.stringify(join(root, f.path))};`),
		`export default { ${[...byRole].map(([role, fs]) => `${role}: { ${fs.map((f) => `${JSON.stringify(f.name)}: r${code.indexOf(f)}`).join(', ')} }`).join(', ')} };`].join('\n');
	let result: Rollup.RollupOutput;
	const assets: Record<string, Uint8Array> = {};
	try {
		result = await build({
			configFile: false, logLevel: 'silent', root,
			resolve: { alias: [{ find: /^@norbital-ai\/bolt$/, replacement: BOLT }] },
			plugins: [{
				name: 'bolt:guest', enforce: 'pre',
				async resolveId(id, importer) {
					if (id === ENTRY) return `\0${ENTRY}`;
					// §5.8: `import bytes from './x.wasm?bytes'` is the file's bytes, a server-only asset of the artifact
					if (id.endsWith(BYTES)) {
						const file = await this.resolve(id.slice(0, -BYTES.length), importer, { skipSelf: true });
						return file === null ? null : `${BYTES_ID}${file.id}`;
					}
					if (!NODE.has(id) || importer?.startsWith('\0') === true) return null;
					const from = importer === undefined ? 'src' : relative(root, importer).split(sep).join('/');
					errors.push({ code: 'guest/node-import', path: from, message: `${from}: imports '${id}'; guest code runs in the isolate, which has no node modules (rule 6)` });
					return { id, external: true };
				},
				load(id) {
					if (id === `\0${ENTRY}`) return entry;
					if (!id.startsWith(BYTES_ID)) return null;
					const bytes = new Uint8Array(readFileSync(id.slice(BYTES_ID.length)));
					const sha = createHash('sha256').update(bytes).digest('hex');
					assets[sha] = bytes;
					// ponytail: every invocation copies the bytes in at module evaluation; lazy access when an asset is large
					return `export default globalThis[Symbol.for('norbital.bolt.asset')](${JSON.stringify(sha)});`;
				},
			}],
			build: { write: false, minify: false, sourcemap: true, rollupOptions: { input: ENTRY, preserveEntrySignatures: 'strict', output: { format: 'es', entryFileNames: 'guest.mjs', codeSplitting: false } } },
		}) as Rollup.RollupOutput;
	} catch (e) {
		errors.push({ code: 'bundle/failed', path: 'src', message: e instanceof Error ? e.message : String(e) });
		return undefined;
	}
	const chunk = result.output.find((o): o is Rollup.OutputChunk => o.type === 'chunk')!;
	if (Buffer.byteLength(chunk.code) > GUEST_BYTES) errors.push({ code: 'guest/size', path: 'guest.mjs', message: `guest.mjs is over 8 MiB (rule 6)` });
	return { source: chunk.code, ...(chunk.map === null ? {} : { sourceMap: chunk.map.toString() }), ...(Object.keys(assets).length > 0 ? { assets } : {}) };
}

// Rule 2's evaluation context: a frozen clock and a seeded `Math.random` (mulberry32), installed before the module runs.
const FREEZE = `{ const T = ${FROZEN}, D = Date;
	globalThis.Date = class extends D { constructor(...a) { if (a.length === 0) super(T); else super(...a); } static now() { return T; } };
	let s = 0x2545f491; Math.random = () => { s = s + 0x6d2b79f5 | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }`;
// Declarations are data (functions drop out of JSON); which bodies are attached is read beside them.
const SERIALIZE = `(() => { const d = globalThis.__ns.default, bodies = { transforms: [], automations: [] };
	for (const [n, c] of Object.entries(d.collection ?? {})) if (typeof c?.bodies?.transform === 'function') bodies.transforms.push(n);
	for (const [n, a] of Object.entries(d.automation ?? {})) if (typeof a?.body === 'function') bodies.automations.push(n);
	for (const f of Object.values(d.custom_field ?? {})) if (typeof f?.check === 'function') f.spec.check = true; // the write path calls an attached validate
	for (const i of Object.values(d.integration ?? {})) { const s = i?.spec ?? i; if (typeof s?.resolve === 'function') s.resolve = true; } // hook:runtime — the runner calls a declared resolve
	return JSON.stringify({ roles: d, bodies }); })()`;

async function evaluate({ source, assets }: GuestProgram): Promise<{ json: string; cpuMs: number }> {
	const isolate = new ivm.Isolate({ memoryLimit: 256 });
	try {
		const context = await isolate.createContext();
		// exactly the guest's globals (rule 6): the runtime's prelude, its log dropped and its entropy seeded
		await context.evalClosure(PRELUDE, [() => {}, randomStream('bolt:check'), digest, assetHook(assets)], { filename: 'bolt:prelude', result: { reference: true } });
		await context.eval(FREEZE);
		const module = await isolate.compileModule(source, { filename: 'guest.mjs' });
		// a node import is already a `guest/node-import` error; a `__missing` stub keeps evaluation going (rule 7)
		await module.instantiate(context, (specifier) => isolate.compileModule(missing(specifier, source)));
		const start = isolate.cpuTime;
		await module.evaluate({ timeout: 10 * EVAL_CPU_MS });
		const cpuMs = Number(isolate.cpuTime - start) / 1e6;
		await context.global.set('__ns', module.namespace.derefInto());
		return { json: await context.eval(SERIALIZE, { copy: true }) as string, cpuMs };
	} finally {
		if (!isolate.isDisposed) isolate.dispose();
	}
}

/** A module standing in for an import the isolate lacks: every binding the bundle imports from it throws when called. */
function missing(specifier: string, source: string): string {
	const names = new Set<string>();
	for (const m of source.matchAll(new RegExp(`import\\s*([^"';]*?)\\s*from\\s*["']${specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`, 'g')))
		for (const part of (/\{([^}]*)\}/.exec(m[1]!)?.[1] ?? '').split(',')) { const name = part.trim().split(/\s+as\s+/)[0]!; if (name !== '' && name !== 'default') names.add(name); }
	const stub = (n: string) => `function () { throw new Error(${JSON.stringify(`guest code cannot use ${specifier} (${n})`)}); }`;
	return [`export default ${stub('default')};`, ...[...names].map((n) => `export const ${n} = ${stub(n)};`)].join('\n');
}

async function evaluateTwice(program: GuestProgram, errors: CheckDiagnostic[]): Promise<string | undefined> {
	let runs: { json: string; cpuMs: number }[];
	try {
		runs = [await evaluate(program), await evaluate(program)];
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		errors.push(/timed out/.test(message) ? { code: 'guest/eval-cpu', path: 'guest.mjs', message: `module evaluation took over ${EVAL_CPU_MS} ms of CPU (rule 6)` }
			: { code: 'load/failed', path: 'guest.mjs', message: `evaluating the declarations failed: ${message}` });
		return undefined;
	}
	const [a, b] = runs as [{ json: string; cpuMs: number }, { json: string; cpuMs: number }];
	const hash = (s: string) => createHash('sha256').update(s).digest('hex');
	if (hash(a.json) !== hash(b.json)) errors.push({ code: 'load/nondeterministic', path: 'src', message: 'two evaluations of the declarations gave different manifests (rule 2)' });
	if (Math.max(a.cpuMs, b.cpuMs) > EVAL_CPU_MS) errors.push({ code: 'guest/eval-cpu', path: 'guest.mjs', message: `module evaluation took over ${EVAL_CPU_MS} ms of CPU (rule 6)` });
	return a.json;
}

/** `seed/**\/<collection>.json[.gz]`, one pack (discover already refused unknown collections). */
export function seedPack(root: string, errors: CheckDiagnostic[]): SeedPack { // hook:cli — exported for `bolt build`'s base pack
	const dir = join(root, 'seed'), pack: { [c: string]: RowData[] } = {};
	if (!existsSync(dir)) return pack;
	for (const d of readdirSync(dir, { recursive: true, withFileTypes: true })) {
		const path = relative(root, join(d.parentPath, d.name)).split(sep).join('/');
		const hit = /^seed\/(?:.+\/)?([^/]+)\.json(\.gz)?$/.exec(path);
		if (!d.isFile() || hit === null || path === 'seed/assets.json' || path.startsWith('seed/assets/')) continue;
		try {
			const bytes = readFileSync(join(root, path));
			const rows = JSON.parse((hit[2] ? gunzipSync(bytes) : bytes).toString('utf8')) as unknown;
			if (!Array.isArray(rows)) throw new Error('a seed file holds an array of rows');
			(pack[hit[1]!] ??= []).push(...rows as RowData[]);
		} catch (e) {
			errors.push({ code: 'seed/decode', path, message: `${path}: ${e instanceof Error ? e.message : String(e)}` });
		}
	}
	return pack;
}
