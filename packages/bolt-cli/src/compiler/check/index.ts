/// <reference types="node" />
// `bolt check` (rule 7): discover → bundle → evaluate → manifest → names → seed decode → schema → build checks, every
// error of every stage in one run (a stage whose input failed is skipped, the others still run). Its first stages are
// `bolt sync`: the names index is printed from the evaluated declarations, and an evaluation that fails keeps the last
// good one. Workspace diagnostics use the TypeScript language service; deeper audits run on request. Declarations are
// evaluated on a worker thread stripped to a guest's globals (rule 2), with a frozen clock and seeded `Math.random`, twice,
// and both manifest hashes must match; the guest program obeys rule 6's walls.
import { sha256Hex } from '@norbital-ai/store';
import { builtinModules } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Effect, FileSystem, Option, Result, Schema } from 'effect';
import { Worker } from 'node:worker_threads';
import { build, type Rolldown } from 'vite';
import { minify, type MinifyOptions } from 'terser';
import {
	decodeProjectedManifest,
	projectManifest,
	type EngineManifest,
	plan,
	decodeSeed,
	type SeedPack
} from '@norbital-ai/bolt/engine';
import { PRELUDE } from '@norbital-ai/bolt/tooling';
import { moduleScript, type ImportDeclaration } from '@norbital-ai/bolt/guest-hooks';
import type { GuestProgram } from '@norbital-ai/bolt/engine';
import type { EvaluateInput } from './evaluate-worker.ts';
import { discover, type Discovered } from '../discover.ts';
import { BOLT, EXT } from '../bolt.ts';
import { load, manifestErrors } from '../load.ts';
import { namesIndex, writeNames, writeTypeSetup } from '../names.ts';
import { seedPack } from '../seed.ts';
import { prepareMigrations } from '../migrations.ts';
import type { CheckDiagnostic } from '@norbital-ai/bolt/tooling';
export type { CheckDiagnostic } from '@norbital-ai/bolt/tooling';

export type Stage =
	'discover' | 'bundle' | 'evaluate' | 'manifest' | 'names' | 'seed' | 'schema' | 'rules';
export type CheckResult = {
	/** The stages that ran, in order (test `compiler/check-order`). */
	stages: Stage[];
	errors: CheckDiagnostic[];
	manifest?: EngineManifest;
	guest?: GuestProgram;
	/** The write callbacks the models declare, per verb: `'<model>.create'`, `'<model>.update'`, `'<model>.delete'`. */
	transforms: string[];
	seed?: SeedPack;
};

const GUEST_BYTES = 8 * 1024 * 1024,
	EVAL_CPU_MS = 100,
	// the worker's reference workload's CPU on an unloaded fast core: the speed rule 6's budget is graded at
	REFERENCE_MS = 7,
	FROZEN = Date.UTC(2000, 0, 1);
/** Bolt's root module, src or the published build (`bolt.ts`). */
const BOLT_INDEX = join(BOLT, `index${EXT}`);
const ENTRY = 'virtual:bolt-guest',
	BYTES = '?bytes',
	BYTES_ID = '\0bolt-bytes:';
// The guest edge (D8): a module under root with a generator body imports and installs it first, so `attached` wraps the
// body; a bundle without one (`blank`) carries neither the edge nor Effect.
const EDGE = `import { install as __boltEdge } from ${JSON.stringify(join(BOLT, 'decl', 'runtime', `guest${EXT}`))}; __boltEdge();`;
const SCRIPT = /\.[cm]?[jt]sx?$/,
	GENERATOR = /\bfunction\s*\*|[{,]\s*\*\s*[\w$]+\s*\(/;
const NODE = new Set([...builtinModules, ...builtinModules.map((b) => `node:${b}`)]);
export class BundleError extends Schema.TaggedError<BundleError>()('BundleError', {
	cause: Schema.Defect()
}) {}
export class EvalError extends Schema.TaggedError<EvalError>()('EvalError', {
	cause: Schema.Defect()
}) {}
const Minified = Schema.Struct({ code: Schema.String, map: Schema.String });
const Evaluated = Schema.Struct({
	roles: Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Unknown)),
	bodies: Schema.Struct({
		transforms: Schema.Array(Schema.String),
		automations: Schema.Array(Schema.String),
		models: Schema.Array(Schema.String)
	})
});

/**
 * `bolt sync`'s stages, the front of every check: discover → bundle → evaluate → manifest → names. The type setup is
 * written first (the workspace tsconfig extends it); the names index is printed from the evaluated declarations, and an
 * evaluation or a model literal that fails keeps the last good index, so no body loses its types to a broken save.
 */
const front = Effect.fn('bolt.front')(function* (
	root: string,
	stage: (s: Stage) => void,
	errors: CheckDiagnostic[],
	bolt: string | undefined,
	timing = true
) {
	stage('discover');
	const { files, errors: layout } = yield* discover(root);
	errors.push(...layout);
	yield* writeTypeSetup(root);

	stage('bundle');
	const code = files.filter((f) => f.path.endsWith('.ts'));
	const guest = yield* bundle(root, code, errors);
	if (guest === undefined) return undefined;

	stage('evaluate');
	const evaluated = yield* evaluateTwice(guest, errors, timing);
	if (evaluated === undefined) return undefined;

	stage('manifest');
	const { roles, bodies } = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Evaluated))(
		evaluated
	).pipe(Effect.mapError((cause) => new EvalError({ cause })));
	const { manifest, errors: text } = yield* load(
		root,
		files.filter((f) => !f.path.endsWith('.ts'))
	);
	errors.push(...text);
	for (const f of code) manifest[f.role][f.name] = roles[f.role]?.[f.name];
	errors.push(...manifestErrors(manifest));

	stage('names');
	const names = Result.try({
		try: () => namesIndex(files, manifest, bolt),
		catch: (cause) => (cause instanceof Error ? cause.message : String(cause))
	});
	if (Result.isSuccess(names)) yield* writeNames(root, names.success);
	else
		errors.push({
			code: 'names/failed',
			path: 'src',
			message: `the names index keeps its last good text: ${names.failure}`
		});
	return { files, code, guest, manifest, bodies };
});

/** `bolt sync`: evaluates the declarations at `root` and writes `.norbital/names.ts`; `bolt` is the module it augments. */
export const sync = Effect.fn('bolt.sync')(function* (
	dir: string,
	options: { bolt?: string } = {}
) {
	const fs = yield* FileSystem.FileSystem;
	const root = yield* fs.realPath(dir);
	const stages: Stage[] = [],
		errors: CheckDiagnostic[] = [];
	yield* front(root, (s) => stages.push(s), errors, options.bolt);
	return { stages, errors };
});

type CompilerOptions = {
	bolt?: string;
	migrations?: 'generate' | 'verify';
	squash?: string;
	/** Rule 6's evaluation CPU budget is a gate for `bolt check` and CI; a test run on a busy machine measures load, not the workspace. */
	timing?: boolean;
	/** The runtime guest's second compression pass (seconds per changed guest); a watch's rebuild ships rolldown's minified output. */
	compress?: boolean;
};
/** Shared declaration compilation; the diagnostic pass belongs to `bolt check`. */
const workspace = Effect.fn('bolt.workspace')(function* (
	dir: string,
	options: CompilerOptions,
	diagnostics: boolean
) {
	const fs = yield* FileSystem.FileSystem;
	const root = yield* fs.realPath(dir); // importers arrive resolved; relative paths need the same spelling
	const stages: Stage[] = [],
		errors: CheckDiagnostic[] = [];
	const stage = (s: Stage) => stages.push(s);
	const out: CheckResult = { stages, errors, transforms: [] };

	const evaluated = yield* front(root, stage, errors, options.bolt, options.timing ?? true);
	if (evaluated === undefined) return out;
	const { files, code, guest, manifest, bodies } = evaluated;
	out.guest = guest;
	const decoded = decodeProjectedManifest(projectManifest(manifest));
	if (Result.isFailure(decoded)) {
		errors.push({
			code: 'manifest/invalid',
			path: 'src',
			message: decoded.failure.issues.join('\n')
		});
		return out;
	}
	const m = decoded.success;
	out.manifest = m;
	out.transforms = [...bodies.transforms];

	if (diagnostics) {
		stage('seed');
		const { publicSeed } = yield* Effect.tryPromise({
			try: () => import('../artifact/seed.ts'),
			catch: (cause) => new EvalError({ cause })
		});
		const pack = yield* publicSeed(root, m, join(root, '.norbital', 'cache'), errors);
		// Identity rows are decoded by the identity area's seed path.
		if (pack !== undefined)
			out.seed = Object.fromEntries(Object.entries(pack).filter(([c]) => !c.startsWith('sys_')));
		// the test pack (`seed/test/`) decodes against the same manifest; it is never provisioned
		const test = Object.fromEntries(
			Object.entries(yield* seedPack(root, errors, 'test')).filter(([c]) => !c.startsWith('sys_'))
		);
		const decodedTest = Result.try({
			try: () => decodeSeed(m, test),
			catch: (cause) => new EvalError({ cause })
		});
		if (Result.isFailure(decodedTest))
			errors.push({
				code: 'seed/decode',
				path: 'seed/test',
				message:
					decodedTest.failure.cause instanceof Error
						? decodedTest.failure.cause.message
						: String(decodedTest.failure.cause)
			});
	}

	stage('schema');
	const planned = yield* Effect.result(plan(null, m));
	if (Result.isFailure(planned)) {
		const e = planned.failure;
		errors.push({ code: `schema/${e.code}`, path: 'src/data', message: e.message });
	} else {
		const migrations = yield* Effect.result(
			prepareMigrations(root, m, options.migrations ?? 'verify', {
				...(options.squash === undefined ? {} : { squash: options.squash })
			})
		);
		if (Result.isFailure(migrations)) {
			const error = migrations.failure;
			errors.push({
				code: 'schema/migrations',
				path: 'migrations',
				message: error instanceof Error ? error.message : String(error)
			});
		}
	}

	if (diagnostics) {
		stage('rules');
		const { checkRules, sourceRules } = yield* Effect.tryPromise({
			try: () => import('./rules.ts'),
			catch: (cause) => new EvalError({ cause })
		});
		const where = (role: string, name: string) =>
			files.find((f) => f.role === role && f.name === name)?.path ?? `src (${role} ${name})`;
		errors.push(...checkRules(m, bodies, where));
		const models = files.filter((f) => f.role === 'model');
		const sources = yield* Effect.forEach(models, (f) =>
			fs.readFileString(join(root, f.path)).pipe(Effect.map((text) => ({ path: f.path, text })))
		);
		errors.push(...sourceRules(m, sources));
	}
	if (errors.length === 0) {
		const runtime = yield* bundle(
			root,
			code,
			errors,
			true,
			bodies.models,
			options.compress ?? true
		);
		if (runtime !== undefined) out.guest = runtime;
	}
	return out;
});

/** Checks the workspace at `root`; `bolt` is the module specifier the names index augments. */
export const check = (dir: string, options: CompilerOptions = {}) => workspace(dir, options, true);
/** Compiles the artifact inputs and migrations without running the authoring diagnostics. */
export const compile = (dir: string, options: CompilerOptions = {}) =>
	workspace(dir, options, false);

/**
 * A policy's guest part: each write grant's `check` (`policy.<p>.grants.<model>.<op>.check`), a ctx-bearing generator
 * called with its batch and a `PolicyCtx` (invocation kind `policy`), answering the data of the `Verdict` it returns.
 */
const CHECKS = `import { attached as __attached } from ${JSON.stringify(join(BOLT, 'decl', `body${EXT}`))};
const __checks = (p) => ({ grants: Object.fromEntries(Object.entries(p?.grants ?? {}).map(([model, g]) => [model, Object.fromEntries(['create', 'update', 'delete'].flatMap((op) => typeof g?.[op]?.check === 'function' ? [[op, { check: __attached(g[op].check, 1) }]] : []))])) });`;
/**
 * The callback paths selected by the runner (the Guest ABI), retaining every role module's original initialization order:
 * a model's bodies under `model.<model>.bodies`, a policy's write checks, an automation's `body`, a custom
 * field's `check`, an integration's `bodies.test` and a page server's loader.
 */
function runtimeEntry(
	root: string,
	code: readonly Discovered[],
	models: readonly string[]
): string {
	const groups = new Map<string, string[]>();
	const callbackModels = new Set(models);
	const imports = code.map((file, index) => {
		const binding = `r${index}`;
		let group: string = file.role,
			value: string | undefined;
		switch (file.role) {
			case 'model':
				group = 'model';
				if (callbackModels.has(file.name)) value = `{ bodies: ${binding}.bodies }`;
				break;
			case 'policy':
				value = `__checks(${binding})`;
				break;
			case 'automation':
				value = `{ body: ${binding}.body }`;
				break;
			case 'custom_field':
				value = `{ check: ${binding}.check }`;
				break;
			case 'integration_definition':
				value = `{ bodies: ${binding}.bodies }`;
				break;
			case 'page_server':
			case 'kiosk_page_server':
				value = `{ data: ${binding}.data, load: ${binding}.load }`;
				break;
		}
		const path = JSON.stringify(join(root, file.path));
		if (value === undefined) return `import ${path};`;
		const entries = groups.get(group) ?? [];
		entries.push(`${JSON.stringify(file.name)}: ${value}`);
		groups.set(group, entries);
		return `import ${binding} from ${path};`;
	});
	return [
		...imports,
		...(groups.has('policy') ? [CHECKS] : []),
		`export default { ${[...groups].map(([group, entries]) => `${group}: { ${entries.join(', ')} }`).join(', ')} };`
	].join('\n');
}

/** Native ES modules for full declaration evaluation or the runner's callback projection, with rule 6's import walls. */
const bundle = Effect.fn('bolt.bundle')(function* (
	root: string,
	code: readonly Discovered[],
	errors: CheckDiagnostic[],
	runtime: boolean = false,
	models: readonly string[] = [],
	compress = false
) {
	const fs = yield* FileSystem.FileSystem;
	const byRole = Map.groupBy(code, (f) => f.role);
	const servers = code.filter((f) => f.role === 'page_server' || f.role === 'kiosk_page_server');
	const entry = runtime
		? runtimeEntry(root, code, models)
		: [
				...(servers.length > 0
					? [
							`export { pageServerMetadata as __pageServerMetadata } from ${JSON.stringify(join(BOLT, 'decl', 'runtime', `page${EXT}`))};`,
							...servers.map(
								(f, i) =>
									`import p${i} from ${JSON.stringify(join(root, dirname(f.path), `${f.name.slice(f.name.lastIndexOf('/') + 1)}.page.data.ts`))};`
							),
							`export const __pageDataCodecs = { ${[...Map.groupBy(servers, (f) => f.role)].map(([role, files]) => `${role}: { ${files.map((f) => `${JSON.stringify(f.name)}: p${servers.indexOf(f)}`).join(', ')} }`).join(', ')} };`
						]
					: []),
				...code.map((f, i) => `import r${i} from ${JSON.stringify(join(root, f.path))};`),
				`export default { ${[...byRole].map(([role, fs]) => `${role}: { ${fs.map((f) => `${JSON.stringify(f.name)}: r${code.indexOf(f)}`).join(', ')} }`).join(', ')} };`
			].join('\n');

	const assets: Record<string, Uint8Array> = {};
	const bundled = yield* Effect.tryPromise({
		try: (signal) =>
			build({
				configFile: false,
				logLevel: 'silent',
				root,
				resolve: { alias: [{ find: /^@norbital-ai\/bolt$/, replacement: BOLT_INDEX }] },
				plugins: [
					{
						name: 'bolt:guest',
						enforce: 'pre',
						// repository-health:allow EFF3 -- Vite resolves through its Promise plugin ABI.
						async resolveId(id, importer) {
							if (id === ENTRY) return `\0${ENTRY}`;
							// §5.8: `import bytes from './x.wasm?bytes'` is the file's bytes, a server-only asset of the artifact
							if (id.endsWith(BYTES)) {
								// repository-health:allow EFF3 -- Vite's resolver returns a Promise.
								const file = await this.resolve(id.slice(0, -BYTES.length), importer, {
									skipSelf: true
								});
								return file === null ? null : `${BYTES_ID}${file.id}`;
							}
							if (!NODE.has(id) || importer?.startsWith('\0') === true) return null;
							const from =
								importer === undefined ? 'src' : relative(root, importer).split(sep).join('/');
							errors.push({
								code: 'guest/node-import',
								path: from,
								message: `${from}: imports '${id}'; guest code runs in the isolate, which has no node modules (rule 6)`
							});
							return { id, external: true };
						},
						transform(source, id) {
							const path = relative(root, id);
							if (
								id.startsWith('\0') ||
								path.startsWith('..') ||
								path.split(sep).includes('node_modules') ||
								!SCRIPT.test(id) ||
								!GENERATOR.test(source)
							)
								return null;
							return { code: `${EDGE}${source}`, map: null }; // one line: only line 1's columns move
						},
						load(id) {
							if (id === `\0${ENTRY}`) return entry;
							if (!id.startsWith(BYTES_ID)) return null;
							// Vite owns this Promise hook; the enclosing bundle Effect supplies cancellation and captures failures.
							return readFile(id.slice(BYTES_ID.length), { signal }).then((bytes) => {
								const sha = sha256Hex(bytes);
								assets[sha] = bytes;
								// ponytail: every invocation copies the bytes in at module evaluation; lazy access when an asset is large
								return `export default globalThis[Symbol.for('norbital.bolt.asset')](${JSON.stringify(sha)});`;
							});
						}
					}
				],
				build: {
					write: false,
					minify: 'oxc',
					sourcemap: true,
					rolldownOptions: {
						input: ENTRY,
						preserveEntrySignatures: 'strict',
						optimization: { pifeForModuleWrappers: runtime },
						output: {
							format: 'es',
							entryFileNames: 'guest.mjs',
							codeSplitting: false,
							strictExecutionOrder: true,
							// Compact bindings reduce isolate startup CPU; preserve names for runtime diagnostics and reflection.
							minify: {
								compress: { keepNames: { function: true, class: true } },
								mangle: { toplevel: true, keepNames: { function: true, class: true } },
								codegen: { removeWhitespace: true, legalComments: 'inline' }
							},
							comments: { legal: true }
						}
					}
				}
			}),
		catch: (cause) => new BundleError({ cause })
	}).pipe(
		Effect.map((output) => (Array.isArray(output) ? output[0] : output)),
		Effect.result
	);
	if (Result.isFailure(bundled)) {
		const e = bundled.failure.cause;
		errors.push({
			code: 'bundle/failed',
			path: 'src',
			message: e instanceof Error ? e.message : String(e)
		});
		return undefined;
	}
	const result = bundled.success;
	if (result === undefined || 'close' in result)
		return yield* Effect.fail(
			new BundleError({ cause: new Error('the bundler returned no output') })
		);
	const chunk = result.output.find((o): o is Rolldown.OutputChunk => o.type === 'chunk');
	if (chunk === undefined)
		return yield* Effect.fail(
			new BundleError({ cause: new Error('the bundler emitted no guest chunk') })
		);
	let source = chunk.code;
	let sourceMap = chunk.map?.toString();
	if (runtime && compress) {
		// Compress the native output with its map; declaration validation and module ordering stay upstream.
		const inputMap = chunk.map?.toString();
		const options: MinifyOptions = {
			module: true,
			keep_fnames: true,
			keep_classnames: true,
			compress: { passes: 2, keep_fargs: true, pure_getters: false },
			mangle: { toplevel: true },
			format: { comments: 'some', wrap_func_args: true },
			sourceMap: {
				// A metadata-only runtime has no mapped source modules.
				...(inputMap === undefined ? {} : { content: inputMap }),
				filename: 'guest.mjs',
				url: 'guest.mjs.map'
			}
		};
		// Terser is deterministic and costs seconds per check: its output is reused by content (input, map and options).
		const dir = join(root, '.norbital', 'cache', 'guest');
		const file = join(dir, `${sha256Hex(JSON.stringify([chunk.code, options]))}.json`);
		const cached = yield* fs
			.readFileString(file)
			.pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Minified))),
				Effect.option
			);
		let compact: typeof Minified.Type;
		if (Option.isSome(cached)) compact = cached.value;
		else {
			const output = yield* Effect.tryPromise({
				try: () => minify(chunk.code, options),
				catch: (cause) => new BundleError({ cause })
			});
			if (output.code === undefined || typeof output.map !== 'string')
				return yield* new BundleError({
					cause: new Error('the minifier emitted no guest code or map')
				});
			compact = { code: output.code, map: output.map };
			// A rename publishes the whole entry; a concurrent check writes the same bytes.
			const temporary = `${file}.${process.pid}`;
			yield* fs.makeDirectory(dir, { recursive: true });
			yield* fs.writeFileString(temporary, JSON.stringify(compact));
			yield* fs.rename(temporary, file);
		}
		source = compact.code;
		sourceMap = compact.map;
	}
	if (Buffer.byteLength(source) > GUEST_BYTES)
		errors.push({
			code: 'guest/size',
			path: 'guest.mjs',
			message: `guest.mjs is over 8 MiB (rule 6)`
		});
	return {
		source,
		...(sourceMap === undefined ? {} : { sourceMap }),
		...(Object.keys(assets).length > 0 ? { assets } : {})
	};
});

// Rule 2's evaluation context: a frozen clock and a seeded `Math.random` (mulberry32), installed before the module runs.
const FREEZE = `{ const T = ${FROZEN}, D = Date;
	globalThis.Date = class extends D { constructor(...a) { if (a.length === 0) super(T); else super(...a); } static now() { return T; } };
	let s = 0x2545f491; Math.random = () => { s = s + 0x6d2b79f5 | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }`;
// Declarations are data (functions drop out of JSON). A model's bodies become `true` markers in its literal (`splitModel`
// reads them) and a policy's write checks `check: true`; which write callbacks and automation bodies exist is
// read beside them. A ctx-bearing body must be a generator.
const SERIALIZE = `(() => { const d = globalThis.__ns.default, bodies = { transforms: [], automations: [], models: [] };
	const generator = (body) => {
		if (typeof body !== 'function') return;
		const original = body[Symbol.for('norbital.bolt.generator')] ?? body;
		if (Object.prototype.toString.call(original) !== '[object GeneratorFunction]') throw new Error('a ctx-bearing body must be a generator function');
	};
	const mark = (o) => { for (const [k, v] of Object.entries(o ?? {})) if (typeof v === 'function') o[k] = true; else if (v !== null && typeof v === 'object') mark(v); };
	const hasBody = (o) => typeof o === 'function' || o !== null && typeof o === 'object' && Object.values(o).some(hasBody);
	for (const [n, m] of Object.entries(d.model ?? {})) {
		if (Object.hasOwn(m?.spec ?? {}, 'actions')) throw new Error('model ' + JSON.stringify(n) + ' cannot declare named actions');
		const b = m?.bodies ?? {};
		if (hasBody(b)) bodies.models.push(n);
		if (Object.hasOwn(m?.spec ?? {}, 'queries')) throw new Error('model ' + JSON.stringify(n) + ' cannot declare queries: read layers, then transform them in src/lib');
		for (const body of [b.create, b.update, b.delete, b.notify, ...Object.values(b.effect ?? {})]) generator(body);
		for (const s of Object.values(b.syncs ?? {})) { generator(s?.read); generator(s?.write); for (const p of Object.values(s?.parse ?? {})) generator(p); }
		for (const verb of ['create', 'update', 'delete']) if (typeof b[verb] === 'function') bodies.transforms.push(n + '.' + verb);
		mark(m?.spec);
		d.model[n] = { name: m?.name, spec: m?.spec };
	}
	for (const [n, a] of Object.entries(d.automation ?? {})) { generator(a?.body); if (typeof a?.body === 'function') bodies.automations.push(n); }
	for (const i of Object.values(d.integration_definition ?? {})) { generator(i?.bodies?.test); if (typeof i?.spec?.test === 'function') i.spec.test = true; }
	for (const f of Object.values(d.custom_field ?? {})) if (typeof f?.check === 'function' && f.spec) f.spec.check = true; // the write path calls the guest's validate
	for (const p of Object.values(d.policy ?? {})) for (const g of Object.values(p?.grants ?? {})) for (const op of ['create', 'update', 'delete']) if (typeof g?.[op]?.check === 'function') { generator(g[op].check); g[op].check = true; }
	for (const role of ['page_server', 'kiosk_page_server']) for (const [name, definition] of Object.entries(d[role] ?? {})) {
		generator(definition?.load);
		d[role][name] = globalThis.__ns.__pageServerMetadata(definition, globalThis.__ns.__pageDataCodecs[role]?.[name]);
	}
	return JSON.stringify({ roles: d, bodies }); })()`;

/** The worker's one answer: the declarations' JSON, the module's CPU and its reference workload's, or why evaluating it failed. */
export const EvaluateOutput = Schema.Union([
	Schema.Struct({ json: Schema.String, cpuMs: Schema.Number, referenceMs: Schema.Number }),
	Schema.Struct({ error: Schema.String })
]);
// src or the published build, as this module
const WORKER = join(
	dirname(fileURLToPath(import.meta.url)),
	`evaluate-worker${extname(fileURLToPath(import.meta.url))}`
);
/**
 * A module's evaluation CPU at reference speed: a thread that ran its reference workload slower than `REFERENCE_MS`
 * (a busy machine's slower core or contended cache) ran the module slower alike. A faster thread is taken as measured.
 */
export const evaluationCpuMs = (cpuMs: number, referenceMs: number): number =>
	cpuMs * Math.min(1, REFERENCE_MS / referenceMs);
// One evaluation on its own worker thread. The runaway guard reads the worker thread's own CPU, never wall time: a busy
// machine stretches wall time without the module doing more work.
const evaluate = (script: string, assets: GuestProgram['assets']) =>
	Effect.callback<{ json: string; cpuMs: number; referenceMs: number }, EvalError>((resume) => {
		const input: EvaluateInput = {
			prelude: PRELUDE,
			freeze: FREEZE,
			script,
			serialize: SERIALIZE,
			...(assets === undefined ? {} : { assets })
		};
		const worker = new Worker(WORKER, { workerData: input, stdout: true, stderr: true });
		const fail = (message: string) =>
			resume(Effect.fail(new EvalError({ cause: new Error(message) })));
		const guard = setInterval(() => {
			worker.cpuUsage().then(
				(used) => {
					if ((used.user + used.system) / 1000 <= 100 * EVAL_CPU_MS) return;
					clearInterval(guard);
					fail('module evaluation timed out');
					void worker.terminate();
				},
				() => {} // the worker already ended; its message or error answers
			);
		}, 250);
		worker.once('message', (message: unknown) => {
			clearInterval(guard);
			void worker.terminate();
			const output = Schema.decodeUnknownOption(EvaluateOutput)(message);
			if (Option.isNone(output)) fail('the evaluation answered nothing readable');
			else if ('error' in output.value) fail(output.value.error);
			else resume(Effect.succeed(output.value));
		});
		worker.once('error', (error: Error) => {
			clearInterval(guard);
			fail(error.message);
		});
		return Effect.sync(() => {
			clearInterval(guard);
			void worker.terminate();
		});
	});

/** An import the guest lacks: every binding the bundle imports from it throws when called. */
const missing = (node: ImportDeclaration): string => {
	const specifier = node.source.value;
	const stub = (n: string) =>
		`function () { throw new Error(${JSON.stringify(`guest code cannot use ${specifier} (${n})`)}); }`;
	return node.specifiers.length === 0
		? ''
		: `const ${node.specifiers
				.map(
					(s) =>
						`${s.local.name} = ${stub(
							s.type === 'ImportSpecifier'
								? s.imported.type === 'Literal'
									? s.imported.value
									: s.imported.name
								: s.type === 'ImportDefaultSpecifier'
									? 'default'
									: '*'
						)}`
				)
				.join(', ')};`;
};

const evaluateTwice = Effect.fn('bolt.evaluateTwice')(function* (
	program: GuestProgram,
	errors: CheckDiagnostic[],
	timing: boolean
) {
	const runs = yield* Effect.try({
		try: () => moduleScript(program.source, missing),
		catch: (cause) =>
			new EvalError({ cause: cause instanceof Error ? cause : new Error(String(cause)) })
	}).pipe(
		Effect.flatMap((script) =>
			Effect.all([evaluate(script, program.assets), evaluate(script, program.assets)], {
				concurrency: 1
			})
		),
		Effect.result
	);
	if (Result.isFailure(runs)) {
		const e = runs.failure.cause;
		const message = e instanceof Error ? e.message : String(e);
		errors.push(
			/ctx-bearing body must be a generator function/.test(message)
				? {
						code: 'guest/body-generator',
						path: 'src',
						message: 'a ctx-bearing body must be a generator function'
					}
				: /timed out/.test(message)
					? {
							code: 'guest/eval-cpu',
							path: 'guest.mjs',
							message: `module evaluation took over ${EVAL_CPU_MS} ms of CPU (rule 6)`
						}
					: {
							code: 'load/failed',
							path: 'guest.mjs',
							message: `evaluating the declarations failed: ${message}`
						}
		);
		return undefined;
	}
	const [a, b] = runs.success;
	if (a === undefined || b === undefined)
		return yield* Effect.fail(
			new EvalError({ cause: new Error('missing deterministic evaluation') })
		);
	if (sha256Hex(a.json) !== sha256Hex(b.json))
		errors.push({
			code: 'load/nondeterministic',
			path: 'src',
			message: 'two evaluations of the declarations gave different manifests (rule 2)'
		});
	// the cheaper of the two runs at reference speed: a busy machine only ever adds CPU time, never removes it
	if (
		timing &&
		Math.min(evaluationCpuMs(a.cpuMs, a.referenceMs), evaluationCpuMs(b.cpuMs, b.referenceMs)) >
			EVAL_CPU_MS
	)
		errors.push({
			code: 'guest/eval-cpu',
			path: 'guest.mjs',
			message: `module evaluation took over ${EVAL_CPU_MS} ms of CPU (rule 6)`
		});
	return a.json;
});
